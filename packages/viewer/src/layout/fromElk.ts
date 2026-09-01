// layout/fromElk.ts — the two-pass coordinate flattening (spec §5.3).
//
// ELK returns coordinates relative to a parent, and the rule DIFFERS
// between nodes and edges:
//
// - Node x/y are relative to the parent node's origin.
// - Edge section coordinates are relative to the edge's CONTAINER,
//   which ELK picks as the lowest common ancestor of source and
//   target (toElk declares each edge in exactly that container). An
//   edge from inside a group to a root node has the root as
//   container; an edge between two siblings inside a group has that
//   group as container.
//
// So no uniform offset works. Pass 1 walks the node tree accumulating
// absolute origins for every node and group. Pass 2 walks EDGES,
// offsetting each edge's points by its container's absolute origin —
// the container being the ELK node whose `edges` array carries it.
//
// Pure function, no DOM. Output geometry lives only in viewer memory
// and is NEVER persisted to the document (spec §1.4/§3.1).

import type { ElkNode } from 'elkjs';
import { isOrderingEdge } from './order.js';

/** An absolute rectangle, in root coordinates. Never persisted (§1.4). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AbsPoint {
  x: number;
  y: number;
}

/** An edge label placed by ELK, in absolute root coordinates. */
export interface AbsEdgeLabel {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A flattened edge: absolute polyline points (+ label when the edge has one). */
export interface AbsEdge {
  id: string;
  points: AbsPoint[];
  label?: AbsEdgeLabel;
}

/** No edge was flow-reversed — the default, and every pre-§3.9 document. */
const EMPTY: ReadonlySet<string> = new Set<string>();

/** Result of flattening an ELK layout to absolute coordinates. */
export interface LaidOut {
  /** Total laid-out canvas size (the ELK root's dimensions). */
  width: number;
  height: number;
  /** Absolute rects for every node AND group, keyed by element id. */
  nodes: Map<string, Rect>;
  /** Edges as absolute point arrays. */
  edges: AbsEdge[];
}

/**
 * Flatten an ELK layout result (relative coordinates) into absolute
 * root-space geometry. `elkRoot` is the synthetic root container that
 * toElk built; it is excluded from the output rects, but its size
 * becomes the canvas width/height.
 */
export function flatten(
  elkRoot: ElkNode,
  flowReversed: ReadonlySet<string> = EMPTY,
): LaidOut {
  // Absolute origin of every container (root included — pass 2 needs
  // it to offset root-contained edges).
  const origins = new Map<string, AbsPoint>();
  const nodes = new Map<string, Rect>();

  // Pass 1 — walk nodes, accumulating absolute origins for every node
  // and group. Node x/y are parent-relative, so each child adds its
  // own offset to the parent's absolute origin.
  (function walk(n: ElkNode, ox: number, oy: number): void {
    const ax = ox + (n.x ?? 0);
    const ay = oy + (n.y ?? 0);
    origins.set(n.id, { x: ax, y: ay });
    if (n !== elkRoot) {
      nodes.set(n.id, {
        x: ax,
        y: ay,
        width: n.width ?? 0,
        height: n.height ?? 0,
      });
    }
    n.children?.forEach((c) => walk(c, ax, ay));
  })(elkRoot, 0, 0);

  // Pass 2 — walk EDGES, offset by their CONTAINER's absolute origin.
  // The container is the ELK node whose `edges` array holds the edge
  // (the LCA of its endpoints), NOT the endpoints' parents.
  const edges: AbsEdge[] = [];
  (function walkEdges(n: ElkNode): void {
    const o = origins.get(n.id);
    if (o !== undefined) {
      for (const e of n.edges ?? []) {
        // §5.6: an ordering edge exists only to rank two boxes. It is not in
        // the document, has no arrowhead and no label, and must never reach
        // the renderer OR the crossing pass — a hop drawn over an invisible
        // line is a hop over nothing, which is worse than a crossing.
        if (isOrderingEdge(e.id)) continue;
        // ELK positions edge labels relative to the SAME container as
        // the edge's sections (the LCA that toElk declared the edge
        // in), so the label takes the same offset as the points. A
        // GEdge has at most one label (§3.1), hence the first entry.
        const l = (e.labels ?? [])[0];
        const label: AbsEdgeLabel | undefined =
          l === undefined
            ? undefined
            : {
                text: l.text ?? '',
                x: (l.x ?? 0) + o.x,
                y: (l.y ?? 0) + o.y,
                width: l.width ?? 0,
                height: l.height ?? 0,
              };
        for (const s of e.sections ?? []) {
          const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(
            (p) => ({ x: p.x + o.x, y: p.y + o.y }),
          );
          // §5.5: this edge was handed to ELK with its endpoints swapped so
          // it would rank the far end first, so ELK's polyline runs
          // target -> source. Put it back into DOCUMENT order here, at the
          // one boundary that knows about the swap. Everything downstream —
          // the arrowheads, which end the return head goes on, where the step
          // badge is anchored — reads the polyline as source -> target and
          // must never learn that layout thought otherwise.
          if (flowReversed.has(e.id)) pts.reverse();
          edges.push(
            label !== undefined
              ? { id: e.id, points: pts, label }
              : { id: e.id, points: pts },
          );
        }
      }
    }
    n.children?.forEach(walkEdges);
  })(elkRoot);

  return {
    width: elkRoot.width ?? 0,
    height: elkRoot.height ?? 0,
    nodes,
    edges,
  };
}
