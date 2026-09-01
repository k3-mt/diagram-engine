// layout/flow.ts — which way the diagram READS (spec §5.5).
//
// THE PROBLEM. An edge's direction in the document is its DEPENDENCY
// direction: caller to callee, fixed by rule 4, and that is the graph
// `analyse` and `blastRadius` walk. ELK ranks nodes by that same direction —
// the source of an edge lands in an earlier layer than its target — so with
// `direction: "DOWN"` a diagram reads top-to-bottom in DEPENDENCY order.
//
// For most of a system those two orders agree. For a PULL they do not. A
// pipeline that fetches from a government data portal depends on the portal,
// so the edge runs pipeline -> portal; ELK therefore ranks the portal LAST
// and drops every external source to the bottom of the picture, with its
// edges travelling the full height of the diagram to get there. The reader
// sees the system upside down: the things the data comes FROM are drawn after
// the things it goes TO.
//
// THE FIX, AND ITS LIMIT. §3.9's `kind` finally says which way data moves, so
// the layout can rank by the direction the reader follows while the document
// keeps the direction the analysis needs. One edge, three consumers, three
// directions — and no new field, no new setting.
//
// But "reverse every pull" is too blunt, and the evidence says so. Take rule
// 4's own example, `orders --read--> postgres`: reversing it for layout floats
// the DATABASE to the top of the diagram, level with the web client. That is
// wrong by every convention, and it is the single most common edge in the
// corpus.
//
// So the rule is narrower, and it is about where data ENTERS THE SYSTEM:
//
//   A pull (`read` / `consume`) whose far end is a node the system does NOT
//   deploy — `external` or `client`, the two types rule 8 defines by their
//   ownership — is data arriving from outside. That node is the beginning of
//   the flow, so it is ranked FIRST.
//
// Everything else is untouched. A service reading its own database, a queue,
// a cache or a bucket is a dependency INSIDE the system: the store is drawn
// after the service that uses it, exactly as before. Measured on both cases:
// the pipeline's sources rise from the bottom of the picture to the top,
// while the canonical service-reads-database layout does not move by a pixel.
//
// Pure functions, no DOM. This changes only where ELK puts things; it never
// touches the document (§1.4/§3.1), and the geometry it produces is
// re-oriented back to document order by fromElk so the renderer, the
// arrowheads and the step badges never learn it happened.

import type { GraphDoc, NodeType } from '@diagram-engine/core';

/**
 * The node types the system does not deploy (rule 8's ownership axis).
 * Data pulled from one of these is data entering the system.
 */
export const OUTSIDE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'external',
  'client',
]);

/**
 * Ids of the edges whose LAYOUT rank should run opposite to their document
 * direction — see the header. Empty for every document that uses no `kind`,
 * which is every document written before §3.9, so their layouts are
 * unchanged to the pixel.
 */
export function flowReversedEdgeIds(doc: GraphDoc): Set<string> {
  const typeOf = new Map(doc.nodes.map((n) => [n.id, n.type]));
  const out = new Set<string>();
  for (const e of doc.edges) {
    if (e.kind !== 'read' && e.kind !== 'consume') continue;
    // The far end is the TARGET: a pull runs consumer -> producer.
    const far = typeOf.get(e.to);
    // `undefined` means the target is a GROUP, not a node. A group has no
    // ownership type, so there is nothing here that says the data comes from
    // outside — leave it ranked as the dependency says.
    if (far !== undefined && OUTSIDE_TYPES.has(far)) out.add(e.id);
  }
  return out;
}
