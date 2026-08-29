// Geometry step 2 (spec §6.2): find every horizontal-vs-vertical segment
// crossing that deserves a hop arc. Pure function — no DOM, safe under Node.
//
// Collinear overlaps (h-vs-h, v-vs-v) are a separate problem that the
// `edgeEdge` layout spacing mostly prevents; ignored for the PoC per spec.

import type { Seg } from './segments';

/** Arc radius of a hop (px). */
export const HOP_R = 6;
/** No hops this close to a bend (px). */
export const CORNER_GUARD = 10;
/** No hops this close to a node boundary (px). */
export const NODE_GUARD = 6;

/** An absolute node rectangle in the flattened coordinate space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One crossing point. Ownership rule (spec §6.3): the horizontal segment
 * always hops, the vertical always runs straight.
 */
export interface Crossing {
  x: number;
  y: number;
  hSeg: Seg;
  vSeg: Seg;
}

function minmax(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** Is (x, y) within `guard` px of the rectangle (edges included)? */
export function pointNear(r: Rect, x: number, y: number, guard: number): boolean {
  return (
    x >= r.x - guard &&
    x <= r.x + r.width + guard &&
    y >= r.y - guard &&
    y <= r.y + r.height + guard
  );
}

/**
 * Detect crossings between horizontal and vertical segments.
 *
 * Rules (spec §6.2):
 * - only h-vs-v pairs can cross; flagged diagonals are skipped entirely;
 * - an edge never hops itself;
 * - strict inequalities exclude shared endpoints (a T-junction is not a
 *   crossing);
 * - CORNER_GUARD applies on both axes — no hop within 10px of either
 *   segment's ends, where a bend may live;
 * - NODE_GUARD rejects crossings within 6px of any node boundary.
 *
 * O(h x v). At 200 edges x ~4 segments that's ~160k comparisons, roughly
 * 3ms — fine. If it ever isn't, bucket segments into a 100px grid.
 */
export function findCrossings(segs: Seg[], nodeRects: Rect[]): Crossing[] {
  const hs = segs.filter((s) => s.orient === 'h' && !s.diagonal);
  const vs = segs.filter((s) => s.orient === 'v' && !s.diagonal);
  const out: Crossing[] = [];

  for (const h of hs) {
    const [hx1, hx2] = minmax(h.x1, h.x2);
    for (const v of vs) {
      if (v.edgeId === h.edgeId) continue; // never hop yourself
      const [vy1, vy2] = minmax(v.y1, v.y2);
      const x = v.x1;
      const y = h.y1;

      if (x <= hx1 || x >= hx2) continue; // strict, excludes ends
      if (y <= vy1 || y >= vy2) continue;
      if (Math.min(Math.abs(x - hx1), Math.abs(x - hx2)) < CORNER_GUARD) continue;
      if (Math.min(Math.abs(y - vy1), Math.abs(y - vy2)) < CORNER_GUARD) continue;
      if (nodeRects.some((r) => pointNear(r, x, y, NODE_GUARD))) continue;

      out.push({ x, y, hSeg: h, vSeg: v });
    }
  }
  return out;
}
