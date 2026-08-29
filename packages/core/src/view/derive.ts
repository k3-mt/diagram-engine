// view/derive.ts — the collapse-and-merge pass (spec Part 7).
//
// deriveView(doc, collapsed) turns the stored document plus a list of group
// ids into the document that actually gets DRAWN. It is pure, allocates a
// fresh document every time, never mutates its input, and never throws: it
// sits on the render hot path (a status-bar button press must repaint in
// under a frame), so it has no I/O, no validation pass and no error channel.
// presets.ts already owns "which groups", with proper messages; this module
// owns "what does that look like".
//
// The shape of the pass:
//   1. every descendant of a collapsed group disappears
//   2. each collapsed group reappears as a single node in its place
//   3. every edge endpoint is rewritten to the collapsed ancestor
//   4. edges that became internal (both ends rewrote to the same id) are
//      dropped — an exec reader does not need to know two things inside the
//      VPC talk to each other
//   5. the survivors are bucketed by (from, to) and merged, carrying a count
//
// -------------------------------------------------------------------------
// Decisions the spec sketch leaves open, and why
// -------------------------------------------------------------------------
//
// 1. WHAT A COLLAPSED GROUP RENDERS AS. The sketch gives the synthetic node
//    `type: 'service'`. A collapsed VPC drawn with a blue service icon is a
//    lie: it claims "this is one application you own" about a boundary that
//    holds eleven things. The honest fix would be a ninth NodeType, but the
//    type enum is a published contract — it is in the MCP tool schema the
//    agent reads, in rules.md, and pinned byte-for-byte by schema.test.ts —
//    so a render-time concern must not widen it. Instead:
//      * `type` is `external` (COLLAPSED_NODE_TYPE). Of the eight types it is
//        the only NEUTRAL one — grey accent, "an opaque box whose insides are
//        not shown here", which is exactly what a collapsed group is. A
//        renderer that knows nothing about collapse degrades to a neutral
//        grey box rather than to a confident wrong claim.
//      * the groupness is carried additively in `meta`, under the reserved
//        key COLLAPSED_META_KEY (`collapsed`), whose VALUE is the group's own
//        kind ("vpc", "region", …). `meta` is free-form string detail that is
//        already allowed on every node, already schema-valid, and already
//        surfaced by the hover panel, so nothing new enters the type system.
//        A renderer that wants a proper collapsed-boundary glyph tests
//        isCollapsedGroupNode(n) and reads the kind from that value. Two do,
//        and they must: NodeBox.nodeIcon() draws a dashed boundary rather
//        than NODE_ICONS.external (a CLOUD, documented as "a third party you
//        don't control" — a confident wrong claim about the reader's own
//        VPC), and HoverCard says "collapsed vpc" in its kind line instead of
//        listing the reserved key beside the author's own metadata.
//    The node keeps the group's label and parent, so it lands in the same
//    place in the containment tree the group occupied, and layout treats it
//    as an ordinary leaf.
//
// 2. THE MERGED LABEL, AND STYLE WHEN CONSTITUENTS DISAGREE. The sketch sets
//    `label = "×3"`, throwing away every verb. "×3" alone tells the reader
//    there are three relationships but not what any of them is, which is the
//    wrong half to keep. So the count is APPENDED, not substituted:
//      * all constituents share one label -> `reads ×3` (truncated with an
//        ellipsis if that exceeds the 24-char edge-label bound, V9)
//      * labels disagree, or there are none -> `×3` alone. Picking one verb
//        out of {reads, publishes, verifies} and printing it over three
//        merged relationships would be a fabrication; the bare count is the
//        most that is true.
//    `style`: dashed is the more SPECIFIC claim (async / optional), solid is
//    the default, so dashed survives only when unanimous — mixing one solid
//    and one dashed yields solid. `arrow` merges as a union of what is drawn:
//    any `both` wins, else any `forward` wins, else `none`. A missing
//    property counts as its default (solid, forward) so an explicit value and
//    an omitted one never disagree spuriously.
//    A bucket of ONE is left completely alone — same id, label, style,
//    cardinality — because the overwhelmingly common case (eng view, nothing
//    collapsed) must be byte-identical to the input.
//    The merged edge inherits the FIRST constituent's id: it is already a
//    valid, unique slug present in the document, which keeps the viewer's
//    keying stable across a collapse/expand instead of inventing a synthetic
//    id that could collide with a real one.
//
// 3. AN EDGE THAT POINTED AT THE COLLAPSED GROUP ITSELF. `from`/`to` may name
//    a group (§3.1), so `web-client -> vpc-private` is legal before any
//    collapse. Such an edge is NOT special-cased: the collapsed group maps to
//    itself, so the edge simply survives and lands in the same bucket as the
//    edges rewritten out of that group's insides. `web-client -> vpc-private`
//    plus `web-client -> postgres (inside the vpc)` becomes one edge `×2`,
//    which is the truth. And an edge from a node INSIDE the group to the
//    group itself becomes internal by the same rule, and is dropped.
//
// 4. CARDINALITY ON A MERGED EDGE (§3.6). Two relationships with different
//    multiplicities cannot both be drawn by one pair of crow's-foot markers,
//    and drawing `1:1` over a merge that contains an `N:M` is a false claim
//    about the data model. Worse, cardinality needs an `entity` endpoint
//    (V13) and a collapsed group node is not an entity, so keeping it would
//    also produce a document that fails validation. So cardinality survives
//    ONLY on an edge that was neither rewritten nor merged — i.e. an ERD edge
//    the collapse never touched. Everywhere else it is dropped, and the count
//    in the label is what remains.
//
// 5. NESTED COLLAPSE — the sketch does not handle it. THE OUTER GROUP WINS.
//    If `vpc-private` is collapsed inside a collapsed `region-eu`, the vpc is
//    a descendant of the region: it disappears entirely, contributes no
//    synthetic node of its own, and everything under it rewrites all the way
//    out to `region-eu`. Any other reading would have to draw a box inside a
//    box the reader was told is closed.
//
// 6. AN UNKNOWN COLLAPSED ID, OR ONE NAMING A NODE, IS IGNORED — not an
//    error. Two reasons. Stale state: `collapsed` is persisted, so a patch
//    that deletes a group leaves a dangling id behind, and the viewer must
//    degrade to showing that group's contents rather than refusing to draw.
//    And IDEMPOTENCE: after one pass `vpc-private` names a NODE, so
//    deriveView(deriveView(doc, c), c) === deriveView(doc, c) falls out for
//    free instead of needing a second code path. Callers that want the
//    id checked have resolvePreset() and the CLI's own check.
//
// Determinism: synthetic nodes are emitted in doc.groups order (not in the
// caller's `collapsed` order) and merged edges in doc.edges order, so two
// callers passing the same set in a different order get identical output.

import type {
  GEdge,
  GGroup,
  GNode,
  GraphDoc,
  NodeType,
} from '../schema/graph.js';

/** Edge-label bound from §3.1 / V9; the merged label is truncated to it. */
const EDGE_LABEL_MAX = 24;

/** The type a collapsed group is drawn as. See decision 1 in the header. */
export const COLLAPSED_NODE_TYPE: NodeType = 'external';

/**
 * The reserved `meta` key marking a node as a stand-in for a collapsed group.
 * Its value is the group's kind ("vpc", "region", "cluster", "account",
 * "generic"), so a renderer can pick a boundary glyph without a type change.
 */
export const COLLAPSED_META_KEY = 'collapsed';

/** The separator between a merged edge's label and its count: `reads ×3`. */
export const MERGE_COUNT_PREFIX = '×';

/**
 * True when `node` is the synthetic stand-in deriveView emitted for a
 * collapsed group. Renderers use it to draw a boundary rather than a service.
 */
export function isCollapsedGroupNode(node: GNode): boolean {
  return node.meta?.[COLLAPSED_META_KEY] !== undefined;
}

/** The kind of the group a collapsed stand-in replaces, or undefined. */
export function collapsedGroupKind(node: GNode): string | undefined {
  return node.meta?.[COLLAPSED_META_KEY];
}

/** parent-of map over BOTH namespaces — nodes and groups share ids (§3.1). */
function parentMap(doc: GraphDoc): Map<string, string | null> {
  const parentOf = new Map<string, string | null>();
  for (const n of doc.nodes) parentOf.set(n.id, n.parent);
  for (const g of doc.groups) parentOf.set(g.id, g.parent);
  return parentOf;
}

/**
 * Every id contained in group `gid`, at any depth — nodes and nested groups
 * alike, in document order (groups first, then nodes, as doc.groups and
 * doc.nodes are scanned in turn). Cycle-safe: V4 rejects a parent cycle, but
 * this module never assumes validation ran.
 */
export function descendantsOf(doc: GraphDoc, gid: string): string[] {
  const parentOf = parentMap(doc);
  const inside = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id) ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (cur === gid) return true;
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };
  const out: string[] = [];
  for (const g of doc.groups) if (g.id !== gid && inside(g.id)) out.push(g.id);
  for (const n of doc.nodes) if (inside(n.id)) out.push(n.id);
  return out;
}

/** Dedupe preserving first-seen order. */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** `3 components`, `1 component`, or `empty group` for a childless one. */
function componentNote(count: number): string {
  if (count === 0) return 'empty group';
  return count === 1 ? '1 component' : `${count} components`;
}

/** `reads ×3`, ellipsised to fit the 24-char edge-label bound. */
function mergedLabel(labels: readonly (string | undefined)[]): string {
  const suffix = `${MERGE_COUNT_PREFIX}${labels.length}`;
  const first = labels[0];
  const agreed =
    first !== undefined && labels.every((l) => l === first) ? first : undefined;
  if (agreed === undefined) return suffix;
  const full = `${agreed} ${suffix}`;
  if (full.length <= EDGE_LABEL_MAX) return full;
  // Keep the count — it is the part the merge added — and clip the verb.
  const room = EDGE_LABEL_MAX - suffix.length - 2; // space + ellipsis
  return room > 0 ? `${agreed.slice(0, room)}… ${suffix}` : suffix;
}

/** Dashed only when unanimous; a missing style means solid. */
function mergedStyle(edges: readonly GEdge[]): 'solid' | 'dashed' {
  return edges.every((e) => e.style === 'dashed') ? 'dashed' : 'solid';
}

/** Union of what is drawn: any `both` wins, then any `forward`, else `none`. */
function mergedArrow(edges: readonly GEdge[]): 'forward' | 'both' | 'none' {
  const arrows = edges.map((e) => e.arrow ?? 'forward');
  if (arrows.includes('both')) return 'both';
  if (arrows.includes('forward')) return 'forward';
  return 'none';
}

/** What one derived edge was built from, for hover panels and export. */
export type MergedEdgeSources = {
  /** id of the edge in the derived document */
  id: string;
  /** ids of the original edges it stands for, in document order (≥1) */
  sources: string[];
};

/** deriveView's result plus the bookkeeping a renderer may want to show. */
export type DerivedView = {
  /** the document to draw */
  doc: GraphDoc;
  /** collapsed group ids that actually resolved to a group, in doc order */
  collapsedGroups: string[];
  /** ids hidden by the collapse (descendants of a collapsed group) */
  hidden: string[];
  /** every derived edge and the original edges behind it */
  edges: MergedEdgeSources[];
};

/**
 * Collapse `collapsed` and merge the resulting edges (spec Part 7).
 *
 * Pure: `doc` is never mutated, and no element of the result aliases an
 * element of the input that this pass modified. Idempotent — see decision 6.
 * Defaults to the document's own stored `collapsed` list.
 */
export function deriveView(
  doc: GraphDoc,
  collapsed: readonly string[] = doc.collapsed,
): GraphDoc {
  return deriveViewDetail(doc, collapsed).doc;
}

/**
 * deriveView plus the merge bookkeeping: which ids were hidden and which
 * original edges are behind each drawn edge. Same pass, richer return.
 */
export function deriveViewDetail(
  doc: GraphDoc,
  collapsed: readonly string[] = doc.collapsed,
): DerivedView {
  const requested = unique(collapsed);
  const groupById = new Map<string, GGroup>(doc.groups.map((g) => [g.id, g]));

  // Decision 6: ids that do not name a group are carried through in the
  // document's `collapsed` field but have no effect on the drawing.
  const targets = requested.filter((id) => groupById.has(id));

  // ---- 1. hide descendants, and map every hidden id to the OUTERMOST
  // collapsed ancestor (decision 5: the outer group wins).
  const parentOf = parentMap(doc);
  const targetSet = new Set(targets);

  /** Outermost collapsed ancestor of `id`, or undefined if it is not inside one. */
  const outermostCollapsedAncestor = (id: string): string | undefined => {
    let winner: string | undefined;
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id) ?? null;
    while (cur !== null && !seen.has(cur)) {
      if (targetSet.has(cur)) winner = cur;
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return winner;
  };

  /** Where an endpoint id ends up once the collapse is applied. */
  const rewrite = new Map<string, string>();
  const hidden = new Set<string>();
  for (const id of [...doc.groups.map((g) => g.id), ...doc.nodes.map((n) => n.id)]) {
    const anc = outermostCollapsedAncestor(id);
    if (anc !== undefined) {
      hidden.add(id);
      rewrite.set(id, anc);
    }
  }
  // A collapsed group that is not itself hidden maps to itself, which is what
  // makes decision 3 (an edge aimed at the group) need no special case.
  for (const id of targets) if (!hidden.has(id)) rewrite.set(id, id);

  /** The collapsed groups that actually survive as drawn boxes, in doc order. */
  const survivingTargets = doc.groups
    .filter((g) => targetSet.has(g.id) && !hidden.has(g.id))
    .map((g) => g.id);

  // ---- 2. each surviving collapsed group becomes one node in its place.
  const standIns: GNode[] = survivingTargets.map((gid) => {
    const g = groupById.get(gid) as GGroup;
    // Count only NODES: a reader counts components, not boundaries.
    const componentCount = descendantsOf(doc, gid).filter((id) =>
      doc.nodes.some((n) => n.id === id),
    ).length;
    return {
      id: g.id,
      label: g.label,
      type: COLLAPSED_NODE_TYPE,
      parent: g.parent,
      note: componentNote(componentCount),
      meta: { [COLLAPSED_META_KEY]: g.kind },
    };
  });

  // ---- 3/4/5. rewrite endpoints, drop the ones that became internal,
  // bucket the rest by (from, to) in document order.
  const buckets = new Map<string, { from: string; to: string; edges: GEdge[] }>();
  for (const e of doc.edges) {
    const from = rewrite.get(e.from) ?? e.from;
    const to = rewrite.get(e.to) ?? e.to;
    if (from === to) continue; // became internal to a collapsed group — drop
    const key = `${from}\x00${to}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.edges.push(e);
    else buckets.set(key, { from, to, edges: [e] });
  }

  const edges: GEdge[] = [];
  const sources: MergedEdgeSources[] = [];
  for (const { from, to, edges: group } of buckets.values()) {
    const first = group[0] as GEdge;
    if (group.length === 1) {
      // Untouched or merely rewritten: keep every property the author set.
      // Cardinality survives only when NEITHER endpoint moved (decision 4).
      const moved = from !== first.from || to !== first.to;
      const kept: GEdge = { ...first, from, to };
      if (moved) delete kept.cardinality;
      edges.push(kept);
    } else {
      edges.push({
        id: first.id,
        from,
        to,
        label: mergedLabel(group.map((e) => e.label)),
        style: mergedStyle(group),
        arrow: mergedArrow(group),
      });
    }
    sources.push({ id: first.id, sources: group.map((e) => e.id) });
  }

  const derived: GraphDoc = {
    ...doc,
    nodes: [...doc.nodes.filter((n) => !hidden.has(n.id)), ...standIns],
    groups: doc.groups.filter((g) => !hidden.has(g.id) && !targetSet.has(g.id)),
    edges,
    // The list the caller asked for, verbatim (minus duplicates), so a second
    // pass over the result is a no-op rather than a re-collapse.
    collapsed: requested,
  };

  return {
    doc: derived,
    collapsedGroups: survivingTargets,
    hidden: [...hidden],
    edges: sources,
  };
}
