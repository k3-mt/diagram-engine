// tests/derive.test.ts — the collapse-and-merge pass (spec Part 7).
//
// The four things that are easy to get wrong and expensive to notice late:
// descendants really disappear, parallel edges really merge with a count,
// edges that became internal really vanish, and the input document is really
// untouched. Nested collapse and idempotence are here for the same reason —
// the spec sketch handles neither, so both are pinned.

import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_META_KEY,
  COLLAPSED_NODE_TYPE,
  collapsedGroupKind,
  deriveView,
  deriveViewDetail,
  descendantsOf,
  isCollapsedGroupNode,
} from '../src/view/derive.js';
import { validate } from '../src/document/validate.js';
import { GraphDocSchema, type GraphDoc } from '../src/schema/graph.js';
import { doc, edge, fixtureJson, group, node } from './helpers.js';

/** A fixture, parsed and typed. */
function fixture(name: string): GraphDoc {
  return GraphDocSchema.parse(fixtureJson(name));
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const find = <T extends { id: string }>(xs: T[], id: string): T | undefined =>
  xs.find((x) => x.id === id);
/** find(), but fails the test rather than the type checker when it is missing. */
function mustFind<T extends { id: string }>(xs: T[], id: string): T {
  const hit = find(xs, id);
  if (hit === undefined) throw new Error(`expected an element with id "${id}"`);
  return hit;
}

describe('descendantsOf', () => {
  it('collects nodes and nested groups at any depth', () => {
    const d = fixture('nested-two-deep.json');
    expect(descendantsOf(d, 'region-eu').sort()).toEqual(
      ['api-gateway', 'auth-service', 'orders-service', 'postgres', 'vpc-private'].sort(),
    );
    expect(descendantsOf(d, 'vpc-private').sort()).toEqual(
      ['auth-service', 'orders-service', 'postgres'].sort(),
    );
  });

  it('is empty for a childless group and for an unknown id', () => {
    const d = doc({ groups: [group('empty-vpc', { kind: 'vpc' })] });
    expect(descendantsOf(d, 'empty-vpc')).toEqual([]);
    expect(descendantsOf(d, 'no-such-group')).toEqual([]);
  });
});

describe('no collapse is the identity', () => {
  it('returns an equal document for an empty collapsed list', () => {
    const d = fixture('cross-boundary-edges.json');
    expect(deriveView(d, [])).toEqual(d);
  });

  it('defaults to the document own collapsed list', () => {
    const d = fixture('cross-boundary-edges.json');
    expect(deriveView(d)).toEqual(d);
    expect(deriveView({ ...d, collapsed: ['vpc-private'] })).toEqual(
      deriveView(d, ['vpc-private']),
    );
  });

  it('leaves an empty document alone', () => {
    expect(deriveView(doc(), [])).toEqual(doc());
  });
});

describe('single collapse', () => {
  const base = () => fixture('cross-boundary-edges.json');

  it('replaces the group and every descendant with one node', () => {
    const v = deriveView(base(), ['vpc-private']);

    expect(v.groups).toEqual([]);
    for (const gone of ['postgres', 'kafka', 'fulfilment-worker']) {
      expect(find(v.nodes, gone)).toBeUndefined();
    }
    const box = find(v.nodes, 'vpc-private');
    expect(box).toBeDefined();
    expect(box?.label).toBe('Private VPC');
    expect(box?.parent).toBeNull();
    expect(box?.note).toBe('3 components');
  });

  it('draws the stand-in as a neutral box tagged with the group kind', () => {
    const v = deriveView(base(), ['vpc-private']);
    const box = mustFind(v.nodes, 'vpc-private');
    expect(box.type).toBe(COLLAPSED_NODE_TYPE);
    expect(box.type).not.toBe('service'); // the sketch lied; we do not
    expect(box.meta?.[COLLAPSED_META_KEY]).toBe('vpc');
    expect(isCollapsedGroupNode(box)).toBe(true);
    expect(collapsedGroupKind(box)).toBe('vpc');
    expect(isCollapsedGroupNode(mustFind(v.nodes, 'api-gateway'))).toBe(false);
  });

  it('produces a document that still validates and still parses', () => {
    const v = deriveView(base(), ['vpc-private']);
    expect(validate(v)).toEqual({ ok: true });
    expect(() => GraphDocSchema.parse(v)).not.toThrow();
  });

  it('records the collapsed list it was asked for', () => {
    expect(deriveView(base(), ['vpc-private']).collapsed).toEqual(['vpc-private']);
  });
});

describe('edge rewriting and merging', () => {
  const base = () => fixture('cross-boundary-edges.json');

  it('merges parallel edges into one, labelled with the count', () => {
    const v = deriveView(base(), ['vpc-private']);
    // auth-service -> postgres, orders-service -> postgres and
    // orders-service -> kafka, auth-service -> kafka all rewrite to
    // (auth|orders)-service -> vpc-private.
    const authEdges = v.edges.filter(
      (e) => e.from === 'auth-service' && e.to === 'vpc-private',
    );
    expect(authEdges).toHaveLength(1);
    expect(authEdges[0]?.label).toBe('×2'); // "reads" and "audit events" disagree

    const orderEdges = v.edges.filter(
      (e) => e.from === 'orders-service' && e.to === 'vpc-private',
    );
    expect(orderEdges).toHaveLength(1);
    expect(orderEdges[0]?.label).toBe('×2');
  });

  it('keeps the shared verb when every merged edge agrees', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [
        node('api'),
        node('a', { parent: 'vpc' }),
        node('b', { parent: 'vpc' }),
        node('c', { parent: 'vpc' }),
      ],
      edges: [
        edge('e1', 'api', 'a', { label: 'reads' }),
        edge('e2', 'api', 'b', { label: 'reads' }),
        edge('e3', 'api', 'c', { label: 'reads' }),
      ],
    });
    const v = deriveView(d, ['vpc']);
    expect(v.edges).toHaveLength(1);
    expect(v.edges[0]?.label).toBe('reads ×3');
    expect(v.edges[0]?.id).toBe('e1'); // first constituent's id
  });

  it('truncates a long shared label so the merged one stays in bounds', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('api'), node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [
        edge('e1', 'api', 'a', { label: 'writes audit records' }),
        edge('e2', 'api', 'b', { label: 'writes audit records' }),
      ],
    });
    const v = deriveView(d, ['vpc']);
    const label = v.edges[0]?.label ?? '';
    expect(label.length).toBeLessThanOrEqual(24);
    expect(label.endsWith('×2')).toBe(true);
    expect(validate(v)).toEqual({ ok: true });
  });

  it('resolves style and arrow when merged edges disagree', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('api'), node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [
        edge('e1', 'api', 'a', { style: 'dashed', arrow: 'none' }),
        edge('e2', 'api', 'b', { style: 'solid', arrow: 'forward' }),
      ],
    });
    const v = deriveView(d, ['vpc']);
    expect(v.edges[0]?.style).toBe('solid'); // dashed only when unanimous
    expect(v.edges[0]?.arrow).toBe('forward'); // union of what is drawn
  });

  it('keeps dashed when every merged edge is dashed', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('api'), node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [
        edge('e1', 'api', 'a', { style: 'dashed' }),
        edge('e2', 'api', 'b', { style: 'dashed' }),
      ],
    });
    expect(deriveView(d, ['vpc']).edges[0]?.style).toBe('dashed');
  });

  it('leaves an untouched edge byte-identical', () => {
    const d = fixture('cross-boundary-edges.json');
    const v = deriveView(d, ['vpc-private']);
    expect(find(v.edges, 'e1')).toEqual(find(d.edges, 'e1'));
  });

  it('drops an edge that became internal to the collapsed group', () => {
    const d = fixture('cross-boundary-edges.json');
    const v = deriveView(d, ['vpc-private']);
    // e8 was kafka -> fulfilment-worker, both inside the vpc.
    expect(find(v.edges, 'e8')).toBeUndefined();
    for (const e of v.edges) expect(e.from).not.toBe(e.to);
  });

  it('reports which original edges each drawn edge stands for', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('api'), node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [edge('e1', 'api', 'a'), edge('e2', 'api', 'b'), edge('e3', 'a', 'b')],
    });
    const detail = deriveViewDetail(d, ['vpc']);
    expect(detail.edges).toEqual([{ id: 'e1', sources: ['e1', 'e2'] }]);
    expect(detail.collapsedGroups).toEqual(['vpc']);
    expect(detail.hidden.sort()).toEqual(['a', 'b']);
  });
});

describe('an edge aimed at the collapsed group itself', () => {
  const base = () =>
    doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('api'), node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [
        edge('e1', 'api', 'vpc', { label: 'calls' }),
        edge('e2', 'api', 'a', { label: 'calls' }),
        edge('e3', 'b', 'vpc', { label: 'registers' }),
      ],
    });

  it('survives and merges with the edges rewritten out of the group', () => {
    const v = deriveView(base(), ['vpc']);
    const drawn = v.edges.filter((e) => e.from === 'api' && e.to === 'vpc');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.label).toBe('calls ×2');
  });

  it('drops an edge from inside the group to the group itself', () => {
    const v = deriveView(base(), ['vpc']);
    expect(find(v.edges, 'e3')).toBeUndefined();
    expect(v.edges).toHaveLength(1);
  });

  it('leaves such an edge alone when nothing is collapsed', () => {
    const d = base();
    expect(deriveView(d, []).edges).toEqual(d.edges);
  });
});

describe('nested collapse: the outer group wins', () => {
  const base = () => fixture('nested-two-deep.json');

  it('draws only the outer box when both are collapsed', () => {
    const v = deriveView(base(), ['region-eu', 'vpc-private']);
    expect(ids(v.nodes).sort()).toEqual(['region-eu', 'web-client']);
    expect(v.groups).toEqual([]);
    const box = find(v.nodes, 'region-eu');
    expect(box?.note).toBe('4 components'); // nodes only, boundaries do not count
    expect(collapsedGroupKind(mustFind(v.nodes, 'region-eu'))).toBe('region');
  });

  it('rewrites edges all the way out to the outer box', () => {
    const v = deriveView(base(), ['region-eu', 'vpc-private']);
    expect(v.edges).toHaveLength(1);
    expect(v.edges[0]?.from).toBe('web-client');
    expect(v.edges[0]?.to).toBe('region-eu');
    expect(v.edges[0]?.label).toBe('https');
  });

  it('gives the same answer whichever order the ids arrive in', () => {
    const a = deriveView(base(), ['region-eu', 'vpc-private']);
    const b = deriveView(base(), ['vpc-private', 'region-eu']);
    expect({ ...a, collapsed: [] }).toEqual({ ...b, collapsed: [] });
  });

  it('keeps the outer group open when only the inner one is collapsed', () => {
    const v = deriveView(base(), ['vpc-private']);
    expect(ids(v.groups)).toEqual(['region-eu']);
    const box = find(v.nodes, 'vpc-private');
    expect(box?.parent).toBe('region-eu');
    expect(box?.note).toBe('3 components');
    expect(validate(v)).toEqual({ ok: true });
    // api-gateway -> auth-service and -> orders-service merge into one.
    const merged = v.edges.filter((e) => e.from === 'api-gateway');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe('×2');
  });
});

describe('cardinality on a merged or rewritten edge', () => {
  const erd = () =>
    doc({
      groups: [group('sales', { kind: 'generic' })],
      nodes: [
        node('customer', { type: 'entity' }),
        node('order', { type: 'entity', parent: 'sales' }),
        node('invoice', { type: 'entity', parent: 'sales' }),
      ],
      edges: [
        edge('e1', 'customer', 'order', { label: 'places', cardinality: '1:N' }),
        edge('e2', 'customer', 'invoice', { label: 'places', cardinality: 'N:M' }),
      ],
    });

  it('keeps cardinality when the collapse never touched the edge', () => {
    const v = deriveView(erd(), []);
    expect(find(v.edges, 'e1')?.cardinality).toBe('1:N');
  });

  it('drops it on a merge, because one marker cannot say both', () => {
    const v = deriveView(erd(), ['sales']);
    expect(v.edges).toHaveLength(1);
    expect(v.edges[0]?.cardinality).toBeUndefined();
    expect(v.edges[0]?.label).toBe('places ×2');
    expect(validate(v)).toEqual({ ok: true });
  });

  it('drops it on a lone rewritten edge too, so V13 still holds', () => {
    const d = erd();
    const one: GraphDoc = { ...d, edges: [mustFind(d.edges, 'e1')] };
    const v = deriveView(one, ['sales']);
    expect(v.edges).toHaveLength(1);
    expect(v.edges[0]?.to).toBe('sales');
    expect(v.edges[0]?.cardinality).toBeUndefined();
    // The stand-in is not an entity, so keeping cardinality would fail V13.
    expect(validate(v)).toEqual({ ok: true });
  });

  it('works on the ERD fixture without breaking validation', () => {
    const d = fixture('erd-ecommerce.json');
    for (const g of d.groups) {
      expect(validate(deriveView(d, [g.id]))).toEqual({ ok: true });
    }
  });
});

describe('degenerate collapse targets', () => {
  it('collapses a group with no children into an "empty group" box', () => {
    const d = doc({
      groups: [group('empty-vpc', { kind: 'vpc' })],
      nodes: [node('api')],
      edges: [edge('e1', 'api', 'empty-vpc')],
    });
    const v = deriveView(d, ['empty-vpc']);
    expect(v.groups).toEqual([]);
    const box = find(v.nodes, 'empty-vpc');
    expect(box?.note).toBe('empty group');
    expect(box?.type).toBe(COLLAPSED_NODE_TYPE);
    expect(v.edges).toHaveLength(1);
    expect(validate(v)).toEqual({ ok: true });
  });

  it('says "1 component" for a group holding exactly one node', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('only', { parent: 'vpc' })],
    });
    expect(find(deriveView(d, ['vpc']).nodes, 'vpc')?.note).toBe('1 component');
  });

  it('ignores a collapsed id that names a node, without throwing', () => {
    const d = fixture('cross-boundary-edges.json');
    const v = deriveView(d, ['postgres']);
    expect({ ...v, collapsed: [] }).toEqual({ ...d, collapsed: [] });
    expect(v.collapsed).toEqual(['postgres']); // carried, but inert
  });

  it('ignores a collapsed id that does not exist at all', () => {
    const d = fixture('cross-boundary-edges.json');
    const v = deriveView(d, ['no-such-group']);
    expect({ ...v, collapsed: [] }).toEqual({ ...d, collapsed: [] });
  });

  it('ignores duplicates in the collapsed list', () => {
    const d = fixture('cross-boundary-edges.json');
    expect(deriveView(d, ['vpc-private', 'vpc-private'])).toEqual(
      deriveView(d, ['vpc-private']),
    );
  });
});

describe('purity and idempotence', () => {
  it('never mutates the input document', () => {
    const d = fixture('nested-two-deep.json');
    const before = JSON.stringify(d);
    deriveView(d, ['region-eu', 'vpc-private']);
    deriveView(d, ['vpc-private']);
    deriveView(d, []);
    expect(JSON.stringify(d)).toBe(before);
  });

  it('does not alias mutable elements it rewrote', () => {
    const d = fixture('cross-boundary-edges.json');
    const v = deriveView(d, ['vpc-private']);
    const rewritten = v.edges.find((e) => e.to === 'vpc-private');
    expect(rewritten).toBeDefined();
    expect(d.edges.some((e) => e === rewritten)).toBe(false);
  });

  it('is idempotent — deriving the derived view changes nothing', () => {
    for (const collapsed of [[], ['vpc-private'], ['region-eu', 'vpc-private']]) {
      const d = fixture('nested-two-deep.json');
      const once = deriveView(d, collapsed);
      expect(deriveView(once, collapsed)).toEqual(once);
      expect(deriveView(once)).toEqual(once);
    }
  });

  it('is idempotent on the cross-boundary fixture too', () => {
    const d = fixture('cross-boundary-edges.json');
    const once = deriveView(d, ['vpc-private']);
    expect(deriveView(once, ['vpc-private'])).toEqual(once);
  });
});
