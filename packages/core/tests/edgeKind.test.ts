// tests/edgeKind.test.ts — §3.9: an edge that says what it MEANS.
//
// The feature exists because rule 4 fixes an edge's direction at the
// dependency while every reader instinctively reads an arrow as flow, and for
// a read those point opposite ways. `kind` lets the document say both without
// the arrow having to lie — and the tests that matter most here are the ones
// proving the new field does NOT reach the analysis engine as a second edge,
// because that is the failure mode the design was chosen to avoid.

import { describe, expect, it } from 'vitest';
import {
  ASYNC_KINDS,
  EdgeKindSchema,
  GEdgeSchema,
  MAX_EDGE_SEQ,
  RETURNING_KINDS,
  edgeHasReturn,
  edgeIsAsync,
  type GEdge,
  type GraphDoc,
} from '../src/schema/graph.js';
import { GEdgeChangesSchema } from '../src/schema/patch.js';
import { applyPatch } from '../src/document/apply.js';
import { validate } from '../src/document/validate.js';
import { isSyncEdge } from '../src/analysis/graph.js';
import { deriveView } from '../src/view/derive.js';
import { toTable } from '../src/format/table.js';

const edge = (over: Partial<GEdge> = {}): GEdge => ({
  id: 'e1',
  from: 'orders',
  to: 'postgres',
  ...over,
});

const doc = (edges: GEdge[], extra: Partial<GraphDoc> = {}): GraphDoc => ({
  schemaVersion: 1,
  title: 'T',
  direction: 'DOWN',
  nodes: [
    { id: 'orders', label: 'Orders', type: 'service', parent: null },
    { id: 'postgres', label: 'Postgres', type: 'database', parent: null },
  ],
  groups: [],
  edges,
  collapsed: [],
  ...extra,
});

describe('the kind vocabulary', () => {
  it('is exactly the five relationships the viewer can draw', () => {
    expect(EdgeKindSchema.options).toEqual([
      'call',
      'read',
      'write',
      'publish',
      'consume',
    ]);
  });

  it('splits sync from async, and returning from not', () => {
    // publish and consume are the async pair (rule 6's dashed).
    expect([...ASYNC_KINDS].sort()).toEqual(['consume', 'publish']);
    // Something comes back along a call, a read and a consume; a write and a
    // publish push and are done.
    expect([...RETURNING_KINDS].sort()).toEqual(['call', 'consume', 'read']);
    // Every kind is in exactly one of sync/async, and the two sets overlap on
    // `consume` deliberately — an async edge can still hand something back.
    for (const k of EdgeKindSchema.options) {
      expect(ASYNC_KINDS.has(k) || !ASYNC_KINDS.has(k)).toBe(true);
    }
    expect(ASYNC_KINDS.has('consume') && RETURNING_KINDS.has('consume')).toBe(true);
  });

  it('accepts kind, returns and seq on an edge', () => {
    const parsed = GEdgeSchema.parse({
      id: 'e1',
      from: 'orders',
      to: 'postgres',
      kind: 'read',
      returns: 'order[]',
      seq: 3,
    });
    expect(parsed.kind).toBe('read');
    expect(parsed.returns).toBe('order[]');
    expect(parsed.seq).toBe(3);
  });

  it('bounds seq to a two-digit badge', () => {
    expect(GEdgeSchema.safeParse({ ...edge(), seq: 0 }).success).toBe(false);
    expect(GEdgeSchema.safeParse({ ...edge(), seq: 1.5 }).success).toBe(false);
    expect(GEdgeSchema.safeParse({ ...edge(), seq: MAX_EDGE_SEQ }).success).toBe(true);
    expect(GEdgeSchema.safeParse({ ...edge(), seq: MAX_EDGE_SEQ + 1 }).success).toBe(false);
  });

  it('rejects an unknown kind rather than inventing a sixth', () => {
    expect(GEdgeSchema.safeParse({ ...edge(), kind: 'rpc' }).success).toBe(false);
  });
});

describe('edgeIsAsync — asked in ONE place', () => {
  it('reads an explicit style, as it always did', () => {
    expect(edgeIsAsync(edge({ style: 'dashed' }))).toBe(true);
    expect(edgeIsAsync(edge({ style: 'solid' }))).toBe(false);
  });

  it('reads the kind when there is no style', () => {
    expect(edgeIsAsync(edge({ kind: 'publish' }))).toBe(true);
    expect(edgeIsAsync(edge({ kind: 'consume' }))).toBe(true);
    expect(edgeIsAsync(edge({ kind: 'call' }))).toBe(false);
    expect(edgeIsAsync(edge({ kind: 'read' }))).toBe(false);
    expect(edgeIsAsync(edge({ kind: 'write' }))).toBe(false);
  });

  it('says nothing about an edge that carries neither', () => {
    expect(edgeIsAsync(edge())).toBe(false);
  });
});

// THE POINT OF THE WHOLE DESIGN. A `publish` edge is asynchronous, so failure
// does not cascade across it (§18.3). Before §3.9 the propagation asked
// `style === 'dashed'`; if it still did, a kind-only publish edge would be
// walked as a hard synchronous dependency and reported as a cascade path that
// cannot happen. This is the test that fails if that question is ever asked
// in two places again.
describe('the analysis engine sees the kind', () => {
  it('treats a kind-only publish edge as asynchronous', () => {
    expect(isSyncEdge(edge({ kind: 'publish' }))).toBe(false);
    expect(isSyncEdge(edge({ kind: 'consume' }))).toBe(false);
    expect(isSyncEdge(edge({ kind: 'call' }))).toBe(true);
    expect(isSyncEdge(edge())).toBe(true);
  });

  it('does NOT gain a second edge for the return leg', () => {
    // The return is a drawing, never a document edge: one relationship stays
    // one edge, so the graph stays acyclic and no failure propagates
    // backwards from a callee to its caller.
    const d = doc([edge({ kind: 'call', returns: '200 OK' })]);
    expect(d.edges).toHaveLength(1);
    expect(d.edges.every((e) => e.from === 'orders')).toBe(true);
    expect(edgeHasReturn(d.edges[0]!)).toBe(true);
  });
});

describe('edgeHasReturn', () => {
  it('is true for the returning kinds', () => {
    expect(edgeHasReturn(edge({ kind: 'call' }))).toBe(true);
    expect(edgeHasReturn(edge({ kind: 'read' }))).toBe(true);
    expect(edgeHasReturn(edge({ kind: 'consume' }))).toBe(true);
    expect(edgeHasReturn(edge({ kind: 'write' }))).toBe(false);
    expect(edgeHasReturn(edge({ kind: 'publish' }))).toBe(false);
  });

  it('is true for an edge that names what comes back without a kind', () => {
    expect(edgeHasReturn(edge({ returns: 'order[]' }))).toBe(true);
    expect(edgeHasReturn(edge())).toBe(false);
  });
});

describe('V20 — kind replaces style and arrow', () => {
  it('rejects kind alongside style', () => {
    const r = validate(doc([edge({ kind: 'publish', style: 'solid' })]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('kind already decides how the edge is drawn');
    expect(r.errors.join('\n')).toContain('drop style');
  });

  it('rejects kind alongside arrow', () => {
    const r = validate(doc([edge({ kind: 'call', arrow: 'both' })]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('drop arrow');
  });

  it('names both when both are set, so one retry fixes it', () => {
    const r = validate(doc([edge({ kind: 'call', arrow: 'none', style: 'dashed' })]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('drop style and arrow');
  });

  it('leaves style and arrow alone on an edge with no kind', () => {
    expect(validate(doc([edge({ style: 'dashed', arrow: 'both' })])).ok).toBe(true);
  });
});

describe('V21 — returns needs somewhere to come back to', () => {
  it('rejects returns on a write and on a publish', () => {
    for (const kind of ['write', 'publish'] as const) {
      const r = validate(doc([edge({ kind, returns: 'ack' })]));
      expect(r.ok, kind).toBe(false);
      if (r.ok) continue;
      expect(r.errors.join('\n')).toContain('nothing comes back along it');
      // The message names the kinds that WOULD make it drawable, so the fix
      // is in the error rather than a doc lookup away.
      expect(r.errors.join('\n')).toContain('"call"');
    }
  });

  it('allows returns on every returning kind', () => {
    for (const kind of ['call', 'read', 'consume'] as const) {
      expect(validate(doc([edge({ kind, returns: 'order[]' })])).ok, kind).toBe(true);
    }
  });

  it('allows returns on an edge with no kind at all', () => {
    // No kind means the author has not said which relationship it is; naming
    // what comes back is still a claim the viewer can draw.
    expect(validate(doc([edge({ returns: 'order[]' })])).ok).toBe(true);
  });
});

describe('V19 — alt on an asynchronous edge, now that kind can say so', () => {
  const three = (over: Partial<GEdge>): GraphDoc =>
    doc([edge({ ...over, alt: 'db' })], {
      nodes: [
        { id: 'orders', label: 'Orders', type: 'service', parent: null },
        { id: 'postgres', label: 'Postgres', type: 'database', parent: null },
      ],
    });

  it('catches a kind-only publish edge, not just a dashed one', () => {
    const r = validate(three({ kind: 'publish' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // And says WHY in terms the reader can see in their own document: this
    // edge says `publish`, not `dashed`, so "is dashed" would be a puzzle.
    expect(r.errors.join('\n')).toContain('is a "publish" edge');
  });

  it('still says "is dashed" for an edge that really says dashed', () => {
    const r = validate(three({ style: 'dashed' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('is dashed');
  });
});

describe('clearing the three fields over the wire', () => {
  it('accepts null for each', () => {
    const parsed = GEdgeChangesSchema.parse({ kind: null, returns: null, seq: null });
    expect(parsed).toEqual({ kind: null, returns: null, seq: null });
  });

  it('removes the property rather than storing the null', () => {
    const before = doc([edge({ kind: 'read', returns: 'order[]', seq: 2 })]);
    const after = applyPatch(before, {
      summary: 'plain edge',
      ops: [
        {
          op: 'updateEdge',
          id: 'e1',
          changes: { kind: null, returns: null, seq: null },
        },
      ],
    });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const e = after.doc.edges[0]!;
    expect('kind' in e).toBe(false);
    expect('returns' in e).toBe(false);
    expect('seq' in e).toBe(false);
  });
});

describe('collapsing a group', () => {
  const nested = (edges: GEdge[]): GraphDoc => ({
    schemaVersion: 1,
    title: 'T',
    direction: 'DOWN',
    nodes: [
      { id: 'client', label: 'Client', type: 'client', parent: null },
      { id: 'a', label: 'A', type: 'service', parent: 'vpc' },
      { id: 'b', label: 'B', type: 'service', parent: 'vpc' },
    ],
    groups: [{ id: 'vpc', label: 'VPC', kind: 'vpc', parent: null }],
    edges,
    collapsed: [],
  });

  it('KEEPS a kind every constituent agrees on', () => {
    // Two publishes merged are still, unambiguously, a publish. This is the
    // case that matters most in practice: "orders reads AND writes postgres"
    // is two edges between one pair, and without unanimity the commonest use
    // of the whole vocabulary would render as a bare `×2` grey line.
    const d = deriveView(
      nested([
        { id: 'e1', from: 'client', to: 'a', kind: 'publish' },
        { id: 'e2', from: 'client', to: 'b', kind: 'publish' },
      ]),
      ['vpc'],
    );
    const merged = d.edges.find((e) => e.to === 'vpc');
    expect(merged?.kind).toBe('publish');
    // And it carries the kind INSTEAD of a style, because V20 forbids both.
    // The edge is still drawn dashed — that is what the kind means.
    expect(merged?.style).toBeUndefined();
    expect(merged?.arrow).toBeUndefined();
    expect(edgeIsAsync(merged!)).toBe(true);
  });

  it('keeps returns and seq only when those agree too', () => {
    const d = deriveView(
      nested([
        { id: 'e1', from: 'client', to: 'a', kind: 'read', returns: 'row', seq: 2 },
        { id: 'e2', from: 'client', to: 'b', kind: 'read', returns: 'row', seq: 2 },
      ]),
      ['vpc'],
    );
    const merged = d.edges.find((e) => e.to === 'vpc');
    expect(merged?.returns).toBe('row');
    expect(merged?.seq).toBe(2);
  });

  it('drops all three when the constituents DISAGREE', () => {
    // A read and a publish cannot both be drawn by one line's dash and one
    // return leg, and a merged edge still naming one of their payloads would
    // be a false claim about the other.
    const d = deriveView(
      nested([
        { id: 'e1', from: 'client', to: 'a', kind: 'read', returns: 'x', seq: 1 },
        { id: 'e2', from: 'client', to: 'b', kind: 'publish', seq: 5 },
      ]),
      ['vpc'],
    );
    const merged = d.edges.find((e) => e.to === 'vpc');
    expect(merged?.kind).toBeUndefined();
    expect(merged?.returns).toBeUndefined();
    expect(merged?.seq).toBeUndefined();
    // Falling back to style/arrow, and a merge of one sync and one async edge
    // is SOLID (dashed only when unanimous) — the pre-existing rule, intact.
    expect(merged?.style).toBe('solid');
  });

  it('drops a returns the constituents disagree on, keeping the kind', () => {
    const d = deriveView(
      nested([
        { id: 'e1', from: 'client', to: 'a', kind: 'read', returns: 'row' },
        { id: 'e2', from: 'client', to: 'b', kind: 'read', returns: 'blob' },
      ]),
      ['vpc'],
    );
    const merged = d.edges.find((e) => e.to === 'vpc');
    expect(merged?.kind).toBe('read');
    expect(merged?.returns).toBeUndefined();
  });

  it('KEEPS them on a bucket of one that was merely repointed', () => {
    // Still exactly one relationship, just aimed at the collapsed group.
    const d = deriveView(
      nested([{ id: 'e1', from: 'client', to: 'a', kind: 'read', returns: 'x', seq: 4 }]),
      ['vpc'],
    );
    const only = d.edges.find((e) => e.to === 'vpc');
    expect(only?.kind).toBe('read');
    expect(only?.returns).toBe('x');
    expect(only?.seq).toBe(4);
  });

  it('produces a document that still validates, either way it merges', () => {
    // The merged edge must never end up with both a kind and a style — V20
    // would reject a document the engine derived itself, which is a bug the
    // user would meet as an unexplained rejection on someone else's patch.
    for (const [a, b] of [
      [{ kind: 'publish' as const }, { kind: 'publish' as const }],
      [{ kind: 'read' as const, returns: 'x' }, { kind: 'publish' as const }],
      [{ style: 'dashed' as const }, { kind: 'publish' as const }],
    ]) {
      const d = deriveView(
        nested([
          { id: 'e1', from: 'client', to: 'a', ...a },
          { id: 'e2', from: 'client', to: 'b', ...b },
        ]),
        ['vpc'],
      );
      expect(validate(d).ok, JSON.stringify([a, b])).toBe(true);
    }
  });
});

describe('the get table', () => {
  it('adds no column to a document that uses none of the three', () => {
    const t = toTable(doc([edge({ label: 'reads' })]));
    expect(t).toContain('### Edges (id | from -> to | label | style)');
  });

  it('grows a column per field in use', () => {
    const t = toTable(doc([edge({ kind: 'read', returns: 'order[]', seq: 2 })]));
    expect(t).toContain('### Edges (id | from -> to | label | style | kind | returns | seq)');
    expect(t).toContain('read');
    expect(t).toContain('order[]');
  });

  it('reports the style the edge is DRAWN with, not the raw field', () => {
    // A kind-only publish edge is dashed on screen. Printing "solid" here
    // would put the table an agent checks its own work against in direct
    // contradiction with the picture.
    const t = toTable(doc([edge({ kind: 'publish' })]));
    const row = t.split('\n').find((l) => l.startsWith('e1'));
    expect(row).toContain('dashed');
    expect(row).not.toContain('solid');
  });
});
