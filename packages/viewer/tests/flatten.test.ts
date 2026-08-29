// M2 Step 7 — test T8 (spec §5.3 / §6.8), written BEFORE fromElk.ts.
//
// The coordinate flattening problem: ELK returns node x/y relative to
// the parent node, but edge section coordinates relative to the edge's
// CONTAINER (the lowest common ancestor of source and target). A wrong
// offset doesn't crash — it just makes the arrows "a bit off".
//
// T8 fixture: one node inside a group, one node outside, an edge
// between them. The edge's container is the root, but its source sits
// inside the group — so the start point is only correct if pass 2
// offsets by the container origin while pass 1 accumulated the group's
// origin into the inner node's absolute rect. Assert the start point
// lands within 2px of the inner node's absolute boundary.
//
// Runs the REAL elkjs layout headless in Node through the shared
// layout() code path (toElk -> ELK -> flatten).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphDoc } from '@diagram-engine/core';
import { layout } from '../src/layout/runLayout.js';
import type { Rect } from '../src/layout/fromElk.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures',
);

/**
 * Distance from a point to the boundary (perimeter) of a rect.
 * Outside the rect: euclidean distance to the rect. Inside: distance
 * to the nearest side. 0 exactly on the perimeter.
 */
function distToRectBoundary(p: { x: number; y: number }, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  const outside = Math.hypot(dx, dy);
  if (outside > 0) return outside;
  return Math.min(
    p.x - r.x,
    r.x + r.width - p.x,
    p.y - r.y,
    r.y + r.height - p.y,
  );
}

describe('T8 — coordinate flattening (spec §5.3)', () => {
  const doc: GraphDoc = {
    schemaVersion: 1,
    title: 'T8 fixture',
    direction: 'DOWN',
    nodes: [
      { id: 'inner', label: 'Inner Node', type: 'service', parent: 'grp' },
      { id: 'outer', label: 'Outer Node', type: 'service', parent: null },
    ],
    groups: [{ id: 'grp', label: 'The Group', kind: 'generic', parent: null }],
    edges: [{ id: 'e1', from: 'inner', to: 'outer' }],
    collapsed: [],
  };

  it('edge start lands within 2px of the inner node absolute boundary', async () => {
    const laid = await layout(doc);

    const inner = laid.nodes.get('inner');
    expect(inner).toBeDefined();

    const e1 = laid.edges.find((e) => e.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1!.points.length).toBeGreaterThanOrEqual(2);

    const start = e1!.points[0]!;
    expect(distToRectBoundary(start, inner!)).toBeLessThanOrEqual(2);
  });

  it('edge end lands within 2px of the outer node absolute boundary', async () => {
    const laid = await layout(doc);
    const outer = laid.nodes.get('outer')!;
    const e1 = laid.edges.find((e) => e.id === 'e1')!;
    const end = e1.points[e1.points.length - 1]!;
    expect(distToRectBoundary(end, outer)).toBeLessThanOrEqual(2);
  });

  it('the group rect contains the inner node rect (pass 1 nesting)', async () => {
    const laid = await layout(doc);
    const grp = laid.nodes.get('grp')!;
    const inner = laid.nodes.get('inner')!;
    expect(inner.x).toBeGreaterThanOrEqual(grp.x);
    expect(inner.y).toBeGreaterThanOrEqual(grp.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(grp.x + grp.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(grp.y + grp.height);
  });
});

describe('flatten on the cross-boundary fixture (spec §5.3)', () => {
  it('every edge endpoint lands within 2px of its endpoint node boundary', async () => {
    const raw = fs.readFileSync(
      path.join(FIXTURES_DIR, 'cross-boundary-edges.json'),
      'utf8',
    );
    const doc = JSON.parse(raw) as GraphDoc;
    const laid = await layout(doc);

    for (const edge of doc.edges) {
      const abs = laid.edges.find((e) => e.id === edge.id);
      expect(abs, `edge ${edge.id} missing from LaidOut`).toBeDefined();
      const from = laid.nodes.get(edge.from)!;
      const to = laid.nodes.get(edge.to)!;
      const start = abs!.points[0]!;
      const end = abs!.points[abs!.points.length - 1]!;
      expect(
        distToRectBoundary(start, from),
        `edge ${edge.id} start is off the boundary of ${edge.from}`,
      ).toBeLessThanOrEqual(2);
      expect(
        distToRectBoundary(end, to),
        `edge ${edge.id} end is off the boundary of ${edge.to}`,
      ).toBeLessThanOrEqual(2);
    }
  });
});
