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

/** The at-risk / contained sets for an already-killed set of vertices. */
function propagate(
  g: RuntimeGraph,
  killed: readonly string[],
): { atRisk: AtRiskNode[]; contained: ContainedNode[] } {
  const dead = new Set(killed);
  const seen = new Set(killed);
  const atRisk: AtRiskNode[] = [];

  // Breadth-first BACKWARDS over synchronous edges only. Breadth-first, not
  // depth-first, so `depth` really is the shortest dependency distance — the
  // number a surface prints beside a name.
  let frontier = [...killed];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of inboundOf(g, cur)) {
        if (!e.sync) continue; // detail 1: a dashed edge is not traversed
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        next.push(e.from);
        atRisk.push({
          id: e.from,
          label: labelOf(g, e.from),
          type: g.nodeById.get(e.from)?.type ?? null,
          depth,
          via: e.id,
        });
      }
    }
    // Deterministic within a ring: nearest first, then document order.
    next.sort((a, b) => documentRank(g, a) - documentRank(g, b));
    atRisk.sort((a, b) => a.depth - b.depth || documentRank(g, a.id) - documentRank(g, b.id));
    frontier = next;
  }

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
