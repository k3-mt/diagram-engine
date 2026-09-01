// view/depth.ts — the view as a RULE: which container LEVEL is collapsed.
//
// doc.collapsed answers "which groups are shut" with a list of ids, which is
// an answer about the document as it stood when someone asked. It goes stale
// in three ordinary ways: a group is renamed, a group is added (it renders
// open because nobody named it), or the whole diagram is wrapped in a new
// outer boundary — at which point `exec` collapses that single wrapper and the
// diagram reads as one box.
//
// doc.view.depth stores the intent instead. Depth is measured in containers,
// counting from the outside in:
//
//   depth 0   the top-level groups
//   depth 1   their children
//   depth N   N boundaries in from the top
//
// `{"depth": N}` means "draw containers down to N levels open, collapse the
// groups AT level N". So depth 0 shuts every top-level boundary (the diagram
// reads as N boxes), depth 1 opens those and shuts their children, and a depth
// past the bottom of the tree collapses nothing.
//
// Collapsing exactly the groups AT that level — not every group at or below it
// — matters: a group inside a collapsed group is already invisible, so naming
// it too would pad `collapsed` with ids that change nothing and make the
// stored view harder to read. deriveView tolerates either; the shorter list is
// the honest one.
//
// Nothing here writes geometry, and nothing here decides what a collapsed box
// looks like: this module maps a document plus a depth to a list of ids, and
// deriveView does the rest.

import type { GraphDoc } from '../schema/graph.js';
import { MAX_VIEW_DEPTH } from '../schema/graph.js';

/**
 * How many boundaries enclose `id`: 0 for a top-level group, 1 for a group
 * inside one, and so on. Nodes and groups share the id namespace and both
 * carry `parent`, so this works from either, and an unknown id is treated as
 * top level rather than throwing — a malformed parent chain is V4's business,
 * not this module's. A parent cycle terminates on the seen set instead of
 * spinning.
 */
export function depthOf(doc: GraphDoc, id: string): number {
  const parentOf = new Map<string, string | null>();
  for (const n of doc.nodes) parentOf.set(n.id, n.parent);
  for (const g of doc.groups) parentOf.set(g.id, g.parent);

  let depth = 0;
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    depth += 1;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return depth;
}

/** The group ids sitting exactly `depth` boundaries in, in document order. */
export function groupsAtDepth(doc: GraphDoc, depth: number): string[] {
  return doc.groups.filter((g) => depthOf(doc, g.id) === depth).map((g) => g.id);
}

/** The deepest level that holds any group — 0 for a document with no nesting. */
export function maxGroupDepth(doc: GraphDoc): number {
  let max = 0;
  for (const g of doc.groups) {
    const d = depthOf(doc, g.id);
    if (d > max) max = d;
  }
  return max;
}

/**
 * The collapsed list a stored depth resolves to. A depth deeper than the tree
 * collapses nothing, which is `eng` — the right answer, and not an error: the
 * depth may become meaningful again the moment a group is nested.
 */
export function collapsedAtDepth(doc: GraphDoc, depth: number): string[] {
  return groupsAtDepth(doc, depth);
}

/**
 * The depth `exec` means: the shallowest level holding MORE THAN ONE group.
 *
 * "The boardroom view" is a handful of boxes, and a level with a single group
 * on it is not a summary of anything — it is one box saying the name of the
 * system. That is the case this function exists for: wrap four stages in one
 * "Source registry" boundary and the old rule (collapse every top-level group)
 * collapses the whole diagram to that wrapper. Skipping singleton levels makes
 * `exec` mean "the outermost level that actually divides the system", which is
 * what it always meant on a document that happened not to have a wrapper.
 *
 * A document whose every level holds one group (a straight chain of nesting)
 * has no dividing level at all, so it falls back to 0 and reads as one box —
 * which is an honest picture of a diagram shaped like that.
 */
export function execDepth(doc: GraphDoc): number {
  const limit = Math.min(maxGroupDepth(doc), MAX_VIEW_DEPTH);
  for (let d = 0; d <= limit; d += 1) {
    if (groupsAtDepth(doc, d).length > 1) return d;
  }
  return 0;
}

/**
 * Bring `collapsed` back in line with a stored `view.depth`.
 *
 * Called on every structural change (applyPatch, and import for the document
 * it is handed), which is the whole point of storing the rule: add a stage,
 * rename a group, reparent a boundary, and the view still means what it said.
 * A document with no `view` is returned untouched — an explicit list is a
 * deliberate choice and this must never silently overwrite it.
 *
 * Pure: returns the same object when nothing changes, so callers can compare
 * by identity to decide whether anything moved.
 */
export function reconcileView(doc: GraphDoc): GraphDoc {
  if (doc.view === undefined) return doc;
  const collapsed = collapsedAtDepth(doc, doc.view.depth);
  const same =
    collapsed.length === doc.collapsed.length &&
    collapsed.every((id, i) => id === doc.collapsed[i]);
  return same ? doc : { ...doc, collapsed };
}
