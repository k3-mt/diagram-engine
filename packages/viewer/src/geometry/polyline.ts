// geometry/polyline.ts — operations on an absolute polyline that are not part
// of the §6.1–§6.6 hop-and-round pipeline: measuring one, and finding a point
// along it.
//
// It exists for §3.9's two edge decorations — the step badge and the label
// naming what comes back — which have to be anchored at a REAL position on
// the route rather than at a vertex. An orthogonal route's vertices cluster
// at its bends, so anything placed on one lands in a corner.
//
// (An earlier draft of §3.9 drew the return as a second stroke offset
// alongside the first, and this module carried the polyline-offsetting maths
// for it. That design was dropped: at any sane offset the second stroke read
// as a rendering seam rather than as an arrow, and it diverged from its own
// outbound leg at every bend. The return is now an open arrowhead on the ONE
// stroke — see EdgePath.tsx — so the offsetting code went with it.)
//
// Pure functions, no DOM, safe under Node/vitest. Geometry is derived per
// frame and NEVER persisted to the document (§1.4/§3.1).

import type { Point } from './segments.js';

/**
 * A point on a polyline, with the DIRECTION OF TRAVEL there.
 *
 * Deliberately not the same shape as AnalysisOverlay's `MidPoint`, which
 * carries the unit NORMAL instead: that one anchors a firebreak bar drawn
 * ACROSS the line, this one anchors a decoration that sits ALONG it. Two
 * different questions, two types, two names — rather than one type whose two
 * fields mean different things to different callers.
 */
export interface PointOnPath {
  x: number;
  y: number;
  /** Unit direction of the segment the point falls on. */
  dx: number;
  dy: number;
}

/**
 * The point half-way along a polyline BY ARC LENGTH — not the middle vertex,
 * which on an L-shaped route is the corner and puts a label in the one place
 * on the line where two segments meet.
 *
 * Returns null for a polyline with nothing to measure (fewer than two points,
 * or zero total length after the degenerate segments are dropped — except
 * that two identical points answer with that point, so a zero-length edge
 * still has somewhere to put a badge).
 */
export function midpointAlong(points: readonly Point[]): PointOnPath | null {
  if (points.length < 2) return null;
  const seg: { a: Point; b: Point; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) continue;
    seg.push({ a, b, len });
    total += len;
  }
  if (seg.length === 0) {
    const a = points[0] as Point;
    return { x: a.x, y: a.y, dx: 1, dy: 0 };
  }
  return pointAlongSegments(seg, total / 2);
}

/** Total length of a polyline, by arc length. 0 for anything undrawable. */
export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * The point a FRACTION of the way along a polyline, 0 at the source and 1 at
 * the target.
 *
 * Exists so the return-leg label can sit somewhere other than the midpoint.
 * The midpoint is where ELK puts the edge's own label, and the edge label is
 * drawn in layer 4 with a canvas-coloured halo behind it — i.e. AFTER the
 * edges layer, painting over anything there. Two labels at one point means
 * the return label loses, silently, and only on the edges that have both.
 */
export function pointAtFraction(
  points: readonly Point[],
  t: number,
): PointOnPath | null {
  if (points.length < 2) return null;
  return pointAlong(points, pathLength(points) * Math.min(Math.max(t, 0), 1));
}

/**
 * A point `distance` px in from the source, but never past `maxFraction` of
 * the way along — so a decoration anchored near the start of a LONG edge sits
 * at a fixed, predictable distance, and on a SHORT one shrinks back instead
 * of sliding past the midpoint into the edge label parked there.
 */
export function pointNearStart(
  points: readonly Point[],
  distance: number,
  maxFraction: number,
): PointOnPath | null {
  if (points.length < 2) return null;
  const total = pathLength(points);
  return pointAlong(points, Math.min(distance, total * maxFraction));
}

/**
 * The point `distance` px along a polyline from its START, clamped to the
 * ends. Used to anchor a step badge near the beginning of an edge, where the
 * reader's eye is already looking for what happens first.
 */
export function pointAlong(
  points: readonly Point[],
  distance: number,
): PointOnPath | null {
  if (points.length < 2) return null;
  const seg: { a: Point; b: Point; len: number }[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= 0) continue;
    seg.push({ a, b, len });
    total += len;
  }
  if (seg.length === 0) {
    const a = points[0] as Point;
    return { x: a.x, y: a.y, dx: 1, dy: 0 };
  }
  return pointAlongSegments(seg, Math.min(Math.max(distance, 0), total));
}

/** Walk pre-measured segments to `want` px and interpolate. */
function pointAlongSegments(
  seg: readonly { a: Point; b: Point; len: number }[],
  want: number,
): PointOnPath {
  let acc = 0;
  for (const { a, b, len } of seg) {
    if (acc + len < want) {
      acc += len;
      continue;
    }
    const t = (want - acc) / len;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx, dy };
  }
  const last = seg[seg.length - 1] as { a: Point; b: Point; len: number };
  const { a, b, len } = last;
  return { x: b.x, y: b.y, dx: (b.x - a.x) / len, dy: (b.y - a.y) / len };
}
