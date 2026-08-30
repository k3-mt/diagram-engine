// tests/checkBindings.test.ts — `diagram check --bindings` (spec §3.8, P5-02).
//
// The resolver's own tests live in core (tests/bindingsResolve.test.ts). This
// file tests the COMMAND: the exact text §3.8 specifies, the exit code CI
// reads, and the three integration decisions argued in check.ts — that
// --bindings extends `check` rather than replacing it, that plain `check` does
// not resolve, and that plain `check` still says the flag exists when the
// document has bindings to resolve.
//
// Exit codes are asserted everywhere, not just text: a checker that prints
// "missing 1" and exits 0 is a checker no CI step can use.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphPatch } from '../../core/src/index.js';
import { runCheck } from '../src/commands/check.js';
import { runPatchText } from '../src/commands/patch.js';

const cleanups: Array<() => void> = [];
const savedEnv = process.env['DIAGRAM_DIR'];

afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  if (savedEnv === undefined) delete process.env['DIAGRAM_DIR'];
  else process.env['DIAGRAM_DIR'] = savedEnv;
});

/**
 * A project: a repository-shaped tree with a .diagram/ inside it, so the
 * DEFAULT root (the parent of .diagram) is the thing under test rather than
 * something the tests always override.
 */
function project(): { root: string; dir: string; outside: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-check-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-outside-')));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.mkdirSync(path.join(root, 'internal'), { recursive: true });
  fs.writeFileSync(path.join(root, 'internal', 'pay.go'), 'a\nb\nc\nd\ne\n');
  fs.mkdirSync(path.join(root, 'services', 'orders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services:\n');

  fs.writeFileSync(path.join(outside, 'secret.txt'), 'ssh-rsa AAAA\n');
  fs.mkdirSync(path.join(root, 'links'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'links', 'escape.txt'));

  return { root, dir: path.join(root, '.diagram'), outside };
}

/** Write a patch through the shared spine, and fail loudly if it is rejected. */
function patch(dir: string, ops: GraphPatch['ops']): void {
  const out = runPatchText(JSON.stringify({ ops, summary: 'test' }), 'test', { dir });
  expect(out.stderr).toBe('');
}

const ORDERS = {
  op: 'addNode' as const,
  node: { id: 'orders', label: 'Orders', type: 'service' as const, parent: null },
};
const BILLING = {
  op: 'addNode' as const,
  node: { id: 'billing', label: 'Billing', type: 'service' as const, parent: null },
};

// ---------------------------------------------------------------------------
// What plain `check` does, and does not, do
// ---------------------------------------------------------------------------

describe('plain `diagram check` does not resolve bindings', () => {
  it('passes on a document whose citations are all broken', () => {
    // The decision this asserts: `check` answers "is this document well
    // formed", which is true of a document citing files that were deleted
    // yesterday. Making the default stat the tree would change what an
    // already-green CI step promises.
    const { dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: { ...ORDERS.node, bindings: [{ source: 'repo', ref: 'gone/nowhere.go' }] },
      },
    ]);
    const out = runCheck({ dir });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('ok — 1 node, 0 groups, 0 edges');
    expect(out.stdout).not.toContain('missing');
  });

  it('says the flag exists when the document has bindings to resolve', () => {
    // The other half of the same decision: a check nobody runs is a check that
    // does not exist, so the default advertises the flag on every run that
    // could use it.
    const { dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: {
          ...ORDERS.node,
          bindings: [
            { source: 'repo', ref: 'internal/pay.go' },
            { source: 'compose', ref: 'orders-api' },
          ],
        },
      },
    ]);
    expect(runCheck({ dir }).stdout).toContain(
      'note: 2 bindings not resolved — run `diagram check --bindings` to check them against the filesystem',
    );
  });

  it('costs an architecture-only document nothing', () => {
    // The §4.1 rule the get-table's optional sections follow: a document that
    // does not use the feature never pays a line for it.
    const { dir } = project();
    patch(dir, [ORDERS, BILLING]);
    expect(runCheck({ dir }).stdout).toBe('ok — 2 nodes, 0 groups, 0 edges');
  });
});

// ---------------------------------------------------------------------------
// The report itself (spec §3.8)
// ---------------------------------------------------------------------------

describe('`diagram check --bindings`', () => {
  it('verifies citations that resolve, and exits 0', () => {
    const { root, dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: {
          ...ORDERS.node,
          bindings: [
            { source: 'repo', ref: 'internal/pay.go', line: 5 },
            { source: 'k8s-manifest', ref: 'services/orders/' },
          ],
        },
      },
    ]);
    const out = runCheck({ dir, bindings: true });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout.split('\n')).toEqual([
      'ok — 1 node, 0 groups, 0 edges',
      '',
      'bindings — 1 element, 2 bindings',
      `root: ${root}`,
      '  ok         2',
    ]);
  });

  it('reports a missing path and a stale line in §3.8s shape, and exits 1', () => {
    const { root, dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: {
          ...ORDERS.node,
          bindings: [{ source: 'repo', ref: 'internal/pay.go' }],
        },
      },
      {
        ...BILLING,
        node: {
          ...BILLING.node,
          bindings: [{ source: 'repo', ref: 'services/billing/' }],
        },
      },
      {
        op: 'addEdge',
        edge: {
          id: 'e7',
          from: 'orders',
          to: 'billing',
          bindings: [{ source: 'repo', ref: 'internal/pay.go', line: 412 }],
        },
      },
    ]);
    const out = runCheck({ dir, bindings: true });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr.split('\n')).toEqual([
      'ok — 2 nodes, 0 groups, 1 edge',
      '',
      'bindings — 3 elements, 3 bindings',
      `root: ${root}`,
      '  ok         1',
      '  missing    1   billing    repo=services/billing/      no such path',
      '  stale      1   e7         repo=internal/pay.go:412    file has 5 lines',
      '2 citations do not resolve — fix the ref or remove the binding (rule 15: cite what you opened, nothing else)',
    ]);
  });

  it('counts an identifier separately, and never as verified', () => {
    // Reporting an unresolvable class as ok would be the same lie the whole
    // feature exists to prevent — and reporting it as missing would report
    // every correct terraform citation as broken. It is its own count.
    const { dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: {
          ...ORDERS.node,
          bindings: [
            { source: 'repo', ref: 'internal/pay.go' },
            { source: 'terraform', ref: 'aws_ecs_service.orders' },
            { source: 'compose', ref: 'orders-api' },
          ],
        },
      },
    ]);
    const out = runCheck({ dir, bindings: true });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('  ok         1');
    expect(out.stdout).toContain(
      '  unchecked  2   orders    terraform=aws_ecs_service.orders    identifier, not a path — nothing on disk to resolve',
    );
    expect(out.stdout).toContain(
      '                 orders    compose=orders-api                  identifier, not a path — nothing on disk to resolve',
    );
  });

  it('fails on a symlink that leaves the tree', () => {
    const { dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: {
          ...ORDERS.node,
          bindings: [{ source: 'repo', ref: 'links/escape.txt' }],
        },
      },
    ]);
    const out = runCheck({ dir, bindings: true });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('escaped');
    expect(out.stderr).toContain('symlink resolves outside the root');
  });

  it('says plainly that a document with no bindings has none, and exits 0', () => {
    // Not an empty report with an "ok 0" row: "nobody has cited anything" and
    // "every citation checks out" are the two states this feature exists to
    // tell apart, and a report that reads like success for both is useless.
    const { root, dir } = project();
    patch(dir, [ORDERS, BILLING]);
    const out = runCheck({ dir, bindings: true });
    expect(out.code).toBe(0);
    expect(out.stdout.split('\n')).toEqual([
      'ok — 2 nodes, 0 groups, 0 edges',
      '',
      'bindings — none in this document',
      `root: ${root}`,
      '  nothing to resolve: no node or edge cites a source file',
      '  rule 15: record a binding for each file you actually read the identifier out of',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

describe('the root a repo-relative ref resolves against', () => {
  it('defaults to the project, not to the .diagram directory', () => {
    const { root, dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: { ...ORDERS.node, bindings: [{ source: 'repo', ref: 'internal/pay.go' }] },
      },
    ]);
    // internal/pay.go exists in the project and NOT in .diagram/, so this
    // passing is the whole assertion.
    expect(runCheck({ dir, bindings: true }).code).toBe(0);
    expect(runCheck({ dir, bindings: true }).stdout).toContain(`root: ${root}`);
    expect(runCheck({ dir, root: dir }).code).toBe(1);
  });

  it('implies --bindings, because naming a root and resolving nothing means nothing', () => {
    const { root, dir } = project();
    patch(dir, [
      {
        ...ORDERS,
        node: { ...ORDERS.node, bindings: [{ source: 'repo', ref: 'gone.go' }] },
      },
    ]);
    const out = runCheck({ dir, root });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('missing');
  });
});

// ---------------------------------------------------------------------------
// Validation comes first
// ---------------------------------------------------------------------------

describe('an invalid document is not resolved', () => {
  it('reports the validation problem alone, with no binding block', () => {
    // The V13 precedent across a command boundary: V16 is what makes a ref
    // safe to join to a root at all, so resolving past a validation failure
    // reports consequences instead of the cause and sends the agent to fix
    // the wrong thing.
    const { root, dir } = project();
    patch(dir, [ORDERS]);
    const file = path.join(dir, 'graph.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      nodes: Array<Record<string, unknown>>;
      edges: unknown[];
    };
    // Hand-edited past validation, exactly as spec §4.3 path C allows: an edge
    // to a node that does not exist (V5), plus a ref V16 rejects.
    doc.nodes[0]!['bindings'] = [{ source: 'repo', ref: '../../etc/passwd' }];
    fs.writeFileSync(file, JSON.stringify(doc));

    const out = runCheck({ dir, bindings: true, root });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('invalid — 1 problem');
    expect(out.stderr).toContain('escapes the repository root');
    expect(out.stderr).not.toContain('bindings —');
  });
});
