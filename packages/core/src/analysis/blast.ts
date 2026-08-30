// analysis/blast.ts — predicted blast radius and the experiment backlog
// (spec §18.3, §18.4, rules C1–C3).
//
// "If this node dies, what is at risk?" Because edge direction points at the
// dependency (§4.4 rule 4, caller → callee), the answer is REVERSE reachability
// over synchronous edges: follow the arrows BACKWARDS from the target.
//
// This file is only trustworthy because M8 was. Blast radius is computed
// entirely from direction — reverse the arrows and the prediction is not
// degraded, it is exactly inverted, and it arrives ranked and confident.
// §18.10 gate 2 held this behind a demonstrated direction score for that
// reason. Nothing here can detect a wrongly drawn arrow; it can only be
// correct about a document that was.
//
// Three details carry the weight (§18.3):
//
//   1. DASHED EDGES STOP PROPAGATION. That is the entire meaning of
//      asynchronous (§4.4 rule 6): a queue consumer does not fail
//      synchronously when its producer dies. Traversal halts, and the node on
//      the far side is reported as CONTAINED — by name, with the edge that
//      contained it. Containment is the design's own safety claim, and a claim
//      stated is a claim §18.8 can later test; a claim left as an absence is
//      just a shorter list.
//
//   2. KILLING A GROUP KILLS ITS DESCENDANTS. A VPC, region or AZ outage is
//      ONE experiment, and the group hierarchy already says which components
//      go with it.
//
//   3. BLAST RADIUS IS NOT AN ARTICULATION POINT. Part 15's articulation
//      points are undirected connectivity ("removing this splits the
//      diagram"); blast radius is directed dependency propagation ("these
//      specific things depend on it"). They usually agree and sometimes do
//      not, and the difference is informative. Both are on the result, neither
//      is derived from the other, and no field on this type lets a surface
//      merge them.
//
//   4. AN `alt` SET IS ONE DEPENDENCY, NOT SEVERAL (§18.11). Edges from one
//      source sharing an `alt` tag are ALTERNATIVES: failure reaches the
//      source only when every one of them is unavailable. That turns
//      propagation from a walk into a FIXPOINT, because whether a node is at
//      risk depends on whether its siblings are — see propagate() for the
//      rule, the case that proves it and the termination argument. An edge
//      with no `alt` is a hard dependency exactly as before, so a document
//      written before §18.11 gets bit-identical answers.
//
// C1 — the engine NEVER executes an experiment. There is no runner in this
// package and no place to add one: every export here is a pure function of a
// document. It is the map and the scoreboard, never the hand on the switch.
//
// C3 — AT RISK, never WILL FAIL. The document knows nothing of timeouts,
// retries, circuit breakers or graceful degradation, so the type is named
// `atRisk`, and `assumptions` travels with every result saying so. A ranked
// list of "will fail" reads better and is the claim the document cannot
// support.
//
// C4 and C5 (document hash, and results living in .diagram/chaos/, never in
// graph.json) belong to the surface and the store — no function here writes
// anything, and nothing here produces a value graph.json could hold.

import {
  byDocumentOrder,
  descendantIds,
  documentRank,
  labelOf,
  participatingAncestors,
  runtimeGraph,
  type Coverage,
  type Exclusions,
  type RuntimeEdge,
  type RuntimeGraph,
} from './graph.js';
import { blindSpotNotes } from './analyse.js';
import {
  articulationPoints,
  fanIn,
  type ArticulationPoint,
} from './signals.js';

import type { GraphDoc, NodeType } from '../schema/graph.js';

/** C3, in the one sentence every surface prints. */
export const ASSUMPTION_AT_RISK =
  '"at risk" is not "will fail": the document records no timeouts, retries or circuit breakers';

/** A boundary experiment's answer to "is this an articulation point?" (C3). */
export const ARTICULATION_NOT_APPLICABLE =
  'n/a — a boundary is not a single point of failure; killing it is this experiment';

/** C2, in the one sentence every surface prints. */
export const ASSUMPTION_SYNC_ONLY =
  'synchronous edges only: a dashed edge stops propagation and its far side is reported as contained';

/** What the id handed to blastRadius turned out to be. */
export type BlastTargetKind = 'node' | 'group' | 'entity' | 'unknown';

/** One thing that depends on the target, transitively and synchronously. */
export type AtRiskNode = {
  id: string;
  label: string;
  /** null for a group vertex, which has no NodeType */
  type: NodeType | null;
  /** 1 for a direct dependent, 2 for its caller, and so on */
  depth: number;
  /** the synchronous edge by which it was reached */
  via: string;
};

/**
 * A dependent the design says does NOT cascade, and the dashed edge that says
 * it. Reported by name because containment is a claim, not an absence (§18.3).
 */
export type ContainedNode = {
  id: string;
  label: string;
  /** the asynchronous edge that stopped the traversal */
  edge: string;
  /** the node on the far side of that edge — inside the blast radius */
  from: string;
  /** the edge's own label, e.g. "publishes", or null */
  edgeLabel: string | null;
};

/** The answer to "if this dies, what is at risk?" (§18.3). */
export type BlastRadius = {
  /** the id that was asked about, verbatim */
  target: string;
  targetKind: BlastTargetKind;
  label: string;
  /**
   * What the experiment takes out directly: the target, plus every descendant
   * when the target is a group (detail 2). Entity descendants are not here —
   * they are excluded from the runtime projection (A4).
   */
  killed: string[];
  /** everything that depends on the killed set, nearest first (C3: at risk) */
  atRisk: AtRiskNode[];
  /** dependents the dashed edges contain, by name (detail 1, C2) */
  contained: ContainedNode[];
  /**
   * Part 15's articulation-point finding for this target, or null. A SEPARATE
   * metric, reported alongside and never merged into the at-risk count
   * (detail 3). Always null for a group target: a boundary is not an
   * articulation point of the runtime graph.
   */
  articulation: ArticulationPoint | null;
  /** A5 — the analysis' own blind spots, carried into the prediction */
  coverage: Coverage;
  /** A4 — what the runtime projection left out */
  excluded: Exclusions;
  /** C2 and C3, plus the blind spots. Never empty. */
  assumptions: string[];
  /** set when the target could not be used: unknown id, or an entity node */
  note: string | null;
};

/** articulationPoints() as a lookup, so a caller sweeps at most once. */
export function articulationIndexOf(g: RuntimeGraph): Map<string, ArticulationPoint> {
  return new Map(articulationPoints(g).map((a) => [a.id, a]));
}

/**
 * The `articulation` line of §18.7, in core's words rather than each surface's.
 *
 * `articulation === null` means two different things — "computed, and the
 * answer is no" for a node, and "not applicable, never computed" for a group,
 * where blastRadiusOn sets it null unconditionally because a boundary is not
 * an articulation point of the runtime graph. A surface that branches on null
 * alone turns the second into an asserted negative, which is a structural
 * conclusion nothing derived. One sentence, read by the CLI, the MCP twin and
 * the viewer, is the only arrangement in which that cannot happen.
 */
export function articulationValue(r: BlastRadius): string {
  if (r.targetKind === 'group') return ARTICULATION_NOT_APPLICABLE;
  const a = r.articulation;
  if (a === null) return 'no — removing it does not split the diagram';
  const nodes = `${a.isolates} node${a.isolates === 1 ? '' : 's'}`;
  const pieces = `${a.components} piece${a.components === 1 ? '' : 's'}`;
  return a.isolates > 0
    ? `yes — removing it also isolates ${nodes}`
    : `yes — removing it splits the diagram into ${pieces}`;
}

/** The assumptions block: blind spots first, then the two claims C2 and C3 make. */
export function blastAssumptions(coverage: Coverage, excluded: Exclusions): string[] {
  return [...blindSpotNotes(coverage, excluded), ASSUMPTION_SYNC_ONLY, ASSUMPTION_AT_RISK];
}

/**
 * Every synchronous or asynchronous edge that arrives at `id` OR at a
 * boundary containing it.
 *
 * An edge may legally name a group as an endpoint (spec §3.1), and `client →
 * vpc` says client depends on that boundary. Group containment is not an edge
 * in `g.in`, so without this the components INSIDE the boundary inherit none
 * of its dependents: killing `api` inside a depended-on VPC reported nothing
 * at risk while killing the VPC itself reported the dependent correctly. That
 * is a silent under-report on the one command whose refusal path exists
 * because "nothing is at risk" is the most dangerous thing it can say by
 * accident, so containment is traversed.
 *
 * It is deliberately the weaker claim, not the stronger one: C3's verb is "at
 * risk", never "will fail", and an edge drawn to a boundary is a statement
 * that the boundary is depended on. Documents whose edges never name a group
 * — the overwhelming majority — get no ancestors here and behave exactly as
 * before.
 */
function inboundOf(g: RuntimeGraph, id: string): RuntimeEdge[] {
  const own = g.in.get(id) ?? [];
  const ancestors = participatingAncestors(g, id);
  if (ancestors.length === 0) return own;
  return [...own, ...ancestors.flatMap((gid) => g.in.get(gid) ?? [])];
}

/**
 * The edge of an exhausted alt set to blame: the LAST alternative to fall.
 *
 * There is no single edge behind an alt-set failure — that is the point of a
 * set — so `via` names the alternative that was still holding the source up,
 * which is the one whose loss actually cost it. Ties inside one wave go to the
 * earliest edge in document order, so the answer does not depend on the order
 * the traversal happened to visit the wave in.
 */
function lastToFall(set: readonly RuntimeEdge[], wave: ReadonlyMap<string, number>): string {
  let best = set[0]!;
  let bestWave = -1;
  for (const e of set) {
    const w = wave.get(e.id) ?? -1;
    if (w > bestWave) {
      bestWave = w;
      best = e;
    }
  }
  return best.id;
}

/**
 * The at-risk / contained sets for an already-killed set of vertices.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS A FIXPOINT AND NOT A WALK (§18.11)
 * ------------------------------------------------------------------------
 * With `alt`, a node is at risk when EITHER
 *
 *   (a) any synchronous NON-alt (hard) dependency is unavailable, or
 *   (b) for some alt tag on its outgoing edges, EVERY edge carrying that tag
 *       is unavailable,
 *
 * where UNAVAILABLE means killed OR at risk — a node presumed to be failing
 * cannot serve as a live alternative.
 *
 * Clause (b) makes the answer depend on siblings, which a single reverse walk
 * cannot see. The case that proves it:
 *
 *     X → A  (alt "db")      A → C
 *     X → B  (alt "db")      B → C
 *
 * Kill C. A is at risk; B is at risk; so every edge in X's "db" set is
 * unavailable and X is at risk too. A plain reverse-BFS reaches A, tries X,
 * finds B not yet marked and spares X — the answer would depend on visit
 * order, which is the signature of a missing fixpoint.
 *
 * So this computes the LEAST FIXPOINT of that rule, by monotone propagation
 * with a counter per alt set: each set starts with `set.length` live
 * alternatives and its source becomes at risk on the decrement that reaches
 * zero. Counters are the linear-time form of the fixpoint; re-scanning the
 * whole graph until nothing changes would compute the identical set.
 *
 * TERMINATION. The down set (killed ∪ at-risk) only ever GROWS — nothing is
 * ever unmarked, because both clauses are monotone in it: an unavailable
 * dependency never becomes available again. It is bounded by the number of
 * vertices, |V| = g.vertices.length, so at most |V| − |killed| vertices can
 * ever be added and the outer loop runs at most that many waves before the
 * frontier is empty. Each edge is marked down AT MOST ONCE (`edgeDown`), so
 * each edge contributes at most one counter decrement and one at-risk test:
 * the whole computation is O(V + E), the same order as the walk it replaces,
 * with no re-scan and no quadratic blow-up inside backlog().
 *
 * DEPTH AND VIA under clause (b): `depth` is the wave in which the LAST
 * alternative of the set fell — the number of propagation steps before the
 * source was actually endangered, which is still the shortest such distance —
 * and `via` is that last-falling edge (see lastToFall). A surface printing
 * "depth 2 via e9" for an alt-exhausted node is naming the alternative that
 * was still holding, not an arbitrary member of the set.
 */
function propagate(
  g: RuntimeGraph,
  killed: readonly string[],
): { atRisk: AtRiskNode[]; contained: ContainedNode[] } {
  const dead = new Set(killed);
  // `seen` is the down set: killed OR at risk — exactly "unavailable".
  const seen = new Set(killed);
  const atRisk: AtRiskNode[] = [];

  // Edges whose target is already unavailable, so no edge is ever counted
  // twice against its alt set. It also matters for a plain hard edge reached
  // through a boundary: two dead components inside one VPC are two reasons
  // the same edge is down, not two edges.
  const edgeDown = new Set<string>();
  /** edge id -> the wave it went down in, for `via` on an exhausted set */
  const downWave = new Map<string, number>();
  /** `${source}\x00${tag}` -> alternatives still available. Lazily seeded. */
  const remaining = new Map<string, number>();

  // Breadth-first BACKWARDS over synchronous edges only. Breadth-first, not
  // depth-first, so `depth` really is the shortest dependency distance — the
  // number a surface prints beside a name.
  let frontier = [...killed];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    const markAtRisk = (id: string, via: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      next.push(id);
      atRisk.push({
        id,
        label: labelOf(g, id),
        type: g.nodeById.get(id)?.type ?? null,
        depth,
        via,
      });
    };

    for (const cur of frontier) {
      for (const e of inboundOf(g, cur)) {
        if (!e.sync) continue; // detail 1: a dashed edge is not traversed
        if (edgeDown.has(e.id)) continue;
        edgeDown.add(e.id);
        downWave.set(e.id, depth);
        if (seen.has(e.from)) continue; // already unavailable: nothing to decide

        if (e.alt === null) {
          // Clause (a): a hard dependency. Unchanged from the pre-§18.11
          // walk, which is why an untagged document behaves exactly as before
          // — and why an alt set never rescues a node that also has a failed
          // hard dependency.
          markAtRisk(e.from, e.id);
          continue;
        }

        // Clause (b): one alternative fell. The source survives until the set
        // is exhausted. `?? [e]` cannot normally fire — altSets is built from
        // the same projection — and if it ever did, a lone alternative is a
        // hard dependency, which is the conservative reading (V18 says the
        // tag was meaningless anyway).
        const set = g.altSets.get(e.from)?.get(e.alt) ?? [e];
        const key = `${e.from}\x00${e.alt}`;
        const live = (remaining.get(key) ?? set.length) - 1;
        remaining.set(key, live);
        if (live <= 0) markAtRisk(e.from, lastToFall(set, downWave));
      }
    }
    // Deterministic within a ring: nearest first, then document order.
    next.sort((a, b) => documentRank(g, a) - documentRank(g, b));
    frontier = next;
  }
  // One sort at the end rather than one per wave: `depth` is fixed when a node
  // is marked, so the order is the same and the cost is not paid |V| times.
  atRisk.sort((a, b) => a.depth - b.depth || documentRank(g, a.id) - documentRank(g, b.id));

  // Containment is computed AFTER the at-risk set is closed, deliberately. A
  // node reachable both by a dashed edge and by some solid path is AT RISK,
  // not contained — the queue does not protect it if it also makes a
  // synchronous call. Reporting it as contained would be the design's safety
  // claim applied to a path the design does not actually break.
  const contained: ContainedNode[] = [];
  const claimed = new Set<string>();
  for (const cur of [...dead, ...atRisk.map((a) => a.id)]) {
    for (const e of inboundOf(g, cur)) {
      if (e.sync || seen.has(e.from) || claimed.has(e.from)) continue;
      claimed.add(e.from);
      contained.push({
        id: e.from,
        label: labelOf(g, e.from),
        edge: e.id,
        // e.to, not `cur`: the edge may arrive at a BOUNDARY containing cur,
        // and naming the far side honestly is the whole point of the field.
        from: e.to,
        edgeLabel: e.label,
      });
    }
  }
  contained.sort((a, b) => documentRank(g, a.id) - documentRank(g, b.id));

  return { atRisk, contained };
}

/**
 * Blast radius over an already-built projection (used by backlog()).
 *
 * `articulation` may be handed in precomputed. articulationPoints() is the
 * deliberately naive O(n·(n+e)) sweep §15.2 asks for, which is the right trade
 * once — and the wrong one n+1 times. backlog() already builds the map, and
 * without this parameter it rebuilt the whole sweep per candidate and threw
 * the answer away: ~2s at the 200-element cap against a sub-millisecond
 * budget, on a command an agent runs mid-turn.
 */
export function blastRadiusOn(
  g: RuntimeGraph,
  id: string,
  articulationIndex?: Map<string, ArticulationPoint>,
): BlastRadius {
  const assumptions = blastAssumptions(g.coverage, g.excluded);
  const base = {
    target: id,
    label: labelOf(g, id),
    coverage: g.coverage,
    excluded: g.excluded,
    assumptions,
  };

  const node = g.nodeById.get(id);
  const group = g.groupById.get(id);

  // A4, restated at the surface of Part 18: an entity is a table, and "what
  // breaks if this table dies" is a category error, not a small answer.
  if (node !== undefined && node.type === 'entity') {
    return {
      ...base,
      targetKind: 'entity',
      killed: [],
      atRisk: [],
      contained: [],
      articulation: null,
      note: `"${id}" is an entity node: a data model, not a runtime component — there is nothing to predict`,
    };
  }
  if (node === undefined && group === undefined) {
    return {
      ...base,
      targetKind: 'unknown',
      killed: [],
      atRisk: [],
      contained: [],
      articulation: null,
      note: `no node or group with id "${id}"`,
    };
  }

  // Detail 2: killing a group kills its descendants — one experiment. The
  // group itself stays in `killed` because an edge may point at the boundary.
  const killed =
    group !== undefined
      ? [id, ...descendantIds(g, id).filter((d) => g.order.has(d))]
      : [id];

  const { atRisk, contained } = propagate(g, killed);
  const articulation =
    group !== undefined
      ? null
      : (articulationIndex ?? articulationIndexOf(g)).get(id) ?? null;

  return {
    ...base,
    targetKind: group !== undefined ? 'group' : 'node',
    // The TARGET first, then its descendants in document order. Not one flat
    // document sort: groups rank after nodes in the projection's order, so a
    // flat sort would print the boundary last in a list of what killing that
    // boundary takes out.
    killed: [id, ...byDocumentOrder(g, killed.slice(1))],
    atRisk,
    contained,
    articulation,
    note: null,
  };
}

/**
 * If `id` dies, what is at risk? (§18.3)
 *
 * Pure, total, and read-only (C1, A1). An unknown id or an entity node comes
 * back as an empty prediction with `note` set, never as a throw and never as a
 * confident zero.
 */
export function blastRadius(doc: GraphDoc, id: string): BlastRadius {
  return blastRadiusOn(runtimeGraph(doc), id);
}

// ---------------------------------------------------------------------------
// Multi-target: "can we survive losing an availability zone?" (§18.7)
// ---------------------------------------------------------------------------

/**
 * §18.11, in the one sentence a multi-target surface must print over a
 * document that states NO redundancy — which is every document that carries no
 * `alt` tag.
 *
 * An untagged edge asserts a HARD dependency. With no `alt` anywhere there is
 * no way to say that two of the selected targets are replicas of each other
 * and that losing one alone was survivable. The union is arithmetically right
 * and the model underneath it cannot express the thing multi-select is usually
 * used to investigate, which makes this the one result in Part 18 that is more
 * confident than the document deserves. It is data on the result, not prose in
 * a surface, because three surfaces would otherwise each decide whether to
 * mention it.
 *
 * Once the document DOES express redundancy, this sentence is no longer true
 * of it — see ASSUMPTION_PARTIAL_REDUNDANCY, which replaces it.
 */
export const ASSUMPTION_NO_REDUNDANCY =
  'every edge is a hard dependency: the document cannot say two targets are replicas, so a combined radius over-reports wherever redundancy exists (§18.11)';

/**
 * The same caveat, for a document that DOES express redundancy (§18.11).
 *
 * This is the one place where building the feature changed an existing claim.
 * `ASSUMPTION_NO_REDUNDANCY` says the model cannot express redundancy at all;
 * once a single edge carries `alt`, that sentence is false for the edges that
 * carry it and still true for every edge that does not. Printing the old
 * wording over a document with alt sets would understate the tool and,
 * worse, invite the reader to discount a number that is now partly exact.
 *
 * So the caveat stays a caveat and narrows to what is actually unknown: the
 * untagged edges. It is deliberately NOT "redundancy is modelled, this result
 * is exact" — rule 14 says redundancy is told, not deduced, so an untagged
 * edge means nobody said, not that nothing is redundant. Over-reporting stays
 * the conservative direction (§18.11).
 */
export const ASSUMPTION_PARTIAL_REDUNDANCY =
  'alternatives are honoured where `alt` is set; every untagged edge is still a hard dependency, so a combined radius over-reports wherever redundancy exists but was never stated (§18.11)';

/** True when the projection contains at least one usable alternative set (§18.11). */
export function hasAlternatives(g: RuntimeGraph): boolean {
  for (const byTag of g.altSets.values()) {
    for (const set of byTag.values()) if (set.length > 0) return true;
  }
  return false;
}

/**
 * The §18.11 caveat that fits THIS document, or null when it does not apply.
 *
 * It applies to a multi-target result with two or more resolved targets — the
 * union is the shape §18.7 warns about — and its wording depends on whether
 * the document expresses any redundancy at all.
 */
export function redundancyCaveatFor(g: RuntimeGraph, resolvedTargets: number): string | null {
  if (resolvedTargets < 2) return null;
  return hasAlternatives(g) ? ASSUMPTION_PARTIAL_REDUNDANCY : ASSUMPTION_NO_REDUNDANCY;
}

/** A target that named nothing killable, and the reason (kind mirrors BlastTargetKind). */
export type UnresolvedTarget = {
  id: string;
  kind: Exclude<BlastTargetKind, 'node' | 'group'>;
  /** the single-target note verbatim, so there is one wording, not two */
  note: string;
};

/** The ids an experiment CAN name, listed only when a target missed (§3.3). */
export type ValidTargets = {
  /** runtime components, document order */
  components: string[];
  /** boundaries — killing one kills its components */
  boundaries: string[];
};

/**
 * The answer to "if ALL of these die, what is at risk?" (§18.7 multi-select).
 *
 * Shares every field name with BlastRadius where the meaning is unchanged, so
 * a surface can render either. `articulation` is deliberately ABSENT: an
 * articulation point is a property of one vertex (§15.2), a set of vertices is
 * not one, and a field here would invite a surface to sum or OR the
 * per-target answers into a structural claim nothing computed. The per-target
 * results carry theirs.
 */
export type MultiBlastResult = {
  /** the ids asked about, verbatim, de-duplicated, in the order given */
  targets: string[];
  /** labels aligned 1:1 with `targets`, so a caption needs no second lookup */
  targetLabels: string[];
  /** the subset of `targets` that named a node or a group */
  resolved: string[];
  /** targets that named an entity node or nothing at all — never silently dropped */
  unresolved: UnresolvedTarget[];
  /** the ids that WOULD work; null when every target resolved */
  validTargets: ValidTargets | null;
  /**
   * One BlastRadius per target, in `targets` order — the single-target answer
   * verbatim, including each target's own articulation finding.
   */
  per: BlastRadius[];
  /** every vertex the experiment takes out directly: per target, target first */
  killed: string[];
  /**
   * The UNION of the per-target at-risk sets, minus the targets themselves
   * (§18.7). `depth` and `via` are measured from the NEAREST killed vertex,
   * not from any one target.
   */
  atRisk: AtRiskNode[];
  /**
   * The union of the contained sets MINUS anything at risk through another
   * target. A node contained from one target and reachable from another is at
   * risk; reporting it as contained would be a false safety claim.
   */
  contained: ContainedNode[];
  /** `atRisk` ids alone, same order — the viewer's tint set, no recomputation */
  atRiskIds: string[];
  /** `contained` ids alone, same order — the viewer's boundary set */
  containedIds: string[];
  coverage: Coverage;
  excluded: Exclusions;
  /** blind spots, C2, C3, and — for two or more resolved targets — §18.11 */
  assumptions: string[];
  /**
   * The §18.11 caveat when it applies, else null; also last in `assumptions`.
   * ASSUMPTION_NO_REDUNDANCY for a document with no alt sets,
   * ASSUMPTION_PARTIAL_REDUNDANCY for one that expresses some.
   */
  redundancyCaveat: string | null;
  /** set when the selection was empty or lost a target; null when all is well */
  note: string | null;
};

/** The roster a surface prints after a miss. Cheap, and only built on a miss. */
function validTargetsOf(g: RuntimeGraph): ValidTargets {
  return { components: [...g.nodeIds], boundaries: g.doc.groups.map((gr) => gr.id) };
}

/**
 * Multi-target blast radius over an already-built projection.
 *
 * The union is not computed by merging N results — it is computed by handing
 * the UNION OF THE KILLED SETS to the same propagate() a single target uses.
 * That is the whole reason a one-id call returns exactly the one-id answer:
 * there is one traversal, not a second one that can drift from it. It also
 * gets the case a naive merge gets wrong for free — containment is computed
 * after the combined at-risk set is closed, so a node contained from target A
 * but reachable from target B lands in `atRisk`, never in `contained`.
 */
export function blastRadiusMultiOn(
  g: RuntimeGraph,
  ids: readonly string[],
  articulationIndex?: Map<string, ArticulationPoint>,
): MultiBlastResult {
  const targets = [...new Set(ids)];
  // ONE articulation sweep for the whole selection, not one per target. That
  // parameter exists precisely because rebuilding the sweep per candidate and
  // throwing it away cost ~2s at the 200-element cap; mapping blastRadiusOn
  // over N targets without it re-pays that N times, and the viewer re-pays it
  // on every shift-click. Built lazily, so a selection of boundaries only —
  // whose answer never consults the index — still pays nothing.
  const index =
    articulationIndex ??
    (targets.some((id) => g.nodeById.has(id)) ? articulationIndexOf(g) : undefined);
  const per = targets.map((id) => blastRadiusOn(g, id, index));

  const resolved: string[] = [];
  const unresolved: UnresolvedTarget[] = [];
  for (const r of per) {
    if (r.targetKind === 'node' || r.targetKind === 'group') resolved.push(r.target);
    else unresolved.push({ id: r.target, kind: r.targetKind, note: r.note ?? '' });
  }

  // Per target, target first, then its descendants — the same shape as the
  // single-target `killed`, concatenated. A target that is a descendant of an
  // earlier group target is already in the set and is not repeated.
  const killed = [...new Set(per.flatMap((r) => r.killed))];
  const { atRisk, contained } = propagate(g, killed);

  const redundancyCaveat = redundancyCaveatFor(g, resolved.length);

  return {
    targets,
    targetLabels: per.map((r) => r.label),
    resolved,
    unresolved,
    validTargets: unresolved.length > 0 ? validTargetsOf(g) : null,
    per,
    killed,
    atRisk,
    contained,
    atRiskIds: atRisk.map((a) => a.id),
    containedIds: contained.map((c) => c.id),
    coverage: g.coverage,
    excluded: g.excluded,
    assumptions: [
      ...blastAssumptions(g.coverage, g.excluded),
      ...(redundancyCaveat !== null ? [redundancyCaveat] : []),
    ],
    redundancyCaveat,
    note: multiNote(targets, unresolved),
  };
}

/**
 * What went wrong with the SELECTION, in the §3.3 voice: what happened, then
 * what to do. The ids that would have worked travel as `validTargets` rather
 * than inside this string, because only the surface knows how many of a
 * three-hundred-node roster it can afford to print.
 *
 * An empty selection gets a note and not an error, and certainly not the whole
 * document: "nothing selected" and "nothing is at risk" must never render the
 * same, which is exactly why the empty case is a stated note.
 */
function multiNote(targets: string[], unresolved: UnresolvedTarget[]): string | null {
  if (targets.length === 0) {
    return 'no targets selected — nothing to predict; name at least one runtime component or boundary';
  }
  if (unresolved.length === 0) return null;
  const named = unresolved.map((u) => `"${u.id}" (${u.note})`).join('; ');
  const all = unresolved.length === targets.length;
  const lead = all
    ? `no target could be killed: ${named}`
    : `${unresolved.length} of ${targets.length} targets could not be killed and took no part in this prediction: ${named}`;
  return `${lead} — replace each with a runtime component or boundary id, or drop it from the selection`;
}

/**
 * If ALL of `ids` die together, what is at risk? (§18.7 multi-select)
 *
 * The at-risk set is the UNION of the individual sets, because a node is at
 * risk if ANY synchronous dependency dies. Pure, total and read-only (C1, A1)
 * exactly as blastRadius is: an empty list, an unknown id and an entity target
 * all come back as a stated result, never a throw.
 *
 * Read §18.11, which travels on the result as `redundancyCaveat`.
 */
export function blastRadiusMulti(doc: GraphDoc, ids: readonly string[]): MultiBlastResult {
  return blastRadiusMultiOn(runtimeGraph(doc), ids);
}

/** One candidate experiment (§18.4). */
export type BacklogEntry = {
  id: string;
  label: string;
  /** null for a group experiment — a boundary has no NodeType */
  type: NodeType | null;
  kind: 'node' | 'group';
  /** how many things depend on it, synchronously and transitively */
  atRisk: number;
  /** how many dependents the dashed edges contain — the resilience claim */
  contained: number;
  /**
   * How many components the experiment takes out DIRECTLY: 0 for a node,
   * and the descendant count for a boundary.
   *
   * `atRisk` deliberately excludes a group's own contents — they are already
   * dead, not at risk — so a VPC that destroys three components and endangers
   * two more ranks on the number 2. Without this on the row, that reads as a
   * smaller experiment than a single database with three dependents.
   */
  kills: number;
  /** Part 15's separate metric, reported not merged (detail 3) */
  articulationPoint: boolean;
  isolates: number;
  syncFanIn: number;
};

export type BacklogOptions = {
  /**
   * Also rank each group as one experiment — a VPC, region or AZ outage
   * (§18.3 detail 2). Off by default because §18.4 ranks NODES; a surface that
   * wants the boundary experiments asks for them.
   */
  includeGroups?: boolean;
};

/**
 * Every node ranked by predicted impact — the prioritised chaos backlog
 * (§18.4): at-risk count descending, tie-broken by articulation-point status,
 * then synchronous fan-in, then document order so the list is stable.
 *
 * ENTRY POINTS ARE EXCLUDED: killing the browser is not an experiment.
 *
 * `external` NODES ARE NOT EXCLUDED, and that is deliberate. A third-party
 * outage is among the most valuable experiments available and one of the least
 * often rehearsed; dropping it because "we do not control it" is exactly how
 * it goes unrehearsed.
 *
 * Nothing here schedules, approves or runs anything (C1).
 */
export function backlog(doc: GraphDoc, options: BacklogOptions = {}): BacklogEntry[] {
  const g = runtimeGraph(doc);
  // ONE articulation sweep, handed to every candidate below (see blastRadiusOn).
  const articulation = articulationIndexOf(g);
  const entries = new Set(g.entryPoints);

  const candidates: { id: string; kind: 'node' | 'group' }[] = [
    ...g.nodeIds.filter((id) => !entries.has(id)).map((id) => ({ id, kind: 'node' as const })),
    ...(options.includeGroups === true
      ? g.doc.groups.map((gr) => ({ id: gr.id, kind: 'group' as const }))
      : []),
  ];

  const rows = candidates.map(({ id, kind }) => {
    const r = blastRadiusOn(g, id, articulation);
    const art = articulation.get(id);
    return {
      id,
      label: labelOf(g, id),
      type: g.nodeById.get(id)?.type ?? null,
      kind,
      atRisk: r.atRisk.length,
      contained: r.contained.length,
      kills: Math.max(r.killed.length - 1, 0),
      articulationPoint: art !== undefined,
      isolates: art?.isolates ?? 0,
      syncFanIn: fanIn(g, id).sync,
    };
  });

  return rows.sort(
    (a, b) =>
      b.atRisk - a.atRisk ||
      Number(b.articulationPoint) - Number(a.articulationPoint) ||
      b.isolates - a.isolates ||
      b.syncFanIn - a.syncFanIn ||
      documentRank(g, a.id) - documentRank(g, b.id),
  );
}
