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
// Pure function; no DOM. Model order (doc array order) is preserved
// everywhere so 'considerModelOrder' keeps layouts stable across turns.

import type { GraphDoc } from '@diagram-engine/core';
import type { ElkExtendedEdge, ElkNode } from 'elkjs';
import { sizeNode } from './measure.js';
import { GROUP_OPTIONS, ROOT_OPTIONS } from './options.js';

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
  for (const n of doc.nodes) {
    parentOf.set(n.id, n.parent);
    const { width, height } = sizeNode(n);
    const parent = (n.parent !== null && containers.get(n.parent)) || root;
    parent.children!.push({ id: n.id, width, height });
  }

  // Pass 4: edges, each declared in the LCA container of its endpoints.
  for (const e of doc.edges) {
    const edge: ElkExtendedEdge = {
      id: e.id,
      sources: [e.from],
      targets: [e.to],
    };
    const container = lcaContainer(e.from, e.to, parentOf, containers) ?? root;
    container.edges!.push(edge);
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
