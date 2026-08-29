// Edge labels through layout (spec §5 + §8.1 item 4).
//
// toElk declares each labelled GEdge's label to ELK (sized with
// EDGE_LABEL_FONT, height EDGE_LABEL_H, inline placement per
// EDGE_LABEL_OPTIONS); real elkjs places it; flatten offsets the label
// by the SAME container origin as the edge's sections (§5.3) and hands
// it out on AbsEdge.label in absolute coordinates.
//
// Runs REAL elkjs headless (same path as pipeline.test.ts). Asserts:
//  - every labelled edge comes back with a label whose coordinates are
//    finite and whose center lies within 40px of some point on that
//    edge's own polyline (the inline placement puts it ON the path;
//    40px is the tolerance for ELK nudging labels off bend clusters),
//  - unlabelled edges produce no label entry,
//  - toElk declares the label boxes (width from measureText at
//    EDGE_LABEL_FONT, height EDGE_LABEL_H) only for labelled edges.

import { describe, expect, it } from 'vitest';
import type { GraphDoc } from '@diagram-engine/core';
import type { ElkNode } from 'elkjs';
import { layout } from '../src/layout/runLayout.js';
import type { AbsEdge, AbsPoint } from '../src/layout/fromElk.js';
import { toElk } from '../src/layout/toElk.js';
import { EDGE_LABEL_FONT, EDGE_LABEL_H, measureText } from '../src/layout/measure.js';

// One root node plus a group with two children, so labels are placed
// for edges living in BOTH kinds of container: e-cross is declared at
// the root (LCA of a and b), e-inner inside grp (LCA of b and c). The
// container-offset rule (§5.3) is therefore exercised for labels too.
const DOC: GraphDoc = {
  schemaVersion: 1,
  title: 'edge label fixture',
  direction: 'DOWN',
  nodes: [
    { id: 'a', label: 'Gateway', type: 'service', parent: null },
    { id: 'b', label: 'Orders', type: 'service', parent: 'grp' },
    { id: 'c', label: 'Postgres', type: 'database', parent: 'grp' },
  ],
  groups: [{ id: 'grp', label: 'Private VPC', kind: 'vpc', parent: null }],
  edges: [
    { id: 'e-cross', from: 'a', to: 'b', label: 'routes' },
    { id: 'e-inner', from: 'b', to: 'c', label: 'reads' },
    { id: 'e-plain', from: 'a', to: 'c' },
  ],
  collapsed: [],
};

const LABELLED = new Map([
  ['e-cross', 'routes'],
  ['e-inner', 'reads'],
]);

/** Distance from point p to the segment [a, b]. */
function distToSegment(p: AbsPoint, a: AbsPoint, b: AbsPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}

/** Min distance from p to any point of the polyline. */
function distToPolyline(p: AbsPoint, pts: AbsPoint[]): number {
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    best = Math.min(best, distToSegment(p, pts[i]!, pts[i + 1]!));
  }
  return best;
}

function collectElkEdges(root: ElkNode): Map<string, NonNullable<ElkNode['edges']>[number]> {
  const out = new Map<string, NonNullable<ElkNode['edges']>[number]>();
  (function walk(n: ElkNode): void {
    for (const e of n.edges ?? []) out.set(e.id, e);
    n.children?.forEach(walk);
  })(root);
  return out;
}

describe('toElk: edge label declaration', () => {
  const elkEdges = collectElkEdges(toElk(DOC));

  it('declares one measured label box per labelled edge', () => {
    for (const [id, text] of LABELLED) {
      const e = elkEdges.get(id);
      expect(e, `edge ${id} missing from ELK input`).toBeDefined();
      expect(e!.labels).toHaveLength(1);
      const l = e!.labels![0]!;
      expect(l.text).toBe(text);
      expect(l.width).toBe(measureText(text, EDGE_LABEL_FONT));
      expect(l.width!).toBeGreaterThan(0);
      expect(l.height).toBe(EDGE_LABEL_H);
    }
  });

  it('edge label width is measured smaller than at the node label font', () => {
    // EDGE_LABEL_FONT is 11px vs the 14px node font, so the same text
    // must come out narrower — guards against measuring with the wrong font.
    expect(measureText('routes', EDGE_LABEL_FONT)).toBeLessThan(measureText('routes'));
  });

  it('declares no labels on unlabelled edges', () => {
    expect(elkEdges.get('e-plain')!.labels).toBeUndefined();
  });
});

describe('layout: edge labels land on their edges (real elkjs)', () => {
  it('places every label with finite absolute coordinates near its own polyline', async () => {
    const laid = await layout(DOC);
    const byId = new Map<string, AbsEdge>(laid.edges.map((e) => [e.id, e]));

    for (const [id, text] of LABELLED) {
      const e = byId.get(id);
      expect(e, `laid-out edge ${id} missing`).toBeDefined();
      const label = e!.label;
      expect(label, `edge ${id} lost its label through layout`).toBeDefined();
      expect(label!.text).toBe(text);
      for (const v of [label!.x, label!.y, label!.width, label!.height]) {
        expect(Number.isFinite(v), `edge ${id} label has non-finite value`).toBe(true);
      }
      expect(label!.width).toBeGreaterThan(0);
      expect(label!.height).toBe(EDGE_LABEL_H);

      // Inline placement puts the label ON the edge path: its center
      // must sit within 40px of the edge's own polyline (absolute
      // coordinates on both sides, so a wrong container offset — the
      // §5.3 failure mode — blows way past this tolerance).
      const center: AbsPoint = {
        x: label!.x + label!.width / 2,
        y: label!.y + label!.height / 2,
      };
      const d = distToPolyline(center, e!.points);
      expect(
        d,
        `edge ${id} label center ${JSON.stringify(center)} is ${d.toFixed(1)}px ` +
          `from its polyline ${JSON.stringify(e!.points)}`,
      ).toBeLessThanOrEqual(40);
    }
  });

  it('produces no label entry for unlabelled edges', async () => {
    const laid = await layout(DOC);
    const plain = laid.edges.find((e) => e.id === 'e-plain');
    expect(plain).toBeDefined();
    expect(plain!.label).toBeUndefined();
  });
});
