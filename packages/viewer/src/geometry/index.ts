// Geometry pipeline entry (spec Part 6). One call takes a flattened edge to
// its final SVG `d` string: segments -> crossings -> merged hop spans ->
// path with hops -> corner rounding -> serialization. Every stage is a pure
// function, exported individually below. Geometry is derived per frame and
// NEVER persisted to the document (spec §1.4/§3.1).

import { toSegments, type AbsEdge } from './segments.js';
import { findCrossings, type Rect } from './crossings.js';
import { buildHopSpans } from './hops.js';
import { buildPathCmds, serializePath } from './path.js';
import { roundCorners } from './corners.js';
import type { Seg } from './segments.js';

/**
 * Compose the final SVG path for one edge.
 *
 * @param edgePoints   the edge (id + absolute polyline points) to draw.
 * @param allSegments  segments of ALL edges in the frame (this edge's
 *                     included), as produced by `toSegments` — crossings are
 *                     detected against the whole set so hops appear where
 *                     other edges pass through.
 * @param nodeRects    absolute node rectangles, for the NODE_GUARD rule.
 * @returns the SVG `d` string: hops on horizontal segments (§6.3–§6.5),
 *          then corner rounding (§6.6). The final segment stays straight
 *          (hop guards keep arcs away from ends), so arrowhead markers
 *          orient correctly with no manual angle math (§6.7).
 */
export function composePath(
  edgePoints: AbsEdge,
  allSegments: Seg[],
  nodeRects: Rect[]
): string {
  const spans = buildHopSpans(findCrossings(allSegments, nodeRects));
  return composePathWithSpans(edgePoints, spans);
}

/** Serialize one edge against hop spans already computed for the frame. */
function composePathWithSpans(
  edgePoints: AbsEdge,
  spans: ReturnType<typeof buildHopSpans>
): string {
  const own = toSegments(edgePoints);
  const cmds = buildPathCmds(own, spans);
  const rounded = roundCorners(cmds, own, spans);
  return serializePath(rounded);
}

/**
 * Compose the SVG paths for every edge in a frame with ONE crossing pass.
 *
 * Crossing detection is O(h×v) over the whole frame (§6.2 budgets ~3ms at
 * 200 edges); running it per edge multiplies that by the edge count and
 * blows the §6.8 T9 / G6 budgets. Compute crossings and hop spans once,
 * then build each edge's path against the shared span map.
 *
 * @returns `d` strings aligned index-for-index with the input edges.
 */
export function composeFramePaths(
  edges: AbsEdge[],
  nodeRects: Rect[]
): string[] {
  const allSegments = edges.flatMap((e) => toSegments(e));
  const spans = buildHopSpans(findCrossings(allSegments, nodeRects));
  return edges.map((e) => composePathWithSpans(e, spans));
}

// Stage exports — each usable standalone (and individually tested).
export { toSegments, type AbsEdge, type Point, type Seg } from './segments.js';
export {
  findCrossings,
  pointNear,
  HOP_R,
  CORNER_GUARD,
  NODE_GUARD,
  type Crossing,
  type Rect
} from './crossings.js';
export { buildHopSpans, mergeClusters, segKey, type Span } from './hops.js';
export { buildPath, buildPathCmds, serializePath, type PathCmd } from './path.js';
export { roundCorners, CORNER_R, MIN_ROUND_SEG, HOP_CLEARANCE } from './corners.js';
