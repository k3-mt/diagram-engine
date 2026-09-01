// view/overlayPlan.ts — what the two overlays actually draw, as ids
// (spec §15.5, §18.7).
//
// The step between "the answer" and "the picture". `analyse` and `blastRadius`
// speak about the FULL document (A2); the canvas draws the DERIVED one; this
// module turns the first into a list of drawn ids and counts what got lost on
// the way. It is pure and geometry-free, so every editorial decision below is
// testable without a layout, a DOM, or a browser — and the renderer is left
// with nothing to decide.
//
// -------------------------------------------------------------------------
// THE EDITORIAL DECISIONS, AND WHY
// -------------------------------------------------------------------------
//
// 1. NOT EVERY EDGE GETS A WEIGHT. §15.5 asks for "edges weighted by fan-in",
//    and the literal reading — give all 40 edges a width proportional to their
//    target's fan-in — is the heat map §8.2 forbids: a picture that emphasises
//    everything emphasises nothing. So the baseline edges are left exactly as
//    §8.1 draws them and weight is ADDED only on edges converging on a
//    chokepoint. That is fan-in shown where fan-in is the finding.
//
// 2. ONLY SYNCHRONOUS EDGES ARE WEIGHTED. A dashed edge means asynchronous
//    (§4.4 rule 6) and that distinction is load-bearing for the other overlay
//    — it is the whole of C2. Laying a thick solid stroke over a dashed line
//    would erase it. The width therefore comes from `fanIn.sync`, and the
//    badge prints the full `fan-in n (m sync)` so nothing is hidden.
//
// 3. A CHOKEPOINT IS RINGED ONLY WHERE IT IS DRAWN UNDER ITS OWN NAME. In the
//    exec view postgres may be inside a collapsed `Data` box. Ringing that box
//    and hanging "fan-in 9" off it would attribute postgres's number to the
//    boundary, which is simply false. Those chokepoints are counted instead,
//    and the caption says how many the current view is hiding — the A5 duty,
//    in pictorial form. Collapse the view and the overlay tells you what
//    collapsing cost you.
//
// 4. THE AT-RISK SET IS THE OPPOSITE CASE, AND IS PROJECTED. A tint on a
//    collapsed boundary says "something in here depends on the target", which
//    is true and useful; a ring plus a number says "this element IS the
//    finding", which would not be. Rings assert identity, tints assert
//    containment, and the two are allowed to behave differently because they
//    claim different things. `rolledUp` still counts them for the caption.
//
// 5. THE CHOKEPOINT PREDICATE IS NOT REIMPLEMENTED. `analysis.chokepoints` is
//    already the filtered, ranked list from core (`isChokepoint`). Inventing a
//    second threshold here is how the CLI and the viewer start ringing
//    different boxes.
//
// 6. WHAT THE EXPERIMENT KILLS IS DRAWN, NOT ONLY WHAT IT ENDANGERS. A group
//    target kills its contents outright, and those components are absent from
//    `atRisk` precisely because they are past risk. Leaving them unmarked drew
//    dead boxes exactly like survivors — on the exec view, where every drawn
//    box is a boundary, that is the normal case. They get the at-risk tint at
//    double strength: no new channel, and the stronger mark is the stronger
//    claim.
//
// 7. THE CHANNEL THAT SCALES IS THE ONE THAT DEGRADES. §8.2 forbids the heat
//    map, and with a union the thing that grows is the at-risk set, not the
//    rings: past MAX_EDGE_ACCENT_TARGETS targets, half the edges on a small
//    document end up recoloured and the picture stops distinguishing anything.
//    So the at-risk EDGE accents are dropped past that point — the box tint
//    already carries the same set, the caption still prints the full count and
//    the names, and it says the strokes were dropped. Rings are capped at
//    MAX_BLAST_TARGETS and never were the problem.
//

import { edgeIsAsync } from '../../../core/src/schema/graph.js';
import type { GraphDoc } from '@diagram-engine/core';
import type {
  Analysis,
  MultiBlastResult,
} from '../../../core/src/analysis/index.js';
import {
  projectEdge,
  projectEdges,
  projectIds,
  type DrawnIndex,
} from './overlayState.js';

/** One drawn edge, thickened because it converges on a chokepoint. */
export interface WeightedEdge {
  /** id of the edge in the DRAWN document */
  id: string;
  /** synchronous fan-in of the chokepoint it arrives at — what sets the width */
  weight: number;
}

/** One drawn box to ring, with the number that earned it the ring. */
export interface RingedNode {
  id: string;
  label: string;
  /** e.g. `fan-in 9 (7 sync)` — §15.4's headline, attached to the box */
  badge: string;
}

/** Everything the analysis overlay draws, as ids (decisions 1–3, 5). */
export interface AnalysisPlan {
  /** drawn edges converging on a chokepoint, heaviest first */
  weighted: WeightedEdge[];
  /**
   * Drawn edges of the longest synchronous chain: the edges between condensed
   * steps, followed by the edges inside any step that is a cycle.
   */
  chain: string[];
  /**
   * The subset of `chain` that lies inside a cycle. A cycle is a finding in
   * its own right and must NEVER be drawn as if it were a straight run of
   * calls, so the renderer dashes these.
   */
  chainCycleEdges: string[];
  /** chain length in condensed steps — §15.4's "depth 4" */
  chainDepth: number;
  chainThroughCycle: boolean;
  /** chokepoints drawn under their own name, ranked as core ranked them */
  rings: RingedNode[];
  /** chokepoints the current view has collapsed out of sight (decision 3, A5) */
  hiddenChokepoints: number;
}

/**
 * How many targets the at-risk EDGE accents survive (decision 7).
 *
 * Two, measured rather than guessed: on a 13-node reference document one
 * target recolours 6 of 16 edges and two recolour 8. A third adds no
 * information — the union has already saturated — and takes the picture past
 * the point where a highlighted edge means anything.
 */
export const MAX_EDGE_ACCENT_TARGETS = 2;

/** `fan-in 9 (7 sync)`, or `fan-in 3` when none of it is synchronous. */
export function fanInBadge(total: number, sync: number): string {
  return sync === 0 ? `fan-in ${total}` : `fan-in ${total} (${sync} sync)`;
}

/** Project §15's answer onto the picture. Never re-derives anything. */
export function analysisPlan(
  doc: GraphDoc,
  analysis: Analysis,
  idx: DrawnIndex,
): AnalysisPlan {
  const chokepoints = new Map(analysis.chokepoints.map((c) => [c.id, c]));

  // Decision 1 + 2: weight only the synchronous edges arriving at a
  // chokepoint. Several full-document edges can merge into one drawn edge, so
  // the heaviest of them wins — understating a merged edge would hide the very
  // convergence being drawn.
  const weights = new Map<string, number>();
  for (const edge of doc.edges) {
    // Asked of the document's own predicate, not of `style`: since §3.9 a
    // `kind: "publish"` edge is asynchronous with no `style` set, and
    // weighting one here would lay a thick solid stroke over a dashed line —
    // decision 2's exact failure, in a new spelling.
    if (edgeIsAsync(edge)) continue;
    const target = chokepoints.get(edge.to);
    if (target === undefined || target.fanIn.sync === 0) continue;
    const drawn = projectEdge(idx, edge.id);
    if (drawn === null) continue;
    weights.set(drawn, Math.max(weights.get(drawn) ?? 0, target.fanIn.sync));
  }
  const weighted: WeightedEdge[] = [...weights]
    .map(([id, weight]) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

  // The chain's own edges are the ones BETWEEN condensed steps; a step that is
  // a strongly connected component has edges of its own that are not in that
  // list. Both are drawn — a chain highlight that skipped the inside of a
  // cycle would show a run of calls with a hole in it — and the cycle's edges
  // are marked so the renderer can dash them. §15.2: a cycle is reported as a
  // cycle, never silently traversed.
  const cycleEdgeIds = (analysis.longestSyncChain?.cycles ?? []).flatMap(
    (c) => c.edges,
  );
  const chain = projectEdges(idx, [
    ...(analysis.longestSyncChain?.edges ?? []),
    ...cycleEdgeIds,
  ]);
  const chainCycleEdges = projectEdges(idx, cycleEdgeIds);

  // Decision 3: ring only what is drawn under its own name; count the rest.
  const rings: RingedNode[] = [];
  let hiddenChokepoints = 0;
  for (const c of analysis.chokepoints) {
    if (!idx.ids.has(c.id)) {
      hiddenChokepoints += 1;
      continue;
    }
    rings.push({
      id: c.id,
      label: c.label,
      badge: fanInBadge(c.fanIn.total, c.fanIn.sync),
    });
  }

  return {
    weighted,
    chain,
    chainCycleEdges,
    chainDepth: analysis.longestSyncChain?.depth ?? 0,
    chainThroughCycle: analysis.longestSyncChain?.throughCycle ?? false,
    rings,
    hiddenChokepoints,
  };
}

/** Everything the blast-radius overlay draws, as ids (decision 4). */
export interface BlastPlan {
  /**
   * The drawn boxes to ring — one per selected target, in selection order,
   * minus any the current view does not draw. Plural because §18.7's
   * multi-select is plural; a single target is the one-element case and not a
   * separate path.
   */
  targets: string[];
  /**
   * Drawn boxes the experiment takes out DIRECTLY and that are not themselves
   * targets — the components inside a killed boundary (§18.3 detail 2). They
   * are not `atRisk`, because they are not at risk, they are gone; drawing
   * them like survivors is the understatement decision 6 exists to stop.
   */
  killed: string[];
  /** drawn boxes to tint: something inside each depends on the target */
  atRisk: string[];
  /** the drawn edges the cascade travels along, empty once decision 7 fires */
  atRiskEdges: string[];
  /** at-risk edges suppressed by decision 7, so the caption can say so */
  atRiskEdgesSuppressed: number;
  /**
   * Selected targets this view does not draw and which therefore took no part
   * in the prediction. A count, because the caption prints a count; the ids
   * are the overlay's, not the plan's.
   */
  hiddenTargets: number;
  /** drawn boxes the design's dashed edges keep out of it (§18.3, C2) */
  contained: string[];
  /** the dashed drawn edges where propagation stops — the boundary itself */
  containedEdges: string[];
  /** at-risk components tinted on an ancestor box rather than their own (A5) */
  rolledUp: number;
  /** at-risk components the current view shows nowhere at all */
  dropped: number;
}

/**
 * Project §18.3's prediction onto the picture.
 *
 * Takes core's MULTI result always, never a single `BlastRadius`: core
 * guarantees a one-id call returns exactly the one-id answer, so one path
 * here means the single and combined pictures cannot drift apart. A target
 * the current view does not draw is dropped from the rings rather than
 * projected onto its collapsed ancestor — decision 4's distinction, applied
 * to the ring: ringing the `Data` box to mean "kill postgres" would assert
 * the wrong experiment, while TINTING it merely says something inside is at
 * risk, which is true.
 */
export function blastPlan(
  blast: MultiBlastResult,
  idx: DrawnIndex,
  opts: { hiddenTargets?: number } = {},
): BlastPlan {
  const atRisk = projectIds(
    idx,
    blast.atRisk.map((r) => r.id),
  );
  const contained = projectIds(
    idx,
    blast.contained.map((c) => c.id),
  );
  const targets = blast.targets.filter((id) => idx.ids.has(id));
  // Decision 6. `killed` holds every target plus everything inside a killed
  // boundary; the targets already have rings, so this is the remainder, drawn
  // under its own name only — a dead component inside a collapsed box is
  // already covered by that box being a target.
  const targetSet = new Set(blast.targets);
  const killed = blast.killed.filter((id) => !targetSet.has(id) && idx.ids.has(id));
  // Decision 7: the edge accents are the channel that grows with the union.
  const atRiskEdges = projectEdges(
    idx,
    blast.atRisk.map((r) => r.via),
  );
  const suppressEdges = targets.length > MAX_EDGE_ACCENT_TARGETS;
  return {
    targets,
    killed,
    atRisk: atRisk.drawn,
    atRiskEdges: suppressEdges ? [] : atRiskEdges,
    atRiskEdgesSuppressed: suppressEdges ? atRiskEdges.length : 0,
    hiddenTargets: opts.hiddenTargets ?? 0,
    contained: contained.drawn,
    containedEdges: projectEdges(
      idx,
      blast.contained.map((c) => c.edge),
    ),
    rolledUp: atRisk.rolledUp,
    dropped: atRisk.dropped,
  };
}
