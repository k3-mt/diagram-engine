// tests/context.test.ts — the shared command spine (spec Part 4, §4.1).
//
// Real temp directories, real locks, real history snapshots: this module is
// the only write path in the product, so nothing here is mocked. The renderer
// tests pin the exact output shapes, because those strings are the contract
// between the CLI, the MCP tools and the agent reading them.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDoc, readDoc, type GraphDoc, type GraphPatch } from '../../core/src/index.js';
import {
  applyAndCommit,
  createContext,
  discoverDir,
  ensureDoc,
  loadDoc,
  renderCounts,
  renderOk,
  renderPatchResult,
  renderRejection,
  resolveDir,
} from '../src/commands/context.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

function tempDir(prefix = 'diagram-ctx-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A context on a fresh, empty temp .diagram/ directory. */
function tempContext() {
  return createContext({ dir: path.join(tempDir(), '.diagram') });
}

function patch(ops: GraphPatch['ops'], summary = 'test'): GraphPatch {
  return { ops, summary };
}

const addApi = {
  op: 'addNode' as const,
  node: { id: 'api', label: 'API', type: 'service' as const, parent: null },
};

// ---------------------------------------------------------------------------

describe('resolveDir', () => {
  it('prefers an explicit dir, resolved to an absolute path', () => {
    const dir = tempDir();
    expect(resolveDir(dir)).toBe(path.resolve(dir));
  });

  it('falls back to DIAGRAM_DIR when no dir is given', () => {
    const dir = tempDir();
    process.env['DIAGRAM_DIR'] = dir;
    expect(resolveDir()).toBe(path.resolve(dir));
    expect(resolveDir('')).toBe(path.resolve(dir));
  });

  it('falls back to <cwd>/.diagram when neither is set', () => {
    delete process.env['DIAGRAM_DIR'];
    expect(resolveDir()).toBe(path.join(process.cwd(), '.diagram'));
  });

  it('createContext exposes every store path under that directory', () => {
    const ctx = tempContext();
    expect(ctx.paths.graphFile).toBe(path.join(ctx.dir, 'graph.json'));
    expect(ctx.paths.lockFile).toBe(path.join(ctx.dir, '.lock'));
    expect(ctx.paths.historyDir).toBe(path.join(ctx.dir, 'history'));
    // Resolution alone must not create anything on disk.
    expect(fs.existsSync(ctx.dir)).toBe(false);
  });
});

describe('loadDoc / ensureDoc', () => {
  it('a project with no graph.json loads the empty document', () => {
    const r = loadDoc(tempContext());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.existed).toBe(false);
    expect(r.doc).toEqual(emptyDoc());
  });

  it('a broken graph.json is an error, not an empty document', () => {
    const ctx = tempContext();
    fs.mkdirSync(ctx.dir, { recursive: true });
    fs.writeFileSync(ctx.paths.graphFile, '{ not json', 'utf8');
    const r = loadDoc(ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('not valid JSON');
  });

  it('ensureDoc seeds an empty document and is idempotent', () => {
    const ctx = tempContext();
    expect(ensureDoc(ctx)).toEqual(emptyDoc());
    expect(fs.existsSync(ctx.paths.graphFile)).toBe(true);

    applyAndCommit(ctx, patch([addApi]));
    // Second call must not wipe what is already there.
    expect(ensureDoc(ctx).nodes).toHaveLength(1);
  });
});

describe('applyAndCommit', () => {
  it('writes graph.json, seeds history, and reports the summary', () => {
    const ctx = tempContext();
    const r = applyAndCommit(ctx, patch([addApi]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.summary).toBe('+1 node');
    expect(r.notes).toEqual([]);
    expect(r.history).toBe(1); // 0000 is the pre-patch base state

    const onDisk = readDoc(ctx.paths.graphFile);
    expect(onDisk.ok).toBe(true);
    if (!onDisk.ok) return;
    expect(onDisk.doc.nodes.map((n) => n.id)).toEqual(['api']);

    // The base snapshot exists, so this patch can be undone.
    expect(fs.existsSync(path.join(ctx.paths.historyDir, '0000.json'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.paths.historyDir, '0001.json'))).toBe(true);
  });

  it('applies to what is on disk, not to a stale in-memory copy', () => {
    const ctx = tempContext();
    applyAndCommit(ctx, patch([addApi]));
    const r = applyAndCommit(
      ctx,
      patch([
        {
          op: 'addNode',
          node: { id: 'db', label: 'DB', type: 'database', parent: null },
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.nodes.map((n) => n.id)).toEqual(['api', 'db']);
    expect(r.history).toBe(2);
  });

  it('a rejected patch leaves graph.json untouched', () => {
    const ctx = tempContext();
    applyAndCommit(ctx, patch([addApi]));
    const before = fs.readFileSync(ctx.paths.graphFile, 'utf8');

    const r = applyAndCommit(
      ctx,
      patch([{ op: 'addEdge', edge: { id: 'e1', from: 'api', to: 'redis' } }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('unknown node "redis"');
    expect(fs.readFileSync(ctx.paths.graphFile, 'utf8')).toBe(before);
  });

  it('releases the lock, so a second call succeeds immediately', () => {
    const ctx = tempContext();
    applyAndCommit(ctx, patch([addApi]));
    expect(fs.existsSync(ctx.paths.lockFile)).toBe(false);
    const started = Date.now();
    const r = applyAndCommit(ctx, patch([{ op: 'setTitle', title: 'Checkout' }]));
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000); // not waiting on a stale lock
  });

  it('surfaces the §3.5 coercion notes', () => {
    const ctx = tempContext();
    applyAndCommit(ctx, patch([addApi]));
    const r = applyAndCommit(
      ctx,
      patch([
        {
          op: 'addNode',
          node: { id: 'api', label: 'API gateway', type: 'service', parent: null },
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notes).toEqual(['coerced addNode "api" to updateNode (id exists)']);
    expect(r.doc.nodes).toHaveLength(1);
    expect(r.doc.nodes[0]?.label).toBe('API gateway');
  });
});

// ---------------------------------------------------------------------------
// The two output shapes (spec §4.1)
// ---------------------------------------------------------------------------

function docOf(nodes: number, groups: number, edges: number): GraphDoc {
  const d = emptyDoc();
  for (let i = 0; i < nodes; i += 1) {
    d.nodes.push({ id: `n${i}`, label: `N${i}`, type: 'service', parent: null });
  }
  for (let i = 0; i < groups; i += 1) {
    d.groups.push({ id: `g${i}`, label: `G${i}`, kind: 'generic', parent: null });
  }
  for (let i = 0; i < edges; i += 1) {
    d.edges.push({ id: `e${i}`, from: 'n0', to: `n${i + 1}` });
  }
  return d;
}

describe('renderOk', () => {
  it('is two lines when nothing was coerced', () => {
    const out = renderOk({ doc: docOf(11, 2, 9), summary: '+3 nodes, +2 edges' });
    expect(out).toBe('ok — +3 nodes, +2 edges\ngraph: 11 nodes, 2 groups, 9 edges');
  });

  it('adds the notes line when a coercion happened', () => {
    const out = renderOk({
      doc: docOf(11, 2, 9),
      summary: '+3 nodes, +2 edges',
      notes: ['coerced addNode "auth" to updateNode (id exists)'],
    });
    expect(out.split('\n')).toEqual([
      'ok — +3 nodes, +2 edges',
      'graph: 11 nodes, 2 groups, 9 edges',
      'notes: coerced addNode "auth" to updateNode (id exists)',
    ]);
  });

  it('joins several notes onto the one line', () => {
    const out = renderOk({ doc: docOf(1, 0, 0), summary: 'updated', notes: ['a', 'b'] });
    expect(out).toContain('notes: a; b');
  });

  it('an empty notes array prints no notes line', () => {
    const out = renderOk({ doc: docOf(1, 0, 0), summary: '+1 node', notes: [] });
    expect(out).not.toContain('notes:');
  });

  it('counts are singular when there is one of something', () => {
    expect(renderCounts(docOf(1, 1, 1))).toBe('1 node, 1 group, 1 edge');
    expect(renderCounts(emptyDoc())).toBe('0 nodes, 0 groups, 0 edges');
  });
});

describe('renderRejection', () => {
  it('heads with the no-changes guarantee and indents each op error', () => {
    const out = renderRejection([
      'op 2 (addEdge): edge "e7" references unknown node "redis". Did you mean "redis-cache"?',
      'op 4 (addNode): invalid id "Order Service": use lowercase-hyphenated',
    ]);
    expect(out.split('\n')).toEqual([
      'rejected — no changes applied',
      '  op 2 (addEdge): edge "e7" references unknown node "redis". Did you mean "redis-cache"?',
      '  op 4 (addNode): invalid id "Order Service": use lowercase-hyphenated',
    ]);
  });

  it('never renders a bare headline with no reason', () => {
    expect(renderRejection([])).toBe('rejected — no changes applied\n  unknown error');
  });
});

describe('renderPatchResult', () => {
  it('picks the shape from the result, end to end', () => {
    const ctx = tempContext();
    expect(renderPatchResult(applyAndCommit(ctx, patch([addApi])))).toBe(
      'ok — +1 node\ngraph: 1 node, 0 groups, 0 edges',
    );
    const bad = applyAndCommit(
      ctx,
      patch([{ op: 'removeNode', id: 'ghost' }]),
    );
    const out = renderPatchResult(bad);
    expect(out.startsWith('rejected — no changes applied\n  op 0 (removeNode): ')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M6 audit fixes — where a command works, and what it refuses to overwrite.
// ---------------------------------------------------------------------------

describe('discoverDir — an existing .diagram/ above the working directory', () => {
  it('finds the project document from a subdirectory', () => {
    const root = tempDir('diagram-walk-');
    fs.mkdirSync(path.join(root, '.diagram'), { recursive: true });
    const deep = path.join(root, 'src', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    expect(discoverDir(deep)).toBe(path.join(root, '.diagram'));
  });

  it('stops at a repository root rather than escaping the project', () => {
    const outer = tempDir('diagram-walk-');
    fs.mkdirSync(path.join(outer, '.diagram'), { recursive: true });
    const repo = path.join(outer, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const inside = path.join(repo, 'src');
    fs.mkdirSync(inside, { recursive: true });
    // The outer .diagram/ belongs to a different project; it must not be found.
    expect(discoverDir(inside)).toBeUndefined();
  });

  it('returns undefined when there is nothing to find', () => {
    const root = tempDir('diagram-walk-');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    expect(discoverDir(root)).toBeUndefined();
  });

  it('createContext uses it, and marks a genuinely fresh location as defaulted', () => {
    // realpath: on macOS the temp dir is under a /var -> /private/var symlink,
    // and process.cwd() reports the resolved path.
    const root = fs.realpathSync(tempDir('diagram-walk-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.diagram'), { recursive: true });
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });

    const cwd = process.cwd();
    delete process.env['DIAGRAM_DIR'];
    try {
      process.chdir(deep);
      // Found above: the project's own document, not a second one under a/b.
      const found = createContext();
      expect(found.dir).toBe(path.join(root, '.diagram'));
      expect(found.defaulted).toBe(false);

      // Explicit --dir still wins outright.
      const explicit = createContext({ dir: path.join(deep, '.diagram') });
      expect(explicit.dir).toBe(path.join(deep, '.diagram'));
    } finally {
      process.chdir(cwd);
    }
  });

  it('a patch into a brand-new defaulted location says where it landed', () => {
    const root = fs.realpathSync(tempDir('diagram-walk-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const cwd = process.cwd();
    delete process.env['DIAGRAM_DIR'];
    try {
      process.chdir(root);
      const ctx = createContext();
      expect(ctx.defaulted).toBe(true);
      const r = applyAndCommit(ctx, patch([addApi]));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.notes.join('\n')).toContain('created a new diagram at');
      // ...and an ordinary second patch does not repeat itself.
      const again = applyAndCommit(createContext(), patch([{ op: 'setTitle', title: 'X' }]));
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.notes).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('ensureDoc never overwrites a document it cannot read', () => {
  it('leaves a corrupt graph.json exactly as it found it', () => {
    const ctx = tempContext();
    fs.mkdirSync(ctx.dir, { recursive: true });
    fs.writeFileSync(ctx.paths.graphFile, '{ hand-edited into nonsense', 'utf8');
    const before = fs.readFileSync(ctx.paths.graphFile);
    ensureDoc(ctx);
    expect(fs.readFileSync(ctx.paths.graphFile).equals(before)).toBe(true);
  });
});

describe('the rejection roster covers the ids the validator actually checks', () => {
  it('lists the groups too when an EDGE endpoint is unknown', () => {
    const ctx = tempContext();
    applyAndCommit(
      ctx,
      patch([
        { op: 'addGroup', group: { id: 'vpc-private', label: 'VPC', kind: 'vpc', parent: null } },
        addApi,
      ]),
    );
    const r = applyAndCommit(
      ctx,
      patch([{ op: 'addEdge', edge: { id: 'e1', from: 'api', to: 'vpc-priv' } }]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join('\n');
    // The message already suggests a group; the roster must not then imply
    // that a group is not a legal endpoint (rule 11 says to trust the roster).
    expect(text).toContain('Did you mean "vpc-private"?');
    expect(text).toContain('known node ids: api');
    expect(text).toContain('known group ids (an edge may point at a group): vpc-private');
  });

  it('does not give edge advice for a node error that has nothing to do with an edge', () => {
    const r = applyAndCommit(tempContext(), patch([{ op: 'removeNode', id: 'zz' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join('\n');
    expect(text).toContain('op 0 (removeNode): unknown node "zz".');
    expect(text).not.toContain('before the edge that uses it');
  });
});
