// tests/blastRadius.test.ts — `diagram blast-radius` and diagram_blast_radius
// (spec §18.5 rules C1–C5, §18.7 the surface).
//
// The maths has its own suite in core (tests/blast.test.ts). What is pinned
// here is the CONTRACT AN AGENT READS: the exact shape of §18.7, the refusal
// for an id the document does not have, the honesty sentences that C3 forbids
// dropping, and the fact that the CLI and the MCP tool return the same bytes.
//
// Real temp .diagram/ directories, real files, no mocks, never the repo's own
// document.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyDoc,
  writeDocAtomic,
  type GEdge,
  type GNode,
  type GraphDoc,
} from '../../core/src/index.js';
import {
  collapsedScopeNote,
  createContext,
  type DiagramContext,
} from '../src/commands/context.js';
import {
  blastRadiusCommand,
  documentHash,
  registerBlastRadius,
  runBlastRadius,
} from '../src/commands/blastRadius.js';
import { callTool, findTool, TOOL_NAMES } from '../src/mcp/tools.js';
import {
  ASSUMPTION_NO_REDUNDANCY,
  ASSUMPTION_PARTIAL_REDUNDANCY,
} from '../../core/src/analysis/index.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  vi.restoreAllMocks();
  process.exitCode = 0;
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

/** A fresh temp .diagram/ path — never the repo's own. */
function tempDiagramDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-blast-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.diagram');
}

function node(id: string, type: GNode['type'] = 'service', parent: string | null = null): GNode {
  return { id, label: id, type, parent };
}

function edge(id: string, from: string, to: string, async = false): GEdge {
  return { id, from, to, ...(async ? { style: 'dashed' as const } : {}) };
}

/**
 * The §18.7 worked example, in miniature and with its shape:
 *
 *   web-client → api-gateway → orders → postgres
 *                api-gateway → auth   → postgres
 *                api-gateway → redis-cache
 *                orders ⇢ kafka ← fulfilment ⇢      (dashed: a queue, both sides)
 *                analytics ⇢ postgres               (dashed: nightly read)
 *
 * Edges point caller → callee (§4.4 rule 4), so a blast radius is REVERSE
 * reachability: everything that depends on postgres is at risk, and the two
 * dashed edges are where propagation stops.
 */
function sampleDoc(): GraphDoc {
  return {
    ...emptyDoc(),
    title: 'Checkout',
    nodes: [
      node('web-client', 'client'),
      node('api-gateway'),
      node('orders', 'service', 'vpc'),
      node('auth', 'service', 'vpc'),
      node('postgres', 'database', 'vpc'),
      node('redis-cache', 'cache', 'vpc'),
      node('kafka', 'queue'),
      node('fulfilment'),
      node('analytics'),
    ],
    groups: [{ id: 'vpc', kind: 'vpc', label: 'Private VPC', parent: null }],
    edges: [
      edge('e1', 'web-client', 'api-gateway'),
      edge('e2', 'api-gateway', 'orders'),
      edge('e3', 'api-gateway', 'auth'),
      edge('e4', 'orders', 'postgres'),
      edge('e5', 'auth', 'postgres'),
      edge('e6', 'api-gateway', 'redis-cache'),
      edge('e7', 'orders', 'kafka', true),
      edge('e8', 'fulfilment', 'kafka', true),
      edge('e9', 'analytics', 'postgres', true),
    ],
  };
}

/** A context holding `doc` on disk. */
function seeded(doc: GraphDoc = sampleDoc()): DiagramContext {
  const ctx = createContext({ dir: tempDiagramDir() });
  writeDocAtomic(ctx.dir, doc);
  return ctx;
}

/** The value of a keyed line, e.g. row('at risk (4)') -> 'auth, orders, ...'. */
function valueOf(text: string, key: string): string | undefined {
  const line = text.split('\n').find((l) => l.trim().startsWith(key));
  return line?.slice(2).slice(key.length).trim();
}

// ---------------------------------------------------------------------------
// The prediction (§18.7)
// ---------------------------------------------------------------------------

describe('diagram blast-radius <id>', () => {
  it('renders the §18.7 shape: headline, at risk, contained, articulation, assumptions', () => {
    const ctx = seeded();
    const out = runBlastRadius('postgres', { dir: ctx.dir });
    expect(out.ok).toBe(true);
    const lines = out.text.split('\n');

    expect(lines[0]).toBe(
      'blast radius — postgres   (synchronous only; dashed edges stop propagation)',
    );
    // Nearest first, then document order — deterministic on every run.
    expect(valueOf(out.text, 'at risk (4)')).toBe('orders, auth, api-gateway, web-client');
    expect(valueOf(out.text, 'contained (1)')).toBe('analytics (async from postgres)');
    expect(valueOf(out.text, 'articulation')).toBe(
      'yes — removing it also isolates 1 node',
    );
    expect(lines[lines.length - 2]).toContain('assumptions');
    expect(lines[lines.length - 1]).toContain('document');
  });

  it('names every containment, with the node on the far side of the dashed edge (C2)', () => {
    const ctx = seeded();
    // Both edges into kafka are dashed: the design's claim is that a queue
    // outage cascades nowhere, and the claim is printed rather than left as
    // an empty list.
    const out = runBlastRadius('kafka', { dir: ctx.dir });
    expect(valueOf(out.text, 'at risk (0)')).toBe('nothing depends on this synchronously');
    expect(valueOf(out.text, 'contained (2)')).toBe(
      'orders (async from kafka), fulfilment (async from kafka)',
    );
  });

  it('says "at risk", never "will fail" (C3)', () => {
    const ctx = seeded();
    for (const id of ['postgres', 'orders', 'api-gateway']) {
      const out = runBlastRadius(id, { dir: ctx.dir });
      expect(out.text).toContain('at risk');
      // "will fail" appears exactly once, inside the sentence that FORBIDS it.
      const saying = out.text.split('\n').filter((l) => l.includes('will fail'));
      expect(saying).toHaveLength(1);
      expect(saying[0]).toContain('"at risk" is not "will fail"');
      expect(out.text.toLowerCase()).not.toContain('will break');
      expect(out.text.toLowerCase()).not.toContain('will go down');
    }
  });

  it('always prints the assumptions line, and it carries both C2 and C3 (C3)', () => {
    const ctx = seeded();
    const out = runBlastRadius('postgres', { dir: ctx.dir });
    const assumptions = valueOf(out.text, 'assumptions') ?? '';
    expect(assumptions).toContain('"at risk" is not "will fail"');
    expect(assumptions).toContain('synchronous edges only');
    // The blind spots come first, verbatim from core — one wording everywhere.
    expect(assumptions).toContain('9 of 9 nodes carry no operational meta');
  });

  it('reports articulation as a separate metric, never merged into the count', () => {
    const ctx = seeded();
    const gateway = runBlastRadius('api-gateway', { dir: ctx.dir });
    // 1 at risk (web-client), but removing it isolates most of the diagram.
    expect(valueOf(gateway.text, 'at risk (1)')).toBe('web-client');
    expect(valueOf(gateway.text, 'articulation')).toMatch(/^yes — removing it also isolates/);

    expect(valueOf(gateway.text, 'articulation')).toBe(
      'yes — removing it also isolates 2 nodes',
    );

    const cache = runBlastRadius('redis-cache', { dir: ctx.dir });
    expect(valueOf(cache.text, 'articulation')).toBe('no — removing it does not split the diagram');
  });

  it('treats a group as one experiment and says what it kills (§18.3 detail 2)', () => {
    const ctx = seeded();
    const out = runBlastRadius('vpc', { dir: ctx.dir });
    expect(out.ok).toBe(true);
    expect(out.text.split('\n')[0]).toBe(
      'blast radius — vpc (boundary — kills 4 components)   ' +
        '(synchronous only; dashed edges stop propagation)',
    );
    expect(valueOf(out.text, 'at risk (2)')).toBe('api-gateway, web-client');
    expect(valueOf(out.text, 'contained (1)')).toBe('analytics (async from postgres)');
    // A boundary is not an articulation point of the runtime graph.
    expect(valueOf(out.text, 'articulation')).toMatch(/^n\/a —/);
  });

  it('says so plainly when nothing depends on the target', () => {
    const ctx = seeded();
    const out = runBlastRadius('web-client', { dir: ctx.dir });
    expect(valueOf(out.text, 'at risk (0)')).toBe('nothing depends on this synchronously');
  });
});

// ---------------------------------------------------------------------------
// C4 — the document hash
// ---------------------------------------------------------------------------

describe('C4 — every result records the document hash', () => {
  it('prints a hash and the document size on every prediction and on the backlog', () => {
    const ctx = seeded();
    for (const out of [
      runBlastRadius('postgres', { dir: ctx.dir }),
      runBlastRadius(undefined, { dir: ctx.dir }),
    ]) {
      expect(valueOf(out.text, 'document')).toMatch(
        /^sha256:[0-9a-f]{12} — 9 nodes, 1 group, 9 edges$/,
      );
    }
  });

  it('changes when the document changes, so a stale prediction is detectable', () => {
    const ctx = seeded();
    const before = valueOf(runBlastRadius('postgres', { dir: ctx.dir }).text, 'document');

    const doc = sampleDoc();
    doc.edges.push(edge('e10', 'fulfilment', 'postgres'));
    writeDocAtomic(ctx.dir, doc);
    const after = valueOf(runBlastRadius('postgres', { dir: ctx.dir }).text, 'document');

    expect(after).not.toBe(before);
  });

  it('is canonical: key order and whitespace do not change it', () => {
    const doc = sampleDoc();
    // The same document with every key written in the opposite order — what a
    // hand edit or a different serialiser produces.
    const reordered = Object.fromEntries(
      Object.entries(doc).reverse(),
    ) as unknown as GraphDoc;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(doc));
    expect(documentHash(reordered)).toBe(documentHash(doc));
  });
});

// ---------------------------------------------------------------------------
// A2 — the full document, never the derived view
// ---------------------------------------------------------------------------

describe('A2 — analysis runs on the full document', () => {
  it('predicts identically with a group collapsed, and says which scope it used', () => {
    const open = seeded();
    const collapsed = seeded({ ...sampleDoc(), collapsed: ['vpc'] });

    const a = runBlastRadius('postgres', { dir: open.dir });
    const b = runBlastRadius('postgres', { dir: collapsed.dir });

    expect(valueOf(b.text, 'at risk (4)')).toBe(valueOf(a.text, 'at risk (4)'));
    expect(a.text).not.toContain('scope');
    // The clause after the em dash is the spine's `collapsedScopeNote`, which
    // `diagram analyse` also prints verbatim — one A2 sentence, two layouts.
    expect(valueOf(b.text, 'scope')).toBe(
      'the full document — the collapsed view (vpc) is ignored here',
    );
    expect(b.text).toContain(
      collapsedScopeNote({ ...sampleDoc(), collapsed: ['vpc'] }) ?? '',
    );
  });
});

// ---------------------------------------------------------------------------
// The backlog (§18.4)
// ---------------------------------------------------------------------------

describe('diagram blast-radius (no id) — the experiment backlog', () => {
  it('ranks by at-risk count and prints the §18.7 row shape', () => {
    const ctx = seeded();
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(out.ok).toBe(true);
    const rows = out.text.split('\n').filter((l) => /^ {2}\d+\. /.test(l));

    expect(rows[0]).toBe('  1. postgres     4 at risk   articulation point, 1 contained');
    expect(rows.map((r) => r.trim().split(/\s+/)[1])).toEqual([
      'postgres',
      'orders',
      'auth',
      'redis-cache',
      'api-gateway',
      // 0 at risk, but removing it isolates fulfilment — the two metrics are
      // separate and the backlog keeps both (§18.3 detail 3).
      'kafka',
    ]);
  });

  it('excludes entry points — killing the browser is not an experiment', () => {
    const ctx = seeded();
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(out.text).not.toMatch(/^ {2}\d+\. web-client/m);
  });

  it('ranks boundaries as experiments only when asked', () => {
    const ctx = seeded();
    expect(runBlastRadius(undefined, { dir: ctx.dir }).text).not.toContain('boundary experiment');
    const withGroups = runBlastRadius(undefined, { dir: ctx.dir, groups: true });
    expect(withGroups.text).toMatch(/^ {2}\d+\. vpc\s+2 at risk\s+boundary experiment, kills 4 components, 1 contained$/m);
  });

  it('points at the next step rather than leaving the agent to guess (§3.3)', () => {
    const ctx = seeded();
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(valueOf(out.text, 'next')).toBe(
      '`diagram blast-radius postgres` for what it puts at risk',
    );
  });

  it('gives an honest empty answer for a document with nothing to rank', () => {
    const ctx = seeded({
      ...emptyDoc(),
      nodes: [node('a'), node('b')],
      edges: [],
    });
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(out.ok).toBe(true);
    expect(out.text.split('\n')[0]).toBe('experiment backlog — nothing to rank');
    expect(valueOf(out.text, 'note')).toBe(
      'no component has synchronous dependents: nothing here cascades',
    );
    // Still honest about its own blind spots.
    expect(out.text).toContain('"at risk" is not "will fail"');
  });

  it('says a data model has nothing to analyse rather than printing an empty report', () => {
    const ctx = seeded({
      ...emptyDoc(),
      nodes: [node('orders', 'entity'), node('invoices', 'entity')],
      edges: [{ id: 'r1', from: 'orders', to: 'invoices', cardinality: '1:N' }],
    });
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('this document is a data model, not a runtime');
  });
});

// ---------------------------------------------------------------------------
// Refusals (§3.3 — say what to do)
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('refuses an unknown id, lists the valid ones, and does not answer "nothing at risk"', () => {
    const ctx = seeded();
    const out = runBlastRadius('postgress', { dir: ctx.dir });
    expect(out.ok).toBe(false);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.text).toContain('unknown id "postgress" — nothing to predict');
    expect(out.text).toContain('did you mean "postgres"?');
    expect(out.text).toContain('runtime components: web-client, api-gateway');
    expect(out.text).toContain('boundaries (killing one kills its components): vpc');
    expect(out.text).toContain('run `diagram blast-radius` with no id for the ranked backlog');
    expect(out.text).not.toContain('at risk (0)');
  });

  it('refuses an entity node as a category error, not a small answer', () => {
    const ctx = seeded({
      ...sampleDoc(),
      nodes: [...sampleDoc().nodes, node('invoice', 'entity')],
    });
    const out = runBlastRadius('invoice', { dir: ctx.dir });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('entity node "invoice" — nothing to predict');
    expect(out.text).toContain('a data model, not a runtime component');
  });

  it('refuses when there is no document at all', () => {
    const ctx = createContext({ dir: tempDiagramDir() });
    const out = runBlastRadius('postgres', { dir: ctx.dir });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('no diagram — nothing to predict');
    expect(out.text).toContain('draw the architecture first');
  });

  it('reports an unreadable document as a read failure, not as an empty prediction', () => {
    const ctx = createContext({ dir: tempDiagramDir() });
    fs.mkdirSync(ctx.dir, { recursive: true });
    fs.writeFileSync(ctx.paths.graphFile, '{ not json', 'utf8');
    const out = runBlastRadius(undefined, { dir: ctx.dir });
    expect(out.ok).toBe(false);
    expect(out.text).toContain(`cannot read ${ctx.paths.graphFile}`);
  });
});

// ---------------------------------------------------------------------------
// C1 and C5 — it reads, and that is all it does
// ---------------------------------------------------------------------------

describe('C1/C5 — the engine never executes an experiment and never writes a result', () => {
  it('leaves the .diagram directory byte-identical', () => {
    const ctx = seeded();
    const listing = (): string[] =>
      fs
        .readdirSync(ctx.dir, { recursive: true, withFileTypes: false })
        .map(String)
        .sort();
    const before = listing();
    const graph = fs.readFileSync(ctx.paths.graphFile, 'utf8');

    runBlastRadius('postgres', { dir: ctx.dir });
    runBlastRadius(undefined, { dir: ctx.dir, groups: true });
    runBlastRadius('nope', { dir: ctx.dir });

    expect(listing()).toEqual(before);
    expect(fs.readFileSync(ctx.paths.graphFile, 'utf8')).toBe(graph);
    // C5, at its strongest: nothing was written, so nothing could reach
    // graph.json — and no .diagram/chaos/ was created either.
    expect(fs.existsSync(path.join(ctx.dir, 'chaos'))).toBe(false);
  });

  it('contains no way to run anything: no spawn, no network, no writer', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), '../src/commands/blastRadius.ts'),
      'utf8',
    );
    for (const forbidden of [
      'child_process',
      'node:http',
      'spawn(',
      'exec(',
      'fetch(',
      'writeFileSync',
      'writeDocAtomic',
      'applyAndCommit',
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The command wrapper and the MCP twin
// ---------------------------------------------------------------------------

describe('the CLI wrapper', () => {
  it('writes a prediction to stdout and exits 0', () => {
    const ctx = seeded();
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    blastRadiusCommand('postgres', { dir: ctx.dir });
    expect(out.mock.calls[0]?.[0]).toContain('blast radius — postgres');
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('writes a refusal to stderr and sets exit 1', () => {
    const ctx = seeded();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    blastRadiusCommand('nope', { dir: ctx.dir });
    expect(err.mock.calls[0]?.[0]).toContain('unknown id "nope"');
    expect(process.exitCode).toBe(1);
  });

  it('registers `blast-radius` with an optional id, --groups and --dir', async () => {
    const { Command } = await import('commander');
    const program = new Command();
    registerBlastRadius(program);
    const cmd = program.commands.find((c) => c.name() === 'blast-radius');
    expect(cmd).toBeDefined();
    expect(cmd?.usage()).toContain('[id]');
    const flags = cmd?.options.map((o) => o.long) ?? [];
    expect(flags).toEqual(expect.arrayContaining(['--groups', '--dir']));
  });
});

describe('diagram_blast_radius (the MCP twin)', () => {
  it('is advertised, read-only, and takes id and groups', () => {
    expect(TOOL_NAMES).toContain('diagram_blast_radius');
    const tool = findTool('diagram_blast_radius');
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(Object.keys(tool?.inputSchema['properties'] ?? {})).toEqual(['id', 'groups']);
  });

  it('says in its description that it never runs anything and never says "will fail"', () => {
    const description = findTool('diagram_blast_radius')?.description ?? '';
    expect(description).toContain('NEVER runs anything');
    expect(description).toContain('at risk');
  });

  it('returns byte-identical text to the CLI, for both forms and for a refusal', async () => {
    const ctx = seeded();
    const cases: Array<[Record<string, unknown>, string | undefined, boolean]> = [
      [{ id: 'postgres' }, 'postgres', false],
      [{}, undefined, false],
      [{ groups: true }, undefined, true],
      [{ id: 'nope' }, 'nope', false],
    ];
    for (const [args, id, groups] of cases) {
      const tool = await callTool('diagram_blast_radius', args, ctx);
      const cli = runBlastRadius(id, { dir: ctx.dir, ...(groups ? { groups: true } : {}) });
      expect(tool.text).toBe(cli.text);
      expect(tool.ok).toBe(cli.ok);
    }
  });

  it('refuses an unknown argument and names the right one', async () => {
    const ctx = seeded();
    const out = await callTool('diagram_blast_radius', { node: 'postgres' }, ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('unknown argument "node"');
    expect(out.text).toContain('did you mean "id"?');
  });

  it('refuses a wrongly typed id rather than silently printing the backlog', async () => {
    const ctx = seeded();
    const out = await callTool('diagram_blast_radius', { id: 7 }, ctx);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('id must be a string');
  });
});

// ---------------------------------------------------------------------------
// What the backlog is allowed to leave out, and the claims a refusal is
// allowed to make.
// ---------------------------------------------------------------------------

describe('the backlog does not drop a candidate silently', () => {
  function containmentDoc(): GraphDoc {
    return {
      ...emptyDoc(),
      title: 'Async only',
      nodes: [node('prod'), node('bus', 'queue'), node('lonely')],
      edges: [edge('e1', 'prod', 'bus', true)],
    };
  }

  it('ranks the experiment that would test a containment claim', () => {
    const dir = tempDiagramDir();
    writeDocAtomic(dir, containmentDoc());
    const out = runBlastRadius(undefined, { dir });
    // `bus` has 0 at risk and 1 contained: it is not a leaf, it is precisely
    // the experiment that validates the design's asynchronous-safety claim
    // (§18.3, §18.8).
    expect(out.text).toContain('bus');
    expect(out.text).toContain('1 contained');
  });

  it('ranks a boundary that kills components nothing outside depends on', () => {
    const dir = tempDiagramDir();
    writeDocAtomic(dir, {
      ...emptyDoc(),
      title: 'Sealed',
      nodes: [node('a', 'service', 'vpc'), node('b', 'service', 'vpc')],
      groups: [{ id: 'vpc', kind: 'vpc', label: 'vpc', parent: null }],
      edges: [edge('e1', 'a', 'b')],
    });
    const out = runBlastRadius(undefined, { dir, groups: true });
    expect(out.text).toMatch(/vpc\s+0 at risk\s+boundary experiment, kills 2 components/);
  });

  it('says how many candidates it did not rank, when it drops any', () => {
    const dir = tempDiagramDir();
    writeDocAtomic(dir, {
      ...emptyDoc(),
      title: 'Empty boundary',
      nodes: [node('a'), node('b')],
      groups: [{ id: 'empty', kind: 'generic', label: 'empty', parent: null }],
      edges: [edge('e1', 'a', 'b')],
    });
    const out = runBlastRadius(undefined, { dir, groups: true });
    expect(out.text).toMatch(/not ranked\s+1 candidate with no synchronous dependents/);
  });
});

describe('a refusal states only what the document supports', () => {
  it('does not call an empty document a data model', () => {
    const dir = tempDiagramDir();
    writeDocAtomic(dir, { ...emptyDoc(), title: 'Empty' });
    const out = runBlastRadius('db', { dir });
    expect(out.ok).toBe(false);
    expect(out.text).not.toContain('every node in it is an entity');
    expect(out.text).toContain('this document has no components yet');
  });

  it('still names the ERD case as an ERD', () => {
    const dir = tempDiagramDir();
    writeDocAtomic(dir, {
      ...emptyDoc(),
      title: 'ERD',
      nodes: [node('orders-tbl', 'entity')],
    });
    const out = runBlastRadius('db', { dir });
    expect(out.ok).toBe(false);
    expect(out.text).toContain('every node in it is an entity (a data model)');
  });
});

describe('C4: the hash tracks what the prediction was computed from', () => {
  it('does not move when only the view state changes', () => {
    const d = sampleDoc();
    const collapsed = { ...d, collapsed: ['vpc'] };
    expect(documentHash(collapsed)).toBe(documentHash(d));
  });

  it('moves when any design field changes', () => {
    const d = sampleDoc();
    const renamed = { ...d, title: 'Checkout v2' };
    expect(documentHash(renamed)).not.toBe(documentHash(d));
    const rewired = { ...d, edges: [...d.edges, edge('zz', 'analytics', 'redis-cache')] };
    expect(documentHash(rewired)).not.toBe(documentHash(d));
  });
});

// ---------------------------------------------------------------------------
// §18.11 — redundancy on the surface
//
// The maths is core's (tests/blast.test.ts pins the fixpoint). What is pinned
// here is that the feature is VISIBLE: a node an alternative held up is named
// on screen, it is not confused with a containment, and the assumptions line
// says which of the two §18.11 caveats is true of the document in front of the
// reader. Without the `spared` row the whole feature is an absence — the node
// simply does not appear in `at risk`, which is exactly what a wrong answer
// also looks like.
// ---------------------------------------------------------------------------

/** app depends on EITHER replica ("db"), and hard on redis. */
function replicatedDoc(): GraphDoc {
  return {
    ...emptyDoc(),
    title: 'HA',
    nodes: [
      node('web-client', 'client'),
      node('app'),
      node('pg-primary', 'database'),
      node('pg-replica', 'database'),
      node('redis-cache', 'cache'),
    ],
    edges: [
      { id: 'e0', from: 'web-client', to: 'app' },
      { id: 'e1', from: 'app', to: 'pg-primary', alt: 'db' },
      { id: 'e2', from: 'app', to: 'pg-replica', alt: 'db' },
      { id: 'e3', from: 'app', to: 'redis-cache' },
    ],
  };
}

describe('spared — what a live alternative held up (§18.11)', () => {
  it('names the node, the tag, what fell and what is still up', () => {
    const ctx = seeded(replicatedDoc());
    const out = runBlastRadius('pg-primary', { dir: ctx.dir });
    expect(out.ok).toBe(true);
    expect(valueOf(out.text, 'spared (1)')).toBe(
      'app (alt "db" — lost pg-primary, still up: pg-replica)',
    );
    // And it is NOT at risk: losing one replica alone was survivable, which is
    // the sentence §18.11 says the tool never got to say before.
    expect(valueOf(out.text, 'at risk (0)')).toBe('nothing depends on this synchronously');
  });

  it('is not a containment — a live replica and an async boundary are different claims', () => {
    const ctx = seeded(replicatedDoc());
    const out = runBlastRadius('pg-primary', { dir: ctx.dir });
    expect(out.text).not.toContain('contained (');
    // The headline still states C2 on the same result: the reader must be able
    // to tell "spared by a replica" from "contained by a queue".
    expect(out.text.split('\n')[0]).toContain(
      '(synchronous only; dashed edges stop propagation)',
    );
  });

  it('says nothing at all about sparing when the dependency was hard', () => {
    const ctx = seeded(replicatedDoc());
    const out = runBlastRadius('redis-cache', { dir: ctx.dir });
    expect(valueOf(out.text, 'at risk (2)')).toBe('app, web-client');
    expect(out.text).not.toContain('spared');
  });

  it('adds no line to a document that carries no alt at all', () => {
    const ctx = seeded();
    expect(runBlastRadius('postgres', { dir: ctx.dir }).text).not.toContain('spared');
  });

  it('reports nothing spared once EVERY alternative in the set has fallen', () => {
    // The fixpoint case, from the surface: X → A and X → B are one alt set,
    // and both depend on C. Killing C takes out the whole set, so X is at
    // risk and there is nothing left holding it up to report.
    const ctx = seeded({
      ...emptyDoc(),
      title: 'Fixpoint',
      nodes: [node('x'), node('a'), node('b'), node('c', 'database')],
      edges: [
        { id: 'e1', from: 'x', to: 'a', alt: 'db' },
        { id: 'e2', from: 'x', to: 'b', alt: 'db' },
        { id: 'e3', from: 'a', to: 'c' },
        { id: 'e4', from: 'b', to: 'c' },
      ],
    });
    const out = runBlastRadius('c', { dir: ctx.dir });
    expect(valueOf(out.text, 'at risk (3)')).toBe('a, b, x');
    expect(out.text).not.toContain('spared');
  });

  it('counts a boundary outage as ONE fallen alternative, however wide it is', () => {
    // Two zones, one replica each. Killing az-a kills pg-primary; the set still
    // has pg-replica in az-b, so app is spared — and the boundary must not be
    // read as two losses just because two vertices inside it went down.
    const ctx = seeded({
      ...emptyDoc(),
      title: 'Two zones',
      nodes: [
        node('app'),
        node('pg-primary', 'database', 'az-a'),
        node('cache-a', 'cache', 'az-a'),
        node('pg-replica', 'database', 'az-b'),
      ],
      groups: [
        { id: 'az-a', kind: 'cluster', label: 'az-a', parent: null },
        { id: 'az-b', kind: 'cluster', label: 'az-b', parent: null },
      ],
      edges: [
        { id: 'e1', from: 'app', to: 'pg-primary', alt: 'db' },
        { id: 'e2', from: 'app', to: 'pg-replica', alt: 'db' },
      ],
    });
    const out = runBlastRadius('az-a', { dir: ctx.dir });
    expect(valueOf(out.text, 'spared (1)')).toBe(
      'app (alt "db" — lost pg-primary, still up: pg-replica)',
    );
  });

  it('spares a node whose alternative points at a boundary that is still up', () => {
    // The edge names the GROUP (§3.1 allows it). Killing a component inside
    // az-a is killing part of what that edge depends on, so the alternative
    // has fallen — and the one pointing at az-b has not.
    const ctx = seeded({
      ...emptyDoc(),
      title: 'Zone edges',
      nodes: [
        node('app'),
        node('worker-a', 'service', 'az-a'),
        node('worker-b', 'service', 'az-b'),
      ],
      groups: [
        { id: 'az-a', kind: 'cluster', label: 'az-a', parent: null },
        { id: 'az-b', kind: 'cluster', label: 'az-b', parent: null },
      ],
      edges: [
        { id: 'e1', from: 'app', to: 'az-a', alt: 'zone' },
        { id: 'e2', from: 'app', to: 'az-b', alt: 'zone' },
      ],
    });
    const out = runBlastRadius('worker-a', { dir: ctx.dir });
    expect(valueOf(out.text, 'spared (1)')).toBe(
      'app (alt "zone" — lost az-a, still up: az-b)',
    );
  });
});

describe('the §18.11 caveat on the assumptions line', () => {
  it('stands verbatim over a document that states no redundancy', () => {
    const ctx = seeded();
    const assumptions = valueOf(runBlastRadius('postgres', { dir: ctx.dir }).text, 'assumptions') ?? '';
    expect(assumptions).toContain(ASSUMPTION_NO_REDUNDANCY);
    expect(assumptions).not.toContain(ASSUMPTION_PARTIAL_REDUNDANCY);
  });

  it('narrows to the untagged edges once the document says alt', () => {
    const ctx = seeded(replicatedDoc());
    const assumptions = valueOf(runBlastRadius('pg-primary', { dir: ctx.dir }).text, 'assumptions') ?? '';
    expect(assumptions).toContain(ASSUMPTION_PARTIAL_REDUNDANCY);
    // The old wording is now FALSE of this document — every edge is not a hard
    // dependency any more — so it must not appear beside the new one.
    expect(assumptions).not.toContain(ASSUMPTION_NO_REDUNDANCY);
  });

  it('is a property of the document, so the backlog carries the same one', () => {
    const plain = seeded();
    const ha = seeded(replicatedDoc());
    expect(valueOf(runBlastRadius(undefined, { dir: plain.dir }).text, 'assumptions') ?? '').toContain(
      ASSUMPTION_NO_REDUNDANCY,
    );
    expect(valueOf(runBlastRadius(undefined, { dir: ha.dir }).text, 'assumptions') ?? '').toContain(
      ASSUMPTION_PARTIAL_REDUNDANCY,
    );
  });

  it('never says redundancy is MODELLED — over-reporting stays the direction (C3)', () => {
    const ctx = seeded(replicatedDoc());
    const out = runBlastRadius('pg-primary', { dir: ctx.dir });
    expect(out.text).toContain('over-reports');
    expect(out.text.toLowerCase()).not.toContain('exact');
    // C3 is untouched by any of it: still one "will fail", still the sentence
    // that forbids it.
    const saying = out.text.split('\n').filter((l) => l.includes('will fail'));
    expect(saying).toHaveLength(1);
  });

  it('returns byte-identical text through diagram_blast_radius (§4.2)', async () => {
    const ctx = seeded(replicatedDoc());
    for (const id of ['pg-primary', 'redis-cache', undefined]) {
      const tool = await callTool(
        'diagram_blast_radius',
        id === undefined ? {} : { id },
        ctx,
      );
      const cli = runBlastRadius(id, { dir: ctx.dir });
      expect(tool.text).toBe(cli.text);
      expect(tool.ok).toBe(cli.ok);
    }
    // Not vacuous: the thing being compared is the new output.
    expect((await callTool('diagram_blast_radius', { id: 'pg-primary' }, ctx)).text).toContain(
      'spared (1)',
    );
  });
});
