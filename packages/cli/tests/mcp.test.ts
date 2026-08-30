// tests/mcp.test.ts — the MCP tool surface (spec §4.1, M6 Step 15).
//
// The handlers are called directly rather than over a spawned stdio pipe: the
// interesting behaviour is the text the agent reads and what ends up on disk,
// and a subprocess would hide both behind a transport. Live stdio is the
// integration agent's ground to cover.
//
// Every test works in its own temp .diagram/ directory. Nothing here may touch
// the repository's own .diagram/.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDoc, type GraphPatch } from '../../core/src/index.js';
import { createContext, type DiagramContext } from '../src/commands/context.js';
import { TOOLS, TOOL_NAMES, callTool, findTool } from '../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS, createMcpServer } from '../src/mcp/server.js';
import { runPatchText } from '../src/commands/patch.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

function tempContext(): DiagramContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-mcp-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return createContext({ dir: path.join(root, '.diagram') });
}

const addApi = {
  op: 'addNode' as const,
  node: { id: 'api', label: 'API', type: 'service' as const, parent: null },
};
const addDb = {
  op: 'addNode' as const,
  node: { id: 'db', label: 'Postgres', type: 'database' as const, parent: null },
};
const addVpc = {
  op: 'addGroup' as const,
  group: { id: 'vpc', label: 'VPC', kind: 'vpc' as const, parent: null },
};

function patch(ops: GraphPatch['ops'], summary = 'test'): Record<string, unknown> {
  return { ops, summary };
}

/** A context holding a small but real diagram: two nodes in a vpc, one edge. */
async function seeded(): Promise<DiagramContext> {
  const ctx = tempContext();
  const result = await callTool(
    'diagram_patch',
    patch(
      [
        addVpc,
        { ...addApi, node: { ...addApi.node, parent: 'vpc' } },
        { ...addDb, node: { ...addDb.node, parent: 'vpc' } },
        {
          op: 'addEdge',
          edge: { id: 'e1', from: 'api', to: 'db', label: 'reads', style: 'solid' },
        },
      ],
      'seed',
    ),
    ctx,
  );
  expect(result.ok).toBe(true);
  return ctx;
}

function currentDoc(ctx: DiagramContext) {
  const read = readDoc(ctx.paths.graphFile);
  if (!read.ok) throw new Error(read.errors.join('; '));
  return read.doc;
}

// ---------------------------------------------------------------------------

describe('the tool set', () => {
  it('advertises exactly the tools of spec §4.1 and §15.4', async () => {
    expect(TOOL_NAMES).toEqual([
      'diagram_get',
      'diagram_patch',
      'diagram_undo',
      'diagram_redo',
      'diagram_view',
      'diagram_export',
      'diagram_analyse',
      'diagram_blast_radius',
      'diagram_check',
      'diagram_reset',
    ]);
  });

  it('gives every tool an object input schema', async () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema['type'], tool.name).toBe('object');
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
    }
  });

  it('refuses an unknown tool name readably', async () => {
    const result = await callTool('diagram_delete_everything', {}, tempContext());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown tool "diagram_delete_everything"');
    expect(result.text).toContain('diagram_patch');
  });
});

describe('diagram_patch description — the prompt', () => {
  const description = findTool('diagram_patch')!.description;

  it('carries the authoring rules, not just a blurb', async () => {
    expect(description).toContain('CALL diagram_get FIRST');
    expect(description).toContain('lowercase-hyphenated');
    expect(description).toContain('MINIMAL OPS');
    expect(description).toContain('EDGE DIRECTION');
  });

  it('points at ERD mode without inlining it', async () => {
    expect(description).toContain('diagram rules --erd');
  });

  it('tells the agent a rejection is readable and safe', async () => {
    expect(description).toContain('atomically');
    expect(description).toContain('NOTHING is applied');
  });

  it('takes its patch input schema from core, not a hand-written copy', async () => {
    const schema = findTool('diagram_patch')!.inputSchema;
    expect(schema['type']).toBe('object');
    const props = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(['ops', 'summary']);
    // The generated schema knows about the ERD additions because the zod
    // source does — a hand-written duplicate would not.
    expect(JSON.stringify(schema)).toContain('cardinality');
  });
});

describe('diagram_get', () => {
  it('returns the compact table, not JSON', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_get', {}, ctx);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('### Nodes (id | type | label | parent)');
    expect(result.text).toContain('api');
    expect(result.text).toContain('api -> db');
    expect(result.text.startsWith('{')).toBe(false);
  });

  it('says so when the diagram is empty instead of printing three blank sections', async () => {
    const result = await callTool('diagram_get', {}, tempContext());
    expect(result.ok).toBe(true);
    expect(result.text).toContain('(empty diagram');
    expect(result.text).toContain('no document yet at');
  });

  it('reports a broken graph.json rather than throwing', async () => {
    const ctx = tempContext();
    fs.mkdirSync(ctx.dir, { recursive: true });
    fs.writeFileSync(ctx.paths.graphFile, '{ not json', 'utf8');
    const result = await callTool('diagram_get', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('cannot read');
  });
});

describe('diagram_patch', () => {
  it('applies a patch and returns the terse ok shape', async () => {
    const ctx = tempContext();
    const result = await callTool('diagram_patch', patch([addApi, addDb], 'two nodes'), ctx);
    expect(result.ok).toBe(true);
    const [first, second] = result.text.split('\n');
    expect(first).toMatch(/^ok — /);
    expect(second).toBe('graph: 2 nodes, 0 groups, 0 edges');
    expect(currentDoc(ctx).nodes.map((n) => n.id)).toEqual(['api', 'db']);
  });

  it('seeds .diagram/ on the first patch in a fresh project', async () => {
    const ctx = tempContext();
    expect(fs.existsSync(ctx.paths.graphFile)).toBe(false);
    await callTool('diagram_patch', patch([addApi]), ctx);
    expect(fs.existsSync(ctx.paths.graphFile)).toBe(true);
  });

  it('refuses a corrupt graph.json instead of overwriting it (spec §4.3, path C)', async () => {
    // The blocker this test exists for: diagram_patch used to call ensureDoc(),
    // which treated "unreadable" the same as "nothing here yet" and wrote the
    // EMPTY document over a hand-edited file — before the lock and before the
    // history seed, so snapshot 0000 was already empty and undo could not bring
    // the work back. Unrecoverable data loss, reported as `ok`.
    for (const corrupt of [
      '{ "nodes": [ BROKEN',
      JSON.stringify({
        schemaVersion: 1,
        title: 'Checkout platform',
        direction: 'DOWN',
        nodes: [{ id: 'api', type: 'servcie', label: 'Checkout API', parent: null }],
        groups: [],
        edges: [],
        collapsed: [],
      }),
    ]) {
      const ctx = tempContext();
      fs.mkdirSync(ctx.dir, { recursive: true });
      fs.writeFileSync(ctx.paths.graphFile, corrupt, 'utf8');
      const before = fs.readFileSync(ctx.paths.graphFile);

      const result = await callTool('diagram_patch', patch([addApi], 'add api'), ctx);

      expect(result.ok).toBe(false);
      expect(fs.readFileSync(ctx.paths.graphFile).equals(before)).toBe(true);
      expect(fs.existsSync(ctx.paths.historyDir)).toBe(false);
      // And it says exactly what `diagram patch` says — the CLI twin was
      // always correct here, which is what made this a surface divergence.
      const viaCli = runPatchText(JSON.stringify(patch([addApi], 'add api')), 'stdin', {
        dir: ctx.dir,
      });
      expect(result.text).toBe(viaCli.text);
    }
  });

  it('returns errors as a normal result and leaves graph.json untouched', async () => {
    const ctx = await seeded();
    const before = fs.readFileSync(ctx.paths.graphFile, 'utf8');

    const result = await callTool(
      'diagram_patch',
      patch(
        [
          addApi, // duplicate id — coerced, not fatal
          {
            op: 'addEdge',
            edge: { id: 'e9', from: 'api', to: 'redis', style: 'solid' },
          },
        ],
        'bad edge',
      ),
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.text.split('\n')[0]).toBe('rejected — no changes applied');
    expect(result.text).toContain('redis');
    // The whole point of atomic application: nothing moved.
    expect(fs.readFileSync(ctx.paths.graphFile, 'utf8')).toBe(before);
  });

  it('rejects a malformed patch in the same voice as an invalid one', async () => {
    const ctx = await seeded();
    const before = fs.readFileSync(ctx.paths.graphFile, 'utf8');
    const result = await callTool(
      'diagram_patch',
      { ops: [{ op: 'teleportNode', id: 'api' }], summary: 'nonsense' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.text.split('\n')[0]).toBe('rejected — no changes applied');
    expect(fs.readFileSync(ctx.paths.graphFile, 'utf8')).toBe(before);
  });

  it('rejects a patch with no ops field at all', async () => {
    const result = await callTool('diagram_patch', {}, tempContext());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('ops');
  });
});

describe('diagram_undo / diagram_redo', () => {
  it('steps back and forward through history', async () => {
    const ctx = tempContext();
    await callTool('diagram_patch', patch([addApi], 'one'), ctx);
    await callTool('diagram_patch', patch([addDb], 'two'), ctx);
    expect(currentDoc(ctx).nodes).toHaveLength(2);

    const undo = await callTool('diagram_undo', {}, ctx);
    expect(undo.ok).toBe(true);
    expect(undo.text).toContain('ok — undo');
    expect(undo.text).toContain('graph: 1 node, 0 groups, 0 edges');
    expect(currentDoc(ctx).nodes).toHaveLength(1);

    const redo = await callTool('diagram_redo', {}, ctx);
    expect(redo.ok).toBe(true);
    expect(redo.text).toContain('ok — redo');
    expect(currentDoc(ctx).nodes).toHaveLength(2);
  });

  it('says there is nothing to undo instead of failing at the protocol level', async () => {
    const result = await callTool('diagram_undo', {}, tempContext());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('nothing to undo');
  });
});

describe('diagram_view', () => {
  it('resolves the exec preset to the top-level groups', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_view', { preset: 'exec' }, ctx);
    expect(result.ok).toBe(true);
    // The same three lines `diagram view exec` prints — the tool and the CLI
    // run one body, so this pins that they cannot drift apart.
    expect(result.text).toBe(
      [
        'ok — view exec',
        'collapsed: vpc (1 of 1 group)',
        'graph: 2 nodes, 1 group, 1 edge',
      ].join(
        '\n',
      ),
    );
    expect(currentDoc(ctx).collapsed).toEqual(['vpc']);
  });

  it('expands everything for eng', async () => {
    const ctx = await seeded();
    await callTool('diagram_view', { preset: 'exec' }, ctx);
    const result = await callTool('diagram_view', { preset: 'eng' }, ctx);
    expect(result.text.split('\n').slice(0, 2)).toEqual([
      'ok — view eng',
      'collapsed: none — every group open',
    ]);
    expect(currentDoc(ctx).collapsed).toEqual([]);
  });

  it('accepts an explicit collapsed list', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_view', { collapsed: ['vpc', 'vpc'] }, ctx);
    expect(result.ok).toBe(true);
    expect(currentDoc(ctx).collapsed).toEqual(['vpc']);
  });

  it('refuses an unknown group id and changes nothing', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_view', { collapsed: ['nope'] }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown group "nope"');
    expect(currentDoc(ctx).collapsed).toEqual([]);
  });

  it('refuses focus without an id, and an unknown focus id', async () => {
    const ctx = await seeded();
    expect((await callTool('diagram_view', { preset: 'focus' }, ctx)).ok).toBe(false);
    const unknown = await callTool('diagram_view', { preset: 'focus', id: 'ghost' }, ctx);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain('ghost');
  });

  it('refuses a call with neither a preset nor a list', async () => {
    const result = await callTool('diagram_view', {}, await seeded());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('preset');
  });

  it('is undoable, because it goes through history', async () => {
    const ctx = await seeded();
    await callTool('diagram_view', { preset: 'exec' }, ctx);
    await callTool('diagram_undo', {}, ctx);
    expect(currentDoc(ctx).collapsed).toEqual([]);
  });
});

describe('diagram_export', () => {
  it('writes json to the given path and returns it', async () => {
    const ctx = await seeded();
    const target = path.join(ctx.dir, 'nested', 'arch.json');
    const result = await callTool('diagram_export', { format: 'json', path: target }, ctx);
    expect(result.ok).toBe(true);
    expect(result.text).toContain(`wrote: ${target}`);
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as { nodes: unknown[] };
    expect(written.nodes).toHaveLength(2);
  });

  it('defaults to <.diagram>/out.json, the same default as `diagram export`', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_export', { format: 'json' }, ctx);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(ctx.dir, 'out.json'))).toBe(true);
  });

  it('writes a real svg through the one dispatcher, honouring the view', async () => {
    // No stub: this is the same static binding the binary uses. It proves
    // the MCP surface can actually produce the file its schema advertises —
    // the thing that was broken while dispatch was synchronous.
    const ctx = await seeded();
    const target = path.join(ctx.dir, 'a.svg');
    expect((await callTool('diagram_view', { collapsed: ['vpc'] }, ctx)).ok).toBe(true);

    const result = await callTool('diagram_export', { format: 'svg', path: target }, ctx);
    expect(result.ok).toBe(true);
    const svg = fs.readFileSync(target, 'utf8');
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // The collapsed view, not the engineering one: api and db are behind
    // the vpc stand-in, exactly as `diagram_view` asked for.
    expect(svg).toContain('data-node="vpc"');
    expect(svg).not.toContain('data-node="api"');
    expect(result.text).toContain(`wrote: ${target}`);
    expect(result.text).toContain('view: collapsed vpc');
  });

  it('rejects a non-boolean full rather than guessing what it meant', async () => {
    const result = await callTool('diagram_export', { format: 'svg', full: 'yes' }, await seeded());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('full must be a boolean');
  });

  it('points png at the viewer instead of writing an unopenable file', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_export', { format: 'png', path: path.join(ctx.dir, 'a.png') }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('diagram serve');
    expect(fs.existsSync(path.join(ctx.dir, 'a.png'))).toBe(false);
  });

  it('refuses an unknown format', async () => {
    const result = await callTool('diagram_export', { format: 'pdf' }, await seeded());
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown export format');
  });
});

describe('diagram_reset', () => {
  it('refuses without confirm: true and leaves the document alone', async () => {
    const ctx = await seeded();
    const before = fs.readFileSync(ctx.paths.graphFile, 'utf8');

    for (const args of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
      const result = await callTool('diagram_reset', args, ctx);
      expect(result.ok, JSON.stringify(args)).toBe(false);
      expect(result.text).toContain('confirm: true');
    }
    expect(fs.readFileSync(ctx.paths.graphFile, 'utf8')).toBe(before);
  });

  it('clears the document with confirm: true, and undo brings it back', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_reset', { confirm: true }, ctx);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('graph: 0 nodes, 0 groups, 0 edges');
    expect(currentDoc(ctx).nodes).toEqual([]);

    await callTool('diagram_undo', {}, ctx);
    expect(currentDoc(ctx).nodes).toHaveLength(2);
  });
});

describe('createMcpServer', () => {
  it('builds a server without touching stdio', async () => {
    const server = createMcpServer({ dir: tempContext().dir });
    expect(server).toBeDefined();
    expect(SERVER_INSTRUCTIONS).toContain('diagram_get');
  });
});

// ---------------------------------------------------------------------------
// The dispatcher keeps the contract list_tools advertises
// ---------------------------------------------------------------------------
//
// Every schema here says `additionalProperties: false` and nothing enforced
// it: a handler read the keys it knew and dropped the rest. The concrete
// failure was diagram_export, the one tool that writes an arbitrary path —
// `{"format":"svg","out":"arch.svg"}` (the CLI's flag name) answered
// `ok — exported svg` and wrote to the DEFAULT location, so the agent's next
// step failed several turns later naming the wrong cause.

describe('unknown tool arguments are refused, not ignored', () => {
  it('refuses diagram_export {"out": ...} and names the property it wanted', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_export', { format: 'svg', out: 'mcp.svg' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown argument "out" for diagram_export');
    expect(result.text).toContain('did you mean "path"?');
    expect(result.text).toContain('accepted: format, path, full');
    // And no file was written anywhere.
    expect(fs.existsSync(ctx.paths.svgFile)).toBe(false);
    expect(fs.existsSync(path.resolve('mcp.svg'))).toBe(false);
  });

  it('refuses a stray key on every tool with a hand-written schema', async () => {
    const ctx = await seeded();
    for (const name of ['diagram_get', 'diagram_view', 'diagram_reset', 'diagram_undo']) {
      const result = await callTool(name, { bogusArg: 1 }, ctx);
      expect(result.ok, name).toBe(false);
      expect(result.text, name).toContain(`unknown argument "bogusArg" for ${name}`);
    }
  });

  it('says so plainly for a tool that takes no arguments at all', async () => {
    const result = await callTool('diagram_undo', { dir: '/tmp' }, tempContext());
    expect(result.text).toContain('diagram_undo takes no arguments');
  });

  it('leaves diagram_patch to its own zod validation, which says more', async () => {
    const result = await callTool('diagram_patch', { ops: [], summary: 'x', extra: 1 }, tempContext());
    // Not the generic dispatcher refusal — the patch surface answers for itself.
    expect(result.text).not.toContain('unknown argument');
  });

  it('accepts every argument the schema does declare', async () => {
    const ctx = await seeded();
    expect((await callTool('diagram_get', { view: true }, ctx)).ok).toBe(true);
    expect((await callTool('diagram_export', { format: 'json' }, ctx)).ok).toBe(true);
    // No format at all is json, exactly as the CLI twin's default is (§4.2).
    const bare = await callTool('diagram_export', {}, ctx);
    expect(bare.ok).toBe(true);
    expect(bare.text).toContain('ok — exported json');
  });
});

describe('diagram_get exposes the view (§7)', () => {
  it('appends the view line once a view is set', async () => {
    const ctx = await seeded();
    await callTool('diagram_view', { preset: 'exec' }, ctx);
    const result = await callTool('diagram_get', {}, ctx);
    expect(result.text).toContain('view: collapsed vpc');
    expect(result.text).toContain('api');
  });

  it('{"view": true} lists the drawn view instead', async () => {
    const ctx = await seeded();
    await callTool('diagram_view', { preset: 'exec' }, ctx);
    const result = await callTool('diagram_get', { view: true }, ctx);
    expect(result.text).not.toContain('| Postgres |');
    expect(result.text).toContain('2 components');
  });
});

describe('a preset that takes no id refuses one (§7)', () => {
  it('refuses diagram_view {"preset":"exec","id":"vpc"} and changes nothing', async () => {
    const ctx = await seeded();
    const result = await callTool('diagram_view', { preset: 'exec', id: 'vpc' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('preset "exec" takes no id');
    expect(currentDoc(ctx).collapsed).toEqual([]);
  });
});
