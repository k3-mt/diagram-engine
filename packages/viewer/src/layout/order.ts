// layout/order.ts — a numbered label is a STATED ORDER (spec §5.6).
//
// Authors number the stages of a flow in the label itself: "1 · Sources",
// "2 · Pull", "3 · Organisation engine". That numbering IS the reading order
// the diagram is meant to be followed in, and the layout could not see it.
// ELK ranks by edges, so two stages with no edge running directly between
// them fell into the same layer or the wrong one, and the picture contradicted
// the numbers written on it — a diagram whose boxes said 1, 2, 3, 5 read
// 5 before 3.
//
// So an ordinal at the START of a label becomes a layer constraint: within one
// container, siblings are drawn in numeric order — first at the top under
// `direction: "DOWN"`, first at the left under "RIGHT".
//
// HOW, AND WHY NOT THE OBVIOUS WAY. ELK has a feature for exactly this,
// `elk.partitioning`, and it does not work here: measured against elkjs 0.9.3,
// partitioning is ignored entirely under `hierarchyHandling: INCLUDE_CHILDREN`
// — three siblings with partitions 2, 3 and 5 all landed in one layer, with
// the option set on the container, on the root, and on both. INCLUDE_CHILDREN
// is not negotiable (§5.2: without it cross-boundary edges route badly or not
// at all), so the constraint is expressed as the one thing layered layout
// always honours: an EDGE. One invisible edge from each stage to the next puts
// them in order, and fromElk drops them before anything can draw them.
//
// WHAT COUNTS AS AN ORDINAL. Digits, a separator, then the name: "1 · Sources",
// "2. Pull", "3) Tag", "4 - Reconcile". The separator is REQUIRED, so
// "2 factor auth" and "PostgreSQL 16/17" are ordinary labels and are never
// reordered. Nothing is written back to the document — this reads a label, it
// never rewrites one (§1.4).

import type { GraphDoc } from '@diagram-engine/core';
import type { ElkExtendedEdge } from 'elkjs';

/**
 * Prefix of a synthetic ordering edge's id.
 *
 * Document ids match `^[a-z][a-z0-9-]{0,47}$` (§3.1), so an id starting with
 * two underscores can never collide with one an author wrote. That is what
 * lets fromElk recognise these by name alone, with no second channel to keep
 * in sync — and it is why the prefix must stay illegal under IdSchema.
 */
export const ORDER_EDGE_PREFIX = '__order:';

/** True for an edge this module invented, in any ELK output. */
export function isOrderingEdge(id: string): boolean {
  return id.startsWith(ORDER_EDGE_PREFIX);
}

/**
 * The ordinal a label states, or undefined when it states none.
 *
 * The separator is what makes this safe: without it "2 factor auth" would be
 * step 2 of something.
 */
export function leadingOrdinal(label: string): number | undefined {
  const m = /^\s*(\d{1,3})\s*[·.):\-–—]\s+/.exec(label);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Children of each container, in the order toElk pushes them. */
function siblingsByParent(
  doc: GraphDoc,
): Map<string | null, { id: string; label: string }[]> {
  const out = new Map<string | null, { id: string; label: string }[]>();
  const push = (parent: string | null, el: { id: string; label: string }): void => {
    const list = out.get(parent);
    if (list === undefined) out.set(parent, [el]);
    else list.push(el);
  };
  // Groups before nodes, matching toElk's passes, so model order agrees.
  for (const g of doc.groups) push(g.parent, { id: g.id, label: g.label });
  for (const n of doc.nodes) push(n.parent, { id: n.id, label: n.label });
  return out;
}

/**
 * The ordering edges for one document, keyed by the container they belong in
 * (null = the ELK root). Empty for every document that numbers nothing, so
 * those lay out exactly as they did.
 *
 * Rules, each of which exists to avoid asserting something the author did not:
 *
 *  - Only siblings. An ordinal in one container says nothing about an ordinal
 *    in another; "2 · Pull" and "2 · Map" are different sequences.
 *  - At least TWO distinct ordinals, or there is no order to state.
 *  - Consecutive ordinals only, ascending. Gaps are fine — 2, 3, 5 chains as
 *    2 to 3 to 5 — because a gap means a stage that lives somewhere else, not
 *    a stage that does not exist.
 *  - UNNUMBERED siblings are left entirely unconstrained. The author numbered
 *    a flow and left the rest out of it; inventing a position for them would
 *    be a claim, and ELK is free to place them where the real edges want.
 *  - An ordering edge is SKIPPED where a real edge already runs that way. The
 *    constraint is already stated, and a duplicate would only add edge spacing
 *    between two boxes that are already correctly ranked.
 */
export function orderingEdges(doc: GraphDoc): Map<string | null, ElkExtendedEdge[]> {
  const real = new Set(doc.edges.map((e) => `${e.from} ${e.to}`));
  const out = new Map<string | null, ElkExtendedEdge[]>();

  for (const [parent, children] of siblingsByParent(doc)) {
    // ordinal -> the ids that carry it, in document order.
    const byOrdinal = new Map<number, string[]>();
    for (const c of children) {
      const n = leadingOrdinal(c.label);
      if (n === undefined) continue;
      const list = byOrdinal.get(n);
      if (list === undefined) byOrdinal.set(n, [c.id]);
      else list.push(c.id);
    }
    if (byOrdinal.size < 2) continue;

    const steps = [...byOrdinal.keys()].sort((a, b) => a - b);
    const edges: ElkExtendedEdge[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
      const from = byOrdinal.get(steps[i] as number) as string[];
      const to = byOrdinal.get(steps[i + 1] as number) as string[];
      // Every member of one step precedes every member of the next. In
      // practice a stage number names one box, so this is one edge; it stays
      // a full product so a stage split across two boxes is still ordered.
      for (const a of from) {
        for (const b of to) {
          if (real.has(`${a} ${b}`)) continue;
          edges.push({
            id: `${ORDER_EDGE_PREFIX}${a}>${b}`,
            sources: [a],
            targets: [b],
          });
        }
      }
    }
    if (edges.length > 0) out.set(parent, edges);
  }
  return out;
}
