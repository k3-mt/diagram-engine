// P5-01 — bindings (spec §3.8): the schema, the pure resolver, V14–V17 and
// the ### Bindings section of the get-table.
//
// The resolver is the contract `diagram check --bindings` codes against, so
// these tests are the spec for the checker as much as for this file: every
// case here is one the checker must NOT have to re-decide.

import { describe, expect, it } from 'vitest';
import {
  bindingRefKind,
  collectBindings,
  formatBinding,
  GBindingSchema,
  GEdgeSchema,
  GNodeSchema,
  isUrlLike,
  MAX_BINDING_LINE,
  MAX_EDGE_BINDINGS,
  MAX_NODE_BINDINGS,
  parseBindingRef,
  summariseBindings,
  toTable,
  validate,
} from '../src/index.js';
import { doc, edge, node } from './helpers.js';

const REPO = { source: 'repo', ref: 'services/orders/' } as const;

// ---------------------------------------------------------------------------
// Schema (spec §3.8)
// ---------------------------------------------------------------------------

describe('GBinding schema', () => {
  it('accepts the three shapes §3.8 names', () => {
    for (const b of [
      { source: 'repo', ref: 'services/orders/' },
      { source: 'compose', ref: 'orders-api' },
      { source: 'terraform', ref: 'aws_ecs_service.orders' },
      { source: 'repo', ref: 'internal/pay.go', line: 412 },
    ]) {
      expect(GBindingSchema.safeParse(b).success).toBe(true);
    }
  });

  it('rejects an unknown or uppercased source', () => {
    expect(GBindingSchema.safeParse({ source: 'Compose', ref: 'x' }).success).toBe(false);
    expect(GBindingSchema.safeParse({ source: 'jira', ref: 'x' }).success).toBe(false);
  });

  it('rejects a line that is zero, negative, fractional or absurd', () => {
    for (const line of [0, -1, 1.5, MAX_BINDING_LINE + 1]) {
      expect(GBindingSchema.safeParse({ source: 'repo', ref: 'a.go', line }).success).toBe(
        false,
      );
    }
    expect(
      GBindingSchema.safeParse({ source: 'repo', ref: 'a.go', line: 1 }).success,
    ).toBe(true);
  });

  it('caps node bindings at 8 and edge bindings at 4', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ source: 'repo', ref: `s/${i}.ts` }));
    expect(
      GNodeSchema.safeParse({ ...node('a'), bindings: many(MAX_NODE_BINDINGS) }).success,
    ).toBe(true);
    expect(
      GNodeSchema.safeParse({ ...node('a'), bindings: many(MAX_NODE_BINDINGS + 1) })
        .success,
    ).toBe(false);
    expect(
      GEdgeSchema.safeParse({ ...edge('e1', 'a', 'b'), bindings: many(MAX_EDGE_BINDINGS) })
        .success,
    ).toBe(true);
    expect(
      GEdgeSchema.safeParse({
        ...edge('e1', 'a', 'b'),
        bindings: many(MAX_EDGE_BINDINGS + 1),
      }).success,
    ).toBe(false);
  });

  it('is additive: a node and an edge with no bindings still parse', () => {
    expect(GNodeSchema.safeParse(node('a')).success).toBe(true);
    expect(GEdgeSchema.safeParse(edge('e1', 'a', 'b')).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pure resolver — the half the checker does NOT have to reimplement
// ---------------------------------------------------------------------------

describe('bindingRefKind — shape decides, not source', () => {
  it('reads anything with a slash as a path', () => {
    expect(bindingRefKind('services/orders/')).toBe('path');
    expect(bindingRefKind('internal/pay.go')).toBe('path');
  });

  it('reads a bare name with a known extension as a path', () => {
    expect(bindingRefKind('Dockerfile')).toBe('path');
    expect(bindingRefKind('docker-compose.yml')).toBe('path');
    expect(bindingRefKind('go.mod')).toBe('path');
  });

  it('reads a terraform address as an identifier, not a file called .orders', () => {
    // The whole reason the extension list is an allowlist. Calling this a path
    // would make the checker report §3.8's own example as missing.
    expect(bindingRefKind('aws_ecs_service.orders')).toBe('identifier');
    expect(bindingRefKind('orders-api')).toBe('identifier');
    expect(bindingRefKind('module.payments.aws_sqs_queue.jobs')).toBe('identifier');
  });
});

describe('isUrlLike — a scheme is a scheme', () => {
  it('rejects http, https, ssh, file and scp-style git refs alike', () => {
    for (const u of [
      'https://github.com/org/repo/blob/main/a.go',
      'http://example.com',
      'ssh://git@github.com/org/repo',
      'file:///etc/passwd',
      'git@github.com:org/repo.git',
      'mailto:ops@example.com',
      's3://bucket/key',
    ]) {
      expect(isUrlLike(u)).toBe(true);
    }
  });

  it('leaves a plain path alone', () => {
    for (const p of ['services/orders/', 'internal/pay.go', 'a.b.c', 'orders-api']) {
      expect(isUrlLike(p)).toBe(false);
    }
  });
});

describe('parseBindingRef', () => {
  it('normalises "./" and duplicate slashes without touching the trailing one', () => {
    const p = parseBindingRef('./services//orders/');
    expect(p.ok).toBe(true);
    if (!p.ok || p.kind !== 'path') return;
    expect(p.normalised).toBe('services/orders/');
    expect(p.segments).toEqual(['services', 'orders']);
    expect(p.trailingSlash).toBe(true);
    expect(p.acceptsLine).toBe(false);
  });

  it('lets a file-shaped path carry a line, and never a directory', () => {
    const file = parseBindingRef('internal/pay.go');
    expect(file.ok && file.acceptsLine).toBe(true);
    const dir = parseBindingRef('internal/');
    expect(dir.ok && dir.acceptsLine).toBe(false);
    const ident = parseBindingRef('orders-api');
    expect(ident.ok && ident.acceptsLine).toBe(false);
  });

  it('does NOT guess that an extensionless path is a directory', () => {
    // Only the checker's stat can say. The pure half refuses to invent it.
    const p = parseBindingRef('services/orders');
    expect(p.ok).toBe(true);
    if (!p.ok || p.kind !== 'path') return;
    expect(p.trailingSlash).toBe(false);
  });

  it('names each way a ref cannot be resolved', () => {
    const cases: Array<[string, string]> = [
      ['https://example.com/a.go', 'url'],
      ['git@github.com:org/repo.git', 'url'],
      ['/etc/passwd', 'absolute'],
      ['~/secrets.env', 'absolute'],
      ['C:/Windows/system32', 'absolute'],
      ['../../etc/passwd', 'traversal'],
      ['services/../../etc/passwd', 'traversal'],
      ['src\\main.ts', 'backslash'],
      ['   ', 'blank'],
      ['a\nb', 'control-char'],
    ];
    for (const [ref, problem] of cases) {
      const p = parseBindingRef(ref);
      expect(p.ok, ref).toBe(false);
      if (p.ok) continue;
      expect(p.problem, ref).toBe(problem);
    }
  });
});

describe('collectBindings / summariseBindings / formatBinding', () => {
  it('spells a binding the same way the table and the checker report do', () => {
    expect(formatBinding({ source: 'repo', ref: 'services/orders/' })).toBe(
      'repo=services/orders/',
    );
    expect(formatBinding({ source: 'repo', ref: 'internal/pay.go', line: 412 })).toBe(
      'repo=internal/pay.go:412',
    );
  });

  it('walks nodes then edges in document order', () => {
    const d = doc({
      nodes: [
        node('orders', { bindings: [REPO, { source: 'compose', ref: 'orders-api' }] }),
        node('pay'),
      ],
      edges: [
        edge('e7', 'orders', 'pay', {
          bindings: [{ source: 'repo', ref: 'internal/pay.go', line: 412 }],
        }),
      ],
    });
    expect(collectBindings(d).map((b) => `${b.kind}:${b.id}:${formatBinding(b.binding)}`))
      .toEqual([
        'node:orders:repo=services/orders/',
        'node:orders:compose=orders-api',
        'edge:e7:repo=internal/pay.go:412',
      ]);
    expect(summariseBindings(d)).toEqual({ elements: 2, bindings: 3 });
    expect(summariseBindings(doc())).toEqual({ elements: 0, bindings: 0 });
  });
});

// ---------------------------------------------------------------------------
// V14–V17 (spec §3.8) — see validate.test.ts for the full message set; this
// block is the node/edge symmetry, which is the point of §3.8.
// ---------------------------------------------------------------------------

describe('V14–V17 apply to edges exactly as to nodes', () => {
  it('accepts a cited edge — the gap §3.8 exists to close', () => {
    const d = doc({
      nodes: [node('orders'), node('pay')],
      edges: [
        edge('e7', 'orders', 'pay', {
          bindings: [{ source: 'repo', ref: 'internal/pay.go', line: 412 }],
        }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('names the edge cap, not the node cap', () => {
    const d = doc({
      nodes: [node('orders'), node('pay')],
      edges: [
        edge('e7', 'orders', 'pay', {
          bindings: Array.from({ length: 5 }, (_, i) => ({
            source: 'repo' as const,
            ref: `internal/pay${i}.go`,
          })),
        }),
      ],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain('edge "e7" has 5 bindings, max 4');
  });
});

// ---------------------------------------------------------------------------
// ### Bindings in the get-table (spec §4.1)
// ---------------------------------------------------------------------------

describe('toTable — ### Bindings', () => {
  it('is absent from a document that uses no bindings', () => {
    const d = doc({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] });
    expect(toTable(d)).not.toContain('### Bindings');
  });

  it('labels node and edge rows, because the two id namespaces are different', () => {
    const d = doc({
      nodes: [node('orders', { bindings: [REPO] }), node('pay')],
      edges: [
        edge('e7', 'orders', 'pay', {
          bindings: [{ source: 'repo', ref: 'internal/pay.go', line: 412 }],
        }),
      ],
    });
    const table = toTable(d);
    expect(table).toContain('### Bindings (kind | id | source=ref)');
    expect(table).toContain('node | orders | repo=services/orders/');
    expect(table).toContain('edge | e7     | repo=internal/pay.go:412');
  });

  it('shows three bindings and counts the rest', () => {
    const d = doc({
      nodes: [
        node('orders', {
          bindings: [
            REPO,
            { source: 'compose', ref: 'orders-api' },
            { source: 'terraform', ref: 'aws_ecs_service.orders' },
            { source: 'package', ref: 'go.mod' },
            { source: 'k8s-manifest', ref: 'deploy/orders.yaml' },
          ],
        }),
      ],
    });
    const table = toTable(d);
    expect(table).toContain(
      'node | orders | repo=services/orders/, compose=orders-api, terraform=aws_ecs_service.orders (+2 more)',
    );
    expect(table).not.toContain('go.mod');
  });
});
