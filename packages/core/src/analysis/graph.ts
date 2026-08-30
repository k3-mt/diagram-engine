// analysis/graph.ts — the runtime projection every signal is computed over
// (spec §15.2, §15.3 rules A2/A4/A5, §18.3).
//
// One module owns "what counts as the running system", because Part 15 and
// Part 18 must agree about it exactly. Blast radius is reverse reachability
// over the SAME edges Part 15 calls synchronous; two traversals built from two
// projections would drift, and the drift would be invisible — both halves
// would still print a confident ranked list.
//
// Three lines are drawn here and nowhere else:
//
//   A2  The projection is built from the FULL document. There is no parameter
//       for a derived view and no overload that takes one: `exec` collapses a
//       VPC into one box, and analysing that box hides the very chokepoints
//       inside it. deriveView() is a VIEWPORT control (spec §7); analysis is a
//       measurement, and a measurement of the picture is not a measurement of
//       the system.
//
//   A4  `entity` nodes and `cardinality` edges are EXCLUDED — an ERD is a data
//       model, not a runtime, and "bottleneck" over a foreign key is a
//       category error. Excluding them silently would be its own lie, so every
//       exclusion is counted, named and carried on the result (see Exclusions)
//       for the surface to print.
//
//   A5  Coverage is computed here too, so no caller can assemble a result that
//       omits it. An analysis that hides its own blind spots is worse than
//       none.
//
// A1 (analysis never mutates the document) is structural: nothing in this
// directory writes through a reference. `doc` is held on the projection only
// so the surface can read labels back out of it, and every array this module
// returns is freshly allocated. The tests run the whole surface over a
// deeply frozen document, which turns any accidental write into a throw.

import { COLLAPSED_META_KEY } from '../view/derive.js';
import type { GEdge, GGroup, GNode, GraphDoc } from '../schema/graph.js';

/** The node type that is a data model rather than a runtime component (A4). */
export const EXCLUDED_NODE_TYPE = 'entity';

/**
 * One edge of the runtime projection.
 *
 * `sync` is the whole of Part 15's second column and the whole of Part 18's
 * traversal rule, and it comes from one existing field: `style` absent means
 * solid means SYNCHRONOUS (spec §4.4 rule 6). No new schema — which is why
 * both parts are computable at all.
 */
export type RuntimeEdge = {
  id: string;
  from: string;
  to: string;
  /** solid, or style absent. A dashed edge is asynchronous and stops a cascade. */
  sync: boolean;
  label: string | null;
};

/**
 * What the projection left out, by name and by reason (A4).
 *
 * Every field is a list of ids rather than a count, because the surface is
 * expected to say WHICH elements it did not consider. "2 entity nodes
 * excluded" is the minimum; naming them is what lets a reader check the call.
 */
export type Exclusions = {
  /** `entity` nodes: a data model, not a runtime (A4) */
  entityNodes: string[];
  /** edges carrying `cardinality`: an ERD relationship, not a call (A4) */
  cardinalityEdges: string[];
  /** edges dropped because an endpoint is an excluded `entity` node */
  entityEdges: string[];
  /** edges whose endpoint names nothing in the document (V-invariants forbid
   *  this, but analysis must never throw on a document that dodged validation) */
  danglingEdges: string[];
  /** true when the document has entity nodes and NOTHING else — a pure ERD,
   *  where the honest answer is "this is a data model; there is no runtime here" */
  erdOnly: boolean;
};

/** Operational-metadata coverage over the runtime nodes (A5). */
export type Coverage = {
  /** runtime nodes considered (entity nodes are not counted; they are excluded) */
  nodes: number;
  withMeta: number;
  withoutMeta: number;
  /** ids carrying no operational meta, in document order */
  missing: string[];
  /** every operational meta key observed, sorted — this is what A3 attribution
   *  would have to name, so the surface can show what is available to attribute */
  keys: string[];
  /**
   * How many runtime nodes carry EACH key.
   *
   * `keys` alone is a union, and `withMeta` counts nodes carrying ANY key, so
   * printing the two side by side reads as "each of these keys is on N of M
   * nodes" — which inflates how well instrumented the document is, in the one
   * sentence A3 exists to govern. Per key is the only honest number, so it is
   * computed here and no surface has to derive it.
   */
  keyCounts: Record<string, number>;
};

/**
 * The document, projected to the part of it that describes a running system.
 *
 * Vertices are the non-entity NODES, plus any GROUP that an included edge
 * actually points at or away from. Groups are vertices because an edge
 * endpoint may legally be a group id (spec §3.1) and dropping such an edge
 * would silently understate fan-in; groups that no edge touches are left out
 * so they cannot pad a component count.
 */
export type RuntimeGraph = {
  /** the full document this was projected from (A2) — read-only to everything here */
  doc: GraphDoc;
  /** vertex ids: runtime nodes in document order, then participating groups */
  vertices: string[];
  /** the runtime nodes only, in document order (the things ranked and reported) */
  nodeIds: string[];
  nodeById: Map<string, GNode>;
  groupById: Map<string, GGroup>;
  /** vertex id -> position, so every list this package emits is deterministic */
  order: Map<string, number>;
  /** parent-of over BOTH namespaces; null is top level */
  parentOf: Map<string, string | null>;
  edges: RuntimeEdge[];
  /** vertex -> edges leaving it */
  out: Map<string, RuntimeEdge[]>;
  /** vertex -> edges arriving at it */
  in: Map<string, RuntimeEdge[]>;
  /** nodes with no inbound edge (spec §15.2: usually `client`, never assumed to be) */
  entryPoints: string[];
  excluded: Exclusions;
  coverage: Coverage;
};

/** True for a node the runtime projection excludes (A4). */
export function isRuntimeNode(node: GNode): boolean {
  return node.type !== EXCLUDED_NODE_TYPE;
}

/** True for a synchronous edge: solid, or `style` absent (spec §4.4 rule 6). */
export function isSyncEdge(edge: GEdge): boolean {
  return edge.style !== 'dashed';
}

/**
 * Operational meta on a node, minus the reserved keys the engine writes
 * itself. `collapsed` is deriveView's stand-in marker (spec Part 7); counting
 * it as coverage would let a collapsed box claim to be documented.
 */
export function operationalMetaKeys(node: GNode): string[] {
  if (node.meta === undefined) return [];
  return Object.keys(node.meta).filter((k) => k !== COLLAPSED_META_KEY);
}

/**
 * Project `doc` onto its runtime graph (A2, A4, A5).
 *
 * Pure and total: it never mutates, never throws, and copes with a document
 * that failed validation — a dangling edge endpoint is recorded, not raised.
 */
export function runtimeGraph(doc: GraphDoc): RuntimeGraph {
  const nodeById = new Map<string, GNode>(doc.nodes.map((n) => [n.id, n]));
  const groupById = new Map<string, GGroup>(doc.groups.map((g) => [g.id, g]));

  const parentOf = new Map<string, string | null>();
  for (const n of doc.nodes) parentOf.set(n.id, n.parent);
  for (const g of doc.groups) parentOf.set(g.id, g.parent);

  const entityNodes = doc.nodes.filter((n) => !isRuntimeNode(n)).map((n) => n.id);
  const entitySet = new Set(entityNodes);
  const runtimeNodes = doc.nodes.filter(isRuntimeNode);
  const nodeIds = runtimeNodes.map((n) => n.id);
  const runtimeNodeSet = new Set(nodeIds);

  // ---- edges: three exclusion reasons, each reported separately so the
  // surface can distinguish "you drew an ERD" from "your document is broken".
  const cardinalityEdges: string[] = [];
  const entityEdges: string[] = [];
  const danglingEdges: string[] = [];
  const edges: RuntimeEdge[] = [];
  const touchedGroups = new Set<string>();

  const endpointKind = (id: string): 'node' | 'group' | 'entity' | 'unknown' => {
    if (runtimeNodeSet.has(id)) return 'node';
    if (entitySet.has(id)) return 'entity';
    if (groupById.has(id)) return 'group';
    return 'unknown';
  };

  for (const e of doc.edges) {
    if (e.cardinality !== undefined) {
      cardinalityEdges.push(e.id);
      continue;
    }
    const fromKind = endpointKind(e.from);
    const toKind = endpointKind(e.to);
    if (fromKind === 'unknown' || toKind === 'unknown') {
      danglingEdges.push(e.id);
      continue;
    }
    if (fromKind === 'entity' || toKind === 'entity') {
      // An edge with no cardinality can still be an ERD edge by its endpoints
      // — "billing-db ⇢ invoices" in the mixed fixture. Same category error,
      // same exclusion, reported under its own heading.
      entityEdges.push(e.id);
      continue;
    }
    if (fromKind === 'group') touchedGroups.add(e.from);
    if (toKind === 'group') touchedGroups.add(e.to);
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      sync: isSyncEdge(e),
      label: e.label ?? null,
    });
  }

  const groupVertices = doc.groups.filter((g) => touchedGroups.has(g.id)).map((g) => g.id);
  const vertices = [...nodeIds, ...groupVertices];
  // `order` covers every group, participating or not, while `vertices` covers
  // only the participating ones. A group gains a vertex when an edge names it
  // and gains nothing otherwise, but it can still be a blast-radius TARGET
  // (`blast-radius vpc` kills a boundary no edge points at), and two places
  // sorting the same id — one treating a missing key as first, one as last —
  // made `killed` reorder when an unrelated edge was added. One map, one
  // convention: document order over both namespaces, nodes then groups.
  const order = new Map<string, number>();
  for (const id of [...nodeIds, ...groupVertices, ...doc.groups.map((g) => g.id)]) {
    if (!order.has(id)) order.set(id, order.size);
  }

  const out = new Map<string, RuntimeEdge[]>(vertices.map((id) => [id, []]));
  const inbound = new Map<string, RuntimeEdge[]>(vertices.map((id) => [id, []]));
  for (const e of edges) {
    out.get(e.from)?.push(e);
    inbound.get(e.to)?.push(e);
  }

  // Entry points: NODES nothing depends on (spec §15.2). Deliberately not
  // `type === 'client'` — an S3 bucket nothing writes to is an entry point of
  // the dependency graph whatever its icon says, and a client that something
  // calls back into is not one.
  //
  // "Nothing depends on it" includes the BOUNDARIES containing it: an edge
  // may name a group (§3.1), and a component inside a depended-on VPC is
  // depended upon. Reading only its own inbound edges made such a component an
  // entry point, which then excluded it from the §18.4 backlog — dropping a
  // real experiment on the grounds that killing it is like killing a browser.
  const dependedOn = (id: string): boolean => {
    if ((inbound.get(id) ?? []).length > 0) return true;
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id) ?? null;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      if ((inbound.get(cur) ?? []).length > 0) return true;
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };
  const entryPoints = nodeIds.filter((id) => !dependedOn(id));

  const missing: string[] = [];
  const keys = new Set<string>();
  const keyCounts: Record<string, number> = {};
  for (const n of runtimeNodes) {
    const k = operationalMetaKeys(n);
    if (k.length === 0) missing.push(n.id);
    for (const key of k) {
      keys.add(key);
      keyCounts[key] = (keyCounts[key] ?? 0) + 1;
    }
  }

  return {
    doc,
    vertices,
    nodeIds,
    nodeById,
    groupById,
    order,
    parentOf,
    edges,
    out,
    in: inbound,
    entryPoints,
    excluded: {
      entityNodes,
      cardinalityEdges,
      entityEdges,
      danglingEdges,
      erdOnly: entityNodes.length > 0 && nodeIds.length === 0,
    },
    coverage: {
      nodes: nodeIds.length,
      withMeta: nodeIds.length - missing.length,
      withoutMeta: missing.length,
      missing,
      keys: [...keys].sort(),
      keyCounts,
    },
  };
}

/** True when the projection dropped anything at all (A4: say so). */
export function hasExclusions(x: Exclusions): boolean {
  return (
    x.entityNodes.length > 0 ||
    x.cardinalityEdges.length > 0 ||
    x.entityEdges.length > 0 ||
    x.danglingEdges.length > 0
  );
}

/**
 * Document order for one id. An id the projection does not know sorts LAST —
 * the one convention, used everywhere, so an unrelated edge cannot reorder a
 * list by changing whether a group happens to be a vertex.
 */
export function documentRank(g: RuntimeGraph, id: string): number {
  return g.order.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/** Sort ids into document order. Every public list is ordered by this. */
export function byDocumentOrder(g: RuntimeGraph, ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => documentRank(g, a) - documentRank(g, b));
}

/**
 * The participating groups that contain `id`, innermost first.
 *
 * "Participating" means the group is a vertex of the projection — some edge
 * names it directly. An edge into a boundary is a dependency on what the
 * boundary holds (spec §3.1 allows a group endpoint), so a component inside it
 * inherits that boundary's dependents; a group nothing points at adds nothing
 * and is skipped, which is why a document whose edges never name a group is
 * completely unaffected by this.
 *
 * Cycle-safe: V4 forbids a parent cycle, this module does not assume
 * validation ran.
 */
export function participatingAncestors(g: RuntimeGraph, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = g.parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (g.groupById.has(cur) && g.out.has(cur)) out.push(cur);
    cur = g.parentOf.get(cur) ?? null;
  }
  return out;
}

/** A vertex's label, falling back to its id for a group or an unknown. */
export function labelOf(g: RuntimeGraph, id: string): string {
  return g.nodeById.get(id)?.label ?? g.groupById.get(id)?.label ?? id;
}

/**
 * Every id contained in group `gid` at any depth, nodes and nested groups
 * alike, in document order. Cycle-safe — V4 forbids a parent cycle, this
 * module does not assume validation ran.
 *
 * This is descendantsOf() from view/derive.ts recomputed against the
 * projection's parent map rather than imported, because analysis needs it over
 * a graph it already holds and must not depend on the view layer's traversal
 * of the document (A2: the view layer is the thing analysis refuses to use).
 */
export function descendantIds(g: RuntimeGraph, gid: string): string[] {
  const inside = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cur = g.parentOf.get(id) ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (cur === gid) return true;
      seen.add(cur);
      cur = g.parentOf.get(cur) ?? null;
    }
    return false;
  };
  const out: string[] = [];
  for (const grp of g.doc.groups) if (grp.id !== gid && inside(grp.id)) out.push(grp.id);
  for (const n of g.doc.nodes) if (inside(n.id)) out.push(n.id);
  return out;
}
