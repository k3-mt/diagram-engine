// layout/toElk.ts — GraphDoc -> ELK graph JSON (spec §5.1/§5.2).
//
// Builds the nested ELK input graph: groups become containers nested
// per the group parent chain (each with GROUP_OPTIONS — the top=44
// padding is the label space), nodes get dimensions from sizeNode,
// the root gets ROOT_OPTIONS, and every edge is declared in the
// lowest common ancestor container of its endpoints. That LCA
// placement matters for §5.3: ELK returns edge section coordinates
// relative to the container the edge is declared in, so fromElk must
// walk the same containers.
//
// Edges whose endpoints are groups (§3.1 allows it) target the group
// node itself — groups and nodes share one id namespace, so the group
// id goes straight into sources/targets.
//
// STATED ORDER (§5.6). A label that starts with an ordinal — "1 · Sources",
// "2 · Pull" — is a reading order the author wrote down, and it is applied
// here as an ELK layer partition so siblings are drawn in that order even
// when no edge runs between them. See layout/order.ts.
//
// READING ORDER (§5.5). ELK ranks a node by the direction of the edges
// touching it, so a few edges are declared to ELK REVERSED — see
// layout/flow.ts for which and why. That is a layout-rank decision only: the
// document is untouched, and fromElk turns the resulting polyline back into
// document order so nothing downstream knows it happened.
//
// Pure function; no DOM. Model order (doc array order) is preserved
// everywhere so 'considerModelOrder' keeps layouts stable across turns.

import type { GraphDoc } from '@diagram-engine/core';
import type { ElkExtendedEdge, ElkNode } from 'elkjs';
import { flowReversedEdgeIds } from './flow.js';
import { orderingEdges } from './order.js';
import { EDGE_LABEL_FONT, EDGE_LABEL_H, measureText, sizeNode } from './measure.js';
import { EDGE_LABEL_OPTIONS, GROUP_OPTIONS, ROOT_OPTIONS } from './options.js';

/** Id of the synthetic ELK root container. */
export const ELK_ROOT_ID = 'root';



/**
 * Convert a GraphDoc into the ELK input graph. Geometry produced from
 * this is viewer-side only and never persisted (spec §1.4/§3.1).
 */
export function toElk(doc: GraphDoc): ElkNode {
  const root: ElkNode = {
    id: ELK_ROOT_ID,
    layoutOptions: ROOT_OPTIONS(doc.direction),
    children: [],
    edges: [],
  };

  // element id -> parent group id (nodes and groups share a namespace)
  const parentOf = new Map<string, string | null>();
  // group id -> its ELK container
  const containers = new Map<string, ElkNode>();

  // Pass 1: create every group container (so forward parent references
  // resolve regardless of array order).
  for (const g of doc.groups) {
    parentOf.set(g.id, g.parent);
    containers.set(g.id, {
      id: g.id,
      layoutOptions: { ...GROUP_OPTIONS },
      children: [],
      edges: [],
    });
  }

  // Pass 2: nest each group under its parent chain, in model order.
  for (const g of doc.groups) {
    const parent = (g.parent !== null && containers.get(g.parent)) || root;
    parent.children!.push(containers.get(g.id)!);
  }

  // Pass 3: nodes, sized by sizeNode, in model order.
  // ERD entities need nothing special here: sizeNode already returns the
  // taller table box for an `entity` with fields, and ELK treats it as an
  // ordinary fixed-size child. No per-node layoutOptions are set for them
  // on purpose — a different node placement strategy for entities would
  // make an ERD lay out unlike every other diagram in the same document.
  for (const n of doc.nodes) {
    parentOf.set(n.id, n.parent);
    const { width, height } = sizeNode(n);
    const parent = (n.parent !== null && containers.get(n.parent)) || root;
    parent.children!.push({ id: n.id, width, height });
  }

  // Pass 4: edges, each declared in the LCA container of its endpoints.
  // A labelled edge declares its label to ELK (sized at the smaller
  // EDGE_LABEL_FONT) so layout reserves space and places it inline on
  // the edge path (EDGE_LABEL_OPTIONS); fromElk reads the position back.
  //
  // A flow-reversed edge (§5.5) is declared with its endpoints SWAPPED, which
  // is the only way to tell ELK to rank the far end first — there is no
  // per-edge "rank me backwards" option. The swap is invisible past this
  // point: the LCA is symmetric so the container is unchanged, and fromElk
  // reverses the returned polyline back into document order.
  const flowReversed = flowReversedEdgeIds(doc);
  for (const e of doc.edges) {
    const reversed = flowReversed.has(e.id);
    const edge: ElkExtendedEdge = {
      id: e.id,
      sources: [reversed ? e.to : e.from],
      targets: [reversed ? e.from : e.to],
    };
    if (e.label !== undefined) {
      edge.labels = [
        {
          text: e.label,
          width: measureText(e.label, EDGE_LABEL_FONT),
          height: EDGE_LABEL_H,
          layoutOptions: { ...EDGE_LABEL_OPTIONS },
        },
      ];
    }
    const container = lcaContainer(e.from, e.to, parentOf, containers) ?? root;
    container.edges!.push(edge);
  }

  // Pass 5: §5.6's ordering edges — invisible, and declared in the container
  // whose children they order (both endpoints are its direct children, so
  // that container IS the LCA). They carry no label and are dropped by
  // fromElk, so nothing downstream can draw one; what they buy is the layer
  // ordering the numbered labels asked for.
  for (const [parent, edges] of orderingEdges(doc)) {
    const container = (parent !== null && containers.get(parent)) || root;
    container.edges!.push(...edges);
  }

  return root;
}

/**
 * Ancestor group chain of an element, from immediate parent upward.
 * Starts at the parent (not the element itself), so an edge whose
 * endpoint IS a group is contained by that group's ancestor, never by
 * the group it connects. Cycle-guarded for robustness even though V4
 * forbids parent cycles.
 */
function ancestorChain(
  id: string,
  parentOf: Map<string, string | null>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let p = parentOf.get(id) ?? null;
  while (p !== null && !seen.has(p)) {
    chain.push(p);
    seen.add(p);
    p = parentOf.get(p) ?? null;
  }
  return chain;
}

/**
 * Lowest common ancestor container of two endpoints, or undefined when
 * the LCA is the root (no shared group ancestor).
 */
function lcaContainer(
  from: string,
  to: string,
  parentOf: Map<string, string | null>,
  containers: Map<string, ElkNode>,
): ElkNode | undefined {
  const toAncestors = new Set(ancestorChain(to, parentOf));
  for (const a of ancestorChain(from, parentOf)) {
    if (toAncestors.has(a)) return containers.get(a);
  }
  return undefined;
}
