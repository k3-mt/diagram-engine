// tests/statedOrder.test.ts — §5.6: a numbered label is a stated order.
//
// "1 · Sources", "2 · Pull", "3 · Organisation engine" is the order the
// author wants the diagram read in, and before §5.6 the layout could not see
// it: ELK ranks by edges, so stages with no edge directly between them landed
// in one layer or the wrong one and a diagram numbered 1,2,3,5 read 5 before
// 3.
//
// Two things are pinned here. That the ordinals are obeyed — and, at least as
// important, that a label which merely CONTAINS a number is left alone.

import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphDoc } from '@diagram-engine/core';
import {
  ORDER_EDGE_PREFIX,
  isOrderingEdge,
  leadingOrdinal,
  orderingEdges,
} from '../src/layout/order.js';
import { toElk } from '../src/layout/toElk.js';
import { layout } from '../src/layout/runLayout.js';

const doc = (over: Partial<GraphDoc> = {}): GraphDoc => ({
  schemaVersion: 1,
  title: 'T',
  direction: 'DOWN',
  nodes: [],
  groups: [],
  edges: [],
  collapsed: [],
  ...over,
});

describe('leadingOrdinal', () => {
  it('reads the separators an author actually types', () => {
    expect(leadingOrdinal('1 · Sources')).toBe(1);
    expect(leadingOrdinal('2. Pull')).toBe(2);
    expect(leadingOrdinal('3) Tag')).toBe(3);
    expect(leadingOrdinal('4 - Reconcile')).toBe(4);
    expect(leadingOrdinal('5: Load')).toBe(5);
    expect(leadingOrdinal('  10 · Late stage')).toBe(10);
  });

  it('REQUIRES a separator, so an ordinary label is never reordered', () => {
    // The load-bearing half. Without the separator these are stage numbers,
    // and a diagram would silently rearrange itself around a product version.
    expect(leadingOrdinal('2 factor auth')).toBeUndefined();
    expect(leadingOrdinal('PostgreSQL 16/17')).toBeUndefined();
    expect(leadingOrdinal('S3 bucket')).toBeUndefined();
    expect(leadingOrdinal('Harvester')).toBeUndefined();
    // A number in the middle is not a leading ordinal either.
    expect(leadingOrdinal('Stage 3 · Tag')).toBeUndefined();
  });
});

describe('orderingEdges', () => {
  const stages = (labels: string[], parent: string | null = null): GraphDoc =>
    doc({
      groups: labels.map((label, i) => ({
        id: `g${i}`,
        label,
        kind: 'generic' as const,
        parent,
      })),
    });

  it('chains the stages in numeric order, not document order', () => {
    // Declared 5, 2, 3 on purpose: the ordinal decides, not the array.
    const d = stages(['5 · Standardisation', '2 · Pull', '3 · Organisation']);
    const edges = orderingEdges(d).get(null) ?? [];
    expect(edges.map((e) => `${e.sources[0]}->${e.targets[0]}`)).toEqual([
      'g1->g2', // 2 -> 3
      'g2->g0', // 3 -> 5
    ]);
  });

  it('bridges a GAP rather than treating it as a missing stage', () => {
    // 2, 3, 5 chains 3 -> 5: a gap means a stage that lives in another
    // container, not one that does not exist.
    const d = stages(['2 · A', '3 · B', '5 · C']);
    const edges = orderingEdges(d).get(null) ?? [];
    expect(edges).toHaveLength(2);
  });

  it('says nothing when only ONE sibling is numbered', () => {
    // No second ordinal, no order to state — and crucially no claim about
    // where the unnumbered siblings go.
    const d = stages(['1 · Sources', 'Pipeline VM', 'Object storage']);
    expect(orderingEdges(d).size).toBe(0);
  });

  it('leaves unnumbered siblings entirely unconstrained', () => {
    const d = stages(['1 · A', 'Scratch', '2 · B']);
    const edges = orderingEdges(d).get(null) ?? [];
    expect(edges.map((e) => `${e.sources[0]}->${e.targets[0]}`)).toEqual(['g0->g2']);
  });

  it('never crosses a container boundary', () => {
    // An ordinal in one container says nothing about an ordinal in another:
    // "2 · Pull" and "2 · Map" are different sequences.
    const d = doc({
      groups: [
        { id: 'outer', label: 'Outer', kind: 'generic', parent: null },
        { id: 'a', label: '1 · A', kind: 'generic', parent: 'outer' },
        { id: 'b', label: '2 · B', kind: 'generic', parent: 'outer' },
      ],
      nodes: [
        { id: 'n1', label: '1 · N', type: 'service', parent: null },
        { id: 'n2', label: '2 · N', type: 'service', parent: null },
      ],
    });
    const m = orderingEdges(d);
    expect(m.get('outer')?.map((e) => e.id)).toEqual([`${ORDER_EDGE_PREFIX}a>b`]);
    expect(m.get(null)?.map((e) => e.id)).toEqual([`${ORDER_EDGE_PREFIX}n1>n2`]);
  });

  it('skips a step a REAL edge already orders', () => {
    // The constraint is already stated; a duplicate would only add edge
    // spacing between two boxes that are already ranked correctly.
    const d = doc({
      nodes: [
        { id: 'a', label: '1 · A', type: 'service', parent: null },
        { id: 'b', label: '2 · B', type: 'service', parent: null },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b' }],
    });
    expect(orderingEdges(d).size).toBe(0);
  });

  it('is empty for a document that numbers nothing', () => {
    expect(orderingEdges(stages(['Sources', 'Pull', 'Store'])).size).toBe(0);
  });

  it('uses an id no author could ever write', () => {
    // §3.1 ids are ^[a-z][a-z0-9-]{0,47}$, so this prefix cannot collide —
    // which is what lets fromElk recognise these by name alone.
    const d = stages(['1 · A', '2 · B']);
    const [e] = orderingEdges(d).get(null) ?? [];
    expect(isOrderingEdge(e!.id)).toBe(true);
    expect(/^[a-z][a-z0-9-]{0,47}$/.test(e!.id)).toBe(false);
  });
});

describe('what ELK is handed', () => {
  it('declares the ordering edge in the container it orders', () => {
    const d = doc({
      groups: [
        { id: 'outer', label: 'Outer', kind: 'generic', parent: null },
        { id: 'a', label: '1 · A', kind: 'generic', parent: 'outer' },
        { id: 'b', label: '2 · B', kind: 'generic', parent: 'outer' },
      ],
    });
    const root = toElk(d);
    const outer = root.children?.find((c) => c.id === 'outer');
    expect(outer?.edges?.map((e) => e.id)).toEqual([`${ORDER_EDGE_PREFIX}a>b`]);
    expect(root.edges ?? []).toHaveLength(0);
  });

  it('adds nothing to a document that numbers nothing', () => {
    const plain = doc({
      nodes: [
        { id: 'a', label: 'A', type: 'service', parent: null },
        { id: 'b', label: 'B', type: 'service', parent: null },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b' }],
    });
    expect(toElk(plain).edges).toHaveLength(1);
  });
});

describe('the picture that results', () => {
  /** Three numbered stages with NO edges between them — the hard case. */
  const NUMBERED = doc({
    groups: [
      { id: 'five', label: '5 · Standardisation', kind: 'generic', parent: null },
      { id: 'two', label: '2 · Pull', kind: 'generic', parent: null },
      { id: 'three', label: '3 · Organisation', kind: 'generic', parent: null },
    ],
    nodes: [
      { id: 'n5', label: 'E', type: 'service', parent: 'five' },
      { id: 'n2', label: 'P', type: 'service', parent: 'two' },
      { id: 'n3', label: 'O', type: 'service', parent: 'three' },
    ],
  });

  it('draws the stages top-to-bottom in numeric order', async () => {
    const laid = await layout(NUMBERED, new ELK() as never);
    const y = (id: string): number => laid.nodes.get(id)!.y;
    expect(y('two')).toBeLessThan(y('three'));
    expect(y('three')).toBeLessThan(y('five'));
  }, 30000);

  it('emits NO geometry for an ordering edge', async () => {
    // They exist to rank boxes and nothing else. One reaching the renderer
    // would be a line with no meaning; one reaching the crossing pass would
    // put a hop over a line nobody can see.
    const laid = await layout(NUMBERED, new ELK() as never);
    expect(laid.edges).toHaveLength(0);
    expect(laid.edges.some((e) => isOrderingEdge(e.id))).toBe(false);
  }, 30000);
});
