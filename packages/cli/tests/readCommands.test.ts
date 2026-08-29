// tests/readCommands.test.ts — `diagram get | check | rules | view` (spec §4.1, §4.2, §4.4).
//
// The exported run* functions are called directly against real temp .diagram/
// directories: real files, real locks, real history snapshots, no mocks and
// never the repo's own .diagram/. The strings asserted here are the contract an
// agent reads on every turn, so they are pinned, not sampled.
//
// The *Command wrappers are exercised too, with process.stdout/stderr.write
// stubbed, because "which stream, and what exit code" is the whole interface
// for an agent driving the engine from a shell.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyDoc,
  readDoc,
  writeDocAtomic,
  type GNode,
  type GraphDoc,
} from '../../core/src/index.js';
import { loadErdRules, loadRules } from '../../core/src/rules/load.js';
import { createContext } from '../src/commands/context.js';
import { getCommand, runGet } from '../src/commands/get.js';
import { checkCommand, runCheck } from '../src/commands/check.js';
import { rulesCommand, runRules } from '../src/commands/rules.js';
import {
  runView,
  runViewCollapsed,
  viewCommand,
} from '../src/commands/view.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-read-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.diagram');
}

function node(id: string, parent: string | null = null): GNode {
  return { id, label: id, type: 'service', parent };
}

/** A document with two top-level groups, a nested one, and nodes inside them. */
function sampleDoc(): GraphDoc {
  return {
    ...emptyDoc(),
    title: 'Checkout platform',
    nodes: [node('api', 'vpc-private'), node('db', 'db-subnet'), node('cdn', 'edge')],
    groups: [
      { id: 'vpc-private', kind: 'vpc', label: 'Private VPC', parent: null },
      { id: 'db-subnet', kind: 'generic', label: 'DB subnet', parent: 'vpc-private' },
      { id: 'edge', kind: 'region', label: 'Edge', parent: null },
    ],
    edges: [{ id: 'e1', from: 'api', to: 'db', label: 'reads' }],
  };
}

/** Seed a temp .diagram/ with a document and return its path. */
function seeded(doc: GraphDoc = sampleDoc()): string {
  const dir = tempDiagramDir();
  writeDocAtomic(dir, doc);
  return dir;
}

/** Capture what a *Command wrote, and the exit code it left behind. */
function captureCommand(run: () => void): { out: string; err: string; code: number } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  process.exitCode = 0;
  run();
  return { out, err, code: Number(process.exitCode ?? 0) };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('diagram get', () => {
  it('prints the compact table for the document on disk', () => {
    const result = runGet({ dir: seeded() });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('## "Checkout platform"  (direction: DOWN)');
    expect(result.text).toContain('### Groups (id | kind | label | parent)');
    expect(result.text).toContain('db-subnet');
    expect(result.text).toContain('### Nodes (id | type | label | parent)');
    expect(result.text).toContain('### Edges (id | from -> to | label | style)');
    expect(result.text).toContain('e1 | api -> db | reads | solid');
    // Never JSON, and never geometry (spec §1.3, §4.1).
    expect(result.text).not.toContain('{');
    expect(result.text).not.toMatch(/\bx\b\s*[:=]/);
  });

  it('shows entity fields and node meta when the document uses them', () => {
    const doc: GraphDoc = {
      ...emptyDoc(),
      nodes: [
        {
          id: 'orders',
          label: 'orders',
          type: 'entity',
          parent: null,
          fields: [{ name: 'id', type: 'uuid', pk: true }],
        },
        { id: 'api', label: 'API', type: 'service', parent: null, meta: { runtime: 'go' } },
      ],
    };
    const text = runGet({ dir: seeded(doc) }).text;
    expect(text).toContain('### Entities (id | fields)');
    expect(text).toContain('id:uuid PK');
    expect(text).toContain('### Meta (id | key=value)');
    expect(text).toContain('runtime=go');
  });

  it('prints the empty table plus a note when no document exists yet', () => {
    const dir = tempDiagramDir();
    const result = runGet({ dir });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('## "Untitled"');
    expect(result.text).toContain('(empty diagram');
    expect(result.text).toContain('no document yet at');
    // A read must never create anything.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('fails with the parse errors on stderr when graph.json is broken', () => {
    const dir = tempDiagramDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graph.json'), '{ not json', 'utf8');

    const { out, err, code } = captureCommand(() => getCommand({ dir }));
    expect(out).toBe('');
    expect(code).toBe(1);
    expect(err).toContain('cannot read');
    expect(err).toContain('not valid JSON');
  });

  it('writes the table to stdout and exits 0', () => {
    const { out, err, code } = captureCommand(() => getCommand({ dir: seeded() }));
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('## "Checkout platform"');
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe('diagram check', () => {
  it('reports ok with the counts for a valid document', () => {
    const result = runCheck({ dir: seeded() });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok — 3 nodes, 3 groups, 1 edge');
  });

  it('treats a project with no document as valid', () => {
    const result = runCheck({ dir: tempDiagramDir() });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('ok — no document yet at');
  });

  it('reports the invariant violations and exits 1', () => {
    // A dangling edge target (V5) — schema-valid, document-invalid.
    const doc: GraphDoc = {
      ...emptyDoc(),
      nodes: [node('api')],
      edges: [{ id: 'e1', from: 'api', to: 'redis-cache' }],
    };
    const dir = seeded(doc);

    const { out, err, code } = captureCommand(() => checkCommand({ dir }));
    expect(out).toBe('');
    expect(code).toBe(1);
    expect(err).toContain('invalid — 1 problem');
    expect(err).toContain('redis-cache');
    // Indented under the headline, like every other failure the agent sees.
    expect(err.split('\n')[1]?.startsWith('  ')).toBe(true);
    // check never touches the document.
    const after = readDoc(path.join(dir, 'graph.json'));
    expect(after.ok && after.doc.edges).toHaveLength(1);
  });

  it('pluralises the headline for several problems', () => {
    const doc: GraphDoc = {
      ...emptyDoc(),
      nodes: [node('api')],
      edges: [
        { id: 'e1', from: 'api', to: 'nope' },
        { id: 'e2', from: 'also-nope', to: 'api' },
      ],
    };
    const result = runCheck({ dir: seeded(doc) });
    expect(result.ok).toBe(false);
    expect(result.text.split('\n')[0]).toBe('invalid — 2 problems');
  });
});

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

describe('diagram rules', () => {
  it('prints the core rules verbatim', () => {
    expect(runRules().text).toBe(loadRules());
  });

  it('prints the ERD rules with --erd, and they are a different document', () => {
    expect(runRules({ erd: true }).text).toBe(loadErdRules());
    expect(loadErdRules()).not.toBe(loadRules());
  });

  it('writes to stdout with exactly one trailing newline and exits 0', () => {
    const { out, err, code } = captureCommand(() => rulesCommand());
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toBe(`${loadRules().replace(/\n$/, '')}\n`);
    // A passthrough: no banner, no framing the agent has to discount.
    expect(out.startsWith('# Diagram engine')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

/** doc.collapsed as written to disk. */
function collapsedOnDisk(dir: string): string[] {
  const result = readDoc(path.join(dir, 'graph.json'));
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.doc.collapsed;
}

describe('diagram view', () => {
  it('exec collapses the top-level groups and writes them to the document', () => {
    const dir = seeded();
    const result = runView('exec', { dir });
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')).toEqual([
      'ok — view exec',
      'collapsed: vpc-private, edge (2 of 3 groups)',
      // Exactly three lines: the collapse is honoured by the viewer and by
      // `diagram export svg`, so there is nothing left to caveat.
      'graph: 3 nodes, 3 groups, 1 edge',
    ]);
    expect(collapsedOnDisk(dir)).toEqual(['vpc-private', 'edge']);
  });

  it('eng opens everything', () => {
    const dir = seeded({ ...sampleDoc(), collapsed: ['vpc-private'] });
    const result = runView('eng', { dir });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('collapsed: none — every group open');
    expect(collapsedOnDisk(dir)).toEqual([]);
  });

  it('focus keeps the target and its ancestors open', () => {
    const dir = seeded();
    const result = runView('focus', { dir, id: 'db-subnet' });
    expect(result.ok).toBe(true);
    expect(result.text.split('\n')[0]).toBe('ok — view focus:db-subnet');
    // vpc-private is db-subnet's parent, so it stays open; edge does not.
    expect(collapsedOnDisk(dir)).toEqual(['edge']);
  });

  it('records the change in history so undo can put the view back', () => {
    const dir = seeded();
    runView('exec', { dir });
    const historyDir = path.join(dir, 'history');
    expect(fs.existsSync(historyDir)).toBe(true);
    expect(fs.readdirSync(historyDir).filter((f) => f.endsWith('.json')).length).toBe(2);
  });

  it('does not snapshot a no-op re-application of the same view', () => {
    const dir = seeded();
    runView('exec', { dir });
    const before = fs.readdirSync(path.join(dir, 'history'));

    const again = runView('exec', { dir });
    expect(again.ok).toBe(true);
    expect(again.text.split('\n')[0]).toBe('ok — view exec (unchanged)');
    expect(fs.readdirSync(path.join(dir, 'history'))).toEqual(before);
  });

  it('--collapsed sets the list explicitly — the CLI twin of the tool input', () => {
    // Spec §4.1 gives diagram_view two input forms and §4.2 says every tool has
    // a CLI twin; the explicit-list form used to be reachable from MCP only, so
    // a shell-only agent could not say "collapse exactly these".
    const dir = seeded();
    const result = runViewCollapsed(['vpc-private'], { dir });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('collapsed: vpc-private (1 of 3 groups)');
    expect(collapsedOnDisk(dir)).toEqual(['vpc-private']);

    // An empty list expands everything again.
    expect(runViewCollapsed([], { dir }).ok).toBe(true);
    expect(collapsedOnDisk(dir)).toEqual([]);
  });

  it('--collapsed rejects an unknown group and writes nothing', () => {
    const dir = seeded();
    const result = runViewCollapsed(['nope'], { dir });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown group "nope" in collapsed');
    expect(result.text).toContain('Existing groups: vpc-private, db-subnet, edge');
    expect(collapsedOnDisk(dir)).toEqual([]);
  });

  it('rejects an unknown preset name without touching the document', () => {
    const dir = seeded();
    const result = runView('boardroom', { dir });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('rejected — no changes applied');
    expect(result.text).toContain('unknown preset "boardroom"');
    expect(result.text).toContain('exec, eng, focus');
    expect(collapsedOnDisk(dir)).toEqual([]);
  });

  it('lists the valid group ids when focus is given no id', () => {
    const result = runView('focus', { dir: seeded() });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('needs a group id');
    // Capitalised, because core's preset errors say it that way mid-sentence
    // and there is now one helper (existingGroupsLine) behind both.
    expect(result.text).toContain('Existing groups: vpc-private, db-subnet, edge');
  });

  it('lists the valid group ids when the focus id is unknown', () => {
    const result = runView('focus', { dir: seeded(), id: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('unknown focus group "nope"');
    expect(result.text).toContain('Existing groups: vpc-private, db-subnet, edge');
  });

  it('points a node id at the group that holds it', () => {
    const result = runView('focus', { dir: seeded(), id: 'db' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('is a node, not a group');
    expect(result.text).toContain('db-subnet');
  });

  it('refuses to run against a project with no document', () => {
    const dir = tempDiagramDir();
    const { out, err, code } = captureCommand(() => viewCommand('exec', { dir }));
    expect(out).toBe('');
    expect(code).toBe(1);
    expect(err).toContain('no diagram at');
    // It must not seed a diagram whose only content is a view setting.
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('reports a broken graph.json as a read failure, not a bad request', () => {
    const dir = tempDiagramDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'graph.json'), '{ "nope": true }', 'utf8');
    const result = runView('exec', { dir });
    expect(result.ok).toBe(false);
    expect(result.text.startsWith('cannot read ')).toBe(true);
  });

  it('writes the result to stdout and exits 0', () => {
    const { out, err, code } = captureCommand(() => viewCommand('exec', { dir: seeded() }));
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out.startsWith('ok — view exec')).toBe(true);
  });

  it('releases the lock, so a second command can run straight after', () => {
    const dir = seeded();
    runView('exec', { dir });
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
    expect(runView('eng', { dir }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shared: --dir resolution
// ---------------------------------------------------------------------------

describe('--dir resolution', () => {
  it('falls back to DIAGRAM_DIR when no --dir is given', () => {
    const dir = seeded();
    process.env['DIAGRAM_DIR'] = dir;
    expect(createContext().dir).toBe(dir);
    expect(runGet().text).toContain('## "Checkout platform"');
    expect(runCheck().ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M7: the view is visible from the read surfaces
// ---------------------------------------------------------------------------
//
// The failure these cover: `diagram view exec` makes the viewer and
// `export svg` draw four boxes, while `get` kept printing the ten-element
// stored table with nothing in it to say so — so an agent that set a view and
// then read the diagram described a picture nobody could see.

describe('diagram get reports the current view (§7)', () => {
  const collapsedDoc = (): GraphDoc => ({
    ...sampleDoc(),
    collapsed: ['vpc-private', 'edge'],
  });

  it('says nothing extra when no view is set — the common case pays nothing', () => {
    const out = runGet({ dir: seeded() }).text;
    expect(out).not.toContain('view:');
    expect(out).not.toContain('showing:');
  });

  it('appends the same view line `export svg` prints', () => {
    const out = runGet({ dir: seeded(collapsedDoc()) }).text;
    expect(out).toContain('view: collapsed vpc-private, edge (2 of 3 groups), 4 elements hidden');
    expect(out).toContain('`diagram get --view` lists what the reader sees');
  });

  it('--view tabulates the DRAWN document, not the stored one', () => {
    const dir = seeded(collapsedDoc());
    const stored = runGet({ dir }).text;
    const drawn = runGet({ dir, view: true }).text;

    // Stored: every node and group. Drawn: two stand-in boxes, no groups.
    expect(stored).toContain('db-subnet');
    expect(drawn).not.toContain('db-subnet');
    expect(drawn).toContain('vpc-private');
    expect(drawn).toContain('2 components');
    expect(drawn).toContain('the drawn view');
  });

  it('shows a merged edge with its count', () => {
    const doc: GraphDoc = {
      ...sampleDoc(),
      nodes: [node('api', 'vpc-private'), node('worker', 'vpc-private'), node('cdn', 'edge')],
      groups: [
        { id: 'vpc-private', kind: 'vpc', label: 'Private VPC', parent: null },
        { id: 'edge', kind: 'region', label: 'Edge', parent: null },
      ],
      edges: [
        { id: 'e1', from: 'api', to: 'cdn', label: 'reads' },
        { id: 'e2', from: 'worker', to: 'cdn', label: 'reads' },
      ],
      collapsed: ['vpc-private'],
    };
    const drawn = runGet({ dir: seeded(doc), view: true }).text;
    expect(drawn).toContain('reads ×2');
  });

  it('names a stale collapsed id rather than reporting a collapse', () => {
    const doc: GraphDoc = { ...sampleDoc(), collapsed: ['api', 'nosuch'] };
    expect(runGet({ dir: seeded(doc) }).text).toContain(
      'view: full graph — collapsed api, nosuch are not groups in this diagram',
    );
  });
});

describe('diagram check warns about a collapsed id that names no group', () => {
  it('passes, but says the id is ignored and lists the real groups', () => {
    const doc: GraphDoc = { ...sampleDoc(), collapsed: ['api', 'nosuch'] };
    const result = runCheck({ dir: seeded(doc) });
    expect(result.code).toBe(0);
    expect(result.text).toContain('ok — 3 nodes, 3 groups, 1 edge');
    expect(result.text).toContain('note: collapsed "api", "nosuch" are not groups');
    expect(result.text).toContain('groups: vpc-private, db-subnet, edge');
  });

  it('says nothing when every collapsed id is a real group', () => {
    const doc: GraphDoc = { ...sampleDoc(), collapsed: ['edge'] };
    expect(runCheck({ dir: seeded(doc) }).text).not.toContain('note:');
  });
});

describe('diagram view rejects an id a preset cannot use', () => {
  it('refuses `view exec <id>` instead of silently dropping the id', () => {
    const dir = seeded();
    const result = runView('exec', { dir, id: 'edge' });
    expect(result.code).toBe(1);
    expect(result.text).toContain('preset "exec" takes no id, and "edge" was ignored');
    expect(result.text).toContain('did you mean `diagram view focus edge`');
    // And nothing was written: the stored view is untouched.
    expect(readDoc(path.join(dir, 'graph.json')).ok).toBe(true);
    expect(runGet({ dir }).text).not.toContain('view:');
  });

  it('still accepts the id `focus` actually needs', () => {
    expect(runView('focus', { dir: seeded(), id: 'edge' }).code).toBe(0);
  });

  it('--collapsed with no ids expands everything, as documented', () => {
    const dir = seeded({ ...sampleDoc(), collapsed: ['edge'] });
    const result = runViewCollapsed([], { dir });
    expect(result.code).toBe(0);
    expect(result.text).toContain('collapsed: none — every group open');
  });
});
