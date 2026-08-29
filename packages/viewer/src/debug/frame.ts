// debug/frame.ts — assemble one drawable "frame" for the DEBUG renderer
// (spec M2 Step 9 / M3 exit). Pure function: takes a document plus its
// flattened layout and returns exactly what the SVG needs — group rects
// sorted outermost first (z-order rule 1, spec §8.1), node rects, and per
// edge BOTH the raw polyline points and the composed path with hop arcs
// (spec §6.5) so the page can toggle between them.
//
// No DOM. Geometry is derived per frame and NEVER persisted (§1.4/§3.1).

import type { GraphDoc } from '@diagram-engine/core';
import type { LaidOut, Rect } from '../layout/fromElk.js';
import { composeFramePaths } from '../geometry';

export interface DebugGroup {
  id: string;
  rect: Rect;
  /** 0 = top-level; used only for the outermost-first sort. */
  depth: number;
}

export interface DebugNode {
  id: string;
  rect: Rect;
}

export interface DebugEdge {
  id: string;
  /** Raw flattened polyline, for the "raw polylines" toggle. */
  points: { x: number; y: number }[];
  /** Composed SVG path: hop arcs + rounded corners (spec §6.5-§6.6). */
  d: string;
}

export interface DebugFrame {
  width: number;
  height: number;
  groups: DebugGroup[]; // outermost first
  nodes: DebugNode[];
  edges: DebugEdge[];
}

/** Depth of a group in the group-parent chain (0 = top-level). */
function groupDepth(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0;
  const seen = new Set<string>();
  let p = parentOf.get(id) ?? null;
  while (p !== null && !seen.has(p)) {
    depth++;
    seen.add(p);
    p = parentOf.get(p) ?? null;
  }
  return depth;
}

/** Build the drawable frame for one laid-out document. */
export function buildFrame(doc: GraphDoc, laidOut: LaidOut): DebugFrame {
  const parentOf = new Map<string, string | null>(
    doc.groups.map((g) => [g.id, g.parent]),
  );

  const groups: DebugGroup[] = doc.groups
    .flatMap((g) => {
      const rect = laidOut.nodes.get(g.id);
      return rect ? [{ id: g.id, rect, depth: groupDepth(g.id, parentOf) }] : [];
    })
    .sort((a, b) => a.depth - b.depth); // outermost first (stable sort)

  const nodes: DebugNode[] = doc.nodes.flatMap((n) => {
    const rect = laidOut.nodes.get(n.id);
    return rect ? [{ id: n.id, rect }] : [];
  });

  // Crossing detection runs once against the segments of ALL edges in the
  // frame, and the NODE_GUARD against node rects only (groups are
  // containers, not obstacles for hops).
  const nodeRects: Rect[] = nodes.map((n) => n.rect);
  const paths = composeFramePaths(laidOut.edges, nodeRects);

  const edges: DebugEdge[] = laidOut.edges.map((e, i) => ({
    id: e.id,
    points: e.points,
    d: paths[i]!, // aligned index-for-index by composeFramePaths
  }));

  return { width: laidOut.width, height: laidOut.height, groups, nodes, edges };
}
