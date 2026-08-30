// view/overlayState.ts — the viewer's LOCAL analysis overlay selection
// (spec §15.5, §18.7; the §7/§1.6 rules the view presets already live under).
//
// Two extra modes sit beside [exec] [eng] [focus] in the status strip:
//
//   [analysis]  — edges weighted by fan-in, chokepoints ringed, the longest
//                 synchronous chain highlighted (§15.5)
//   [blast: X]  — one node ringed, its at-risk set tinted, and the contained
//                 boundary drawn at the dashed edges (§18.7)
//
// Everything in this file is a pure function, exactly as view/viewState.ts is,
// so the rules can be driven by a test with no DOM. React lives in
// useOverlay.ts.
//
// -------------------------------------------------------------------------
// 1. THESE ARE VIEWPORT CONTROLS, NOT DOCUMENT EDITS
// -------------------------------------------------------------------------
// Same line viewState.ts holds, for the same reason. Pressing a button sets a
// field in React state in ONE browser tab. Nothing here writes graph.json,
// builds a patch, or sends anything back over the socket — the socket stays
// receive-only. The analysis itself is a read (A1): `analyse` and
// `blastRadius` take a GraphDoc and return new objects, and the tests run them
// over a deeply frozen document.
//
// Unlike the view presets there is nothing in the document for the agent to
// reclaim: `collapsed` is document state, but "which overlay am I looking at"
// has no schema field and must never get one — it is a lens, not a design
// decision (§1.4). So there is no syncToDoc equivalent here. A new document
// keeps the overlay on and simply recomputes it.
//
// -------------------------------------------------------------------------
// 2. ANALYSIS RUNS ON THE FULL DOCUMENT, THE PICTURE IS THE DERIVED ONE (A2)
// -------------------------------------------------------------------------
// This is the whole difficulty of putting Part 15 in the viewer, and it is a
// difficulty worth having. A2 says analysis must never run on the derived view
// — otherwise `exec` hides the very chokepoints you are looking for. But the
// viewer draws the DERIVED document, so an answer about `postgres` may have to
// be shown on a box labelled `Data` that has postgres inside it.
//
// The resolution is a PROJECTION, never a second analysis:
//
//   * `analyse(doc)` / `blastRadius(doc, id)` are called on the full document,
//     always, whatever the view buttons say.
//   * `projectId` maps each id in the answer onto the element actually on
//     screen: itself if it is drawn, else its nearest drawn ancestor group
//     (the collapsed stand-in node deriveView emitted), else nothing.
//   * `projectEdge` does the same for edges through deriveView's own merge
//     bookkeeping (MergedEdgeSources), so a finding about `api → db` still
//     lights up the merged `Platform → Data` edge it was folded into.
//   * `rolledUp` counts the ids that had to be projected onto an ancestor, and
//     the caption says so. An overlay that quietly draws four findings as one
//     ring would be understating the answer, which is the A5 failure in
//     pictorial form.
//
// -------------------------------------------------------------------------
// 3. PICKING A BLAST TARGET WITH NO MOUSE SELECTION (§1.6)
// -------------------------------------------------------------------------
// §1.6 forbids mouse editing and this viewer has no click-to-select; hover is
// inspection only. [focus] solved the same problem by cycling with a button
// press, and [blast] reuses that pattern rather than inventing a second one —
// press to enter, press again to advance, Shift to go back, and the button
// prints the node it is on so the control always says what it will show.
//
// It differs from [focus] in ONE deliberate way: the cycle runs in EXPERIMENT
// BACKLOG ORDER (§18.4 — at-risk count, then articulation point, then sync
// fan-in), not document order. Document order would be arbitrary; the backlog
// is the ranking Part 18 exists to produce, so the first press lands on the
// highest-impact experiment and repeated presses walk down the list. That
// turns the button into the backlog itself, and no ranking has to be
// duplicated in the viewer.
//
// Candidates are restricted to targets that are THEMSELVES drawn. A hidden
// node projects onto its collapsed boundary, and ringing a whole VPC to mean
// "kill postgres" would be a lie about what the experiment is. In the exec
// view the drawn elements are the boundaries, and `backlog({includeGroups:
// true})` supplies exactly those as group experiments (§18.3 detail 2) — so
// the exec view offers region and VPC outages and the eng view offers nodes,
// with no special case anywhere.

import type { GraphDoc } from '@diagram-engine/core';
// Runtime imports of the core SOURCE modules rather than the barrel: the
// barrel re-exports store/ (node:fs), which must not enter the browser bundle.
// Same route main.tsx, toSvg.ts and NodeBox.tsx already take.
import { backlog, type BacklogEntry } from '../../../core/src/analysis/index.js';
import type { DerivedView } from '../../../core/src/view/derive.js';

/** Which overlay is on. `off` is the plain §8.1/§8.2 picture. */
export type OverlayMode = 'off' | 'analysis' | 'blast';

/** The two buttons, in the order they render. */
export const OVERLAY_BUTTONS = ['analysis', 'blast'] as const;

/** The name of a button — i.e. an overlay mode you can actually press. */
export type OverlayButtonName = (typeof OVERLAY_BUTTONS)[number];

/**
 * The whole overlay state. `target` is remembered across a trip through
 * `off`, so toggling the overlay off to read the diagram and back on returns
 * you to the same experiment rather than to the top of the backlog.
 */
export interface OverlayState {
  mode: OverlayMode;
  /** The node or group [blast] points at, or null to take the backlog's first. */
  target: string | null;
}

/** First paint: no overlay. The diagram is the diagram until asked otherwise. */
export const INITIAL_OVERLAY_STATE: OverlayState = { mode: 'off', target: null };

// ---------------------------------------------------------------------------
// The projection (see header note 2)
// ---------------------------------------------------------------------------

/**
 * Everything needed to map a FULL-DOCUMENT id onto the element on screen.
 *
 * Built once per frame from the document and deriveView's own bookkeeping, so
 * the overlay never re-derives the collapse and can never disagree with the
 * picture about which ids are drawn.
 */
export interface DrawnIndex {
  /** ids present in the DRAWN document: its nodes and its groups. */
  ids: Set<string>;
  /** parent-of over the FULL document, nodes and groups alike; null is root. */
  parentOf: Map<string, string | null>;
  /** full-document edge id -> the drawn edge it was merged into. */
  edgeOf: Map<string, string>;
}

/** An empty index — nothing is drawn, so nothing projects. */
export const EMPTY_DRAWN_INDEX: DrawnIndex = {
  ids: new Set(),
  parentOf: new Map(),
  edgeOf: new Map(),
};

/**
 * Build the projection index from the full document and the derived view.
 *
 * `detail` is deriveViewDetail's result — the same pass that produced the
 * drawn document, so `edgeOf` is deriveView's own merge map rather than a
 * guess reconstructed from endpoints.
 */
export function buildDrawnIndex(
  doc: GraphDoc | null,
  detail: DerivedView | null,
): DrawnIndex {
  if (doc === null || detail === null) return EMPTY_DRAWN_INDEX;
  const ids = new Set<string>([
    ...detail.doc.nodes.map((n) => n.id),
    ...detail.doc.groups.map((g) => g.id),
  ]);
  const parentOf = new Map<string, string | null>([
    ...doc.groups.map((g) => [g.id, g.parent] as const),
    ...doc.nodes.map((n) => [n.id, n.parent] as const),
  ]);
  const edgeOf = new Map<string, string>();
  for (const merged of detail.edges) {
    for (const source of merged.sources) edgeOf.set(source, merged.id);
  }
  return { ids, parentOf, edgeOf };
}

/**
 * The element that stands for `id` on screen: itself when it is drawn, else
 * its nearest drawn ancestor (the collapsed group's stand-in node), else null
 * when nothing on screen represents it at all.
 *
 * Cycle-safe: V4 forbids a parent cycle, and this module does not assume
 * validation ran — the same stance analysis/graph.ts takes.
 */
export function projectId(idx: DrawnIndex, id: string): string | null {
  if (idx.ids.has(id)) return id;
  const seen = new Set<string>([id]);
  let cur = idx.parentOf.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    if (idx.ids.has(cur)) return cur;
    seen.add(cur);
    cur = idx.parentOf.get(cur) ?? null;
  }
  return null;
}

/** The drawn edge a full-document edge was merged into, or null if it is gone. */
export function projectEdge(idx: DrawnIndex, edgeId: string): string | null {
  const drawn = idx.edgeOf.get(edgeId);
  return drawn === undefined ? null : drawn;
}

/** What a set of findings looks like once projected onto the picture. */
export interface Projection {
  /** the drawn ids that represent them, deduped, in the order first seen */
  drawn: string[];
  /** how many of the input ids are not drawn under their own name (A5) */
  rolledUp: number;
  /** how many are not represented on screen at all */
  dropped: number;
}

/** Project a list of full-document ids onto the picture, counting the losses. */
export function projectIds(idx: DrawnIndex, ids: Iterable<string>): Projection {
  const drawn: string[] = [];
  const seen = new Set<string>();
  let rolledUp = 0;
  let dropped = 0;
  for (const id of ids) {
    const to = projectId(idx, id);
    if (to === null) {
      dropped += 1;
      continue;
    }
    if (to !== id) rolledUp += 1;
    if (!seen.has(to)) {
      seen.add(to);
      drawn.push(to);
    }
  }
  return { drawn, rolledUp, dropped };
}

/** Project a list of full-document edge ids the same way. */
export function projectEdges(idx: DrawnIndex, ids: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const to = projectEdge(idx, id);
    if (to === null || seen.has(to)) continue;
    seen.add(to);
    out.push(to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The [blast] cycle (see header note 3)
// ---------------------------------------------------------------------------

/**
 * The experiments [blast] can point at, most impactful first.
 *
 * `backlog` already excludes entry points and keeps `external` nodes (§18.4);
 * `includeGroups` adds the boundary experiments. The only thing done here is
 * dropping the ones that are not drawn under their own name, which is what
 * makes the button honest in a collapsed view.
 */
export function blastCandidates(
  doc: GraphDoc | null,
  idx: DrawnIndex,
): BacklogEntry[] {
  if (doc === null) return [];
  return backlog(doc, { includeGroups: true }).filter((e) => idx.ids.has(e.id));
}

/** False when [blast] must render disabled: nothing on screen to experiment on. */
export function canBlast(candidates: readonly BacklogEntry[]): boolean {
  return candidates.length > 0;
}

/**
 * The target [blast] is pointed at right now: the remembered choice while it
 * is still a candidate, else the top of the backlog. A node the agent deleted,
 * or one a view change has hidden, must not strand the button.
 */
export function blastTarget(
  state: OverlayState,
  candidates: readonly BacklogEntry[],
): string | null {
  if (state.target !== null && candidates.some((c) => c.id === state.target)) {
    return state.target;
  }
  return candidates[0]?.id ?? null;
}

/** The next candidate after `current` (`dir: -1` walks back). Wraps. */
export function nextBlastTarget(
  candidates: readonly BacklogEntry[],
  current: string | null,
  dir: 1 | -1 = 1,
): string | null {
  if (candidates.length === 0) return null;
  const i = candidates.findIndex((c) => c.id === current);
  if (i < 0) return candidates[0]?.id ?? null;
  const n = candidates.length;
  return candidates[(i + dir + n) % n]?.id ?? null;
}

/**
 * Press a button. Returns the NEXT state; never mutates the one it is given.
 *
 * [analysis] is a plain toggle. [blast] follows [focus]: the first press only
 * ENTERS the mode on whatever target is already resolved, and a press while it
 * is already on ADVANCES down the backlog — which is what makes a single
 * button a usable selector with no mouse selection available.
 *
 * The two modes are mutually exclusive. Stacking a blast tint under an
 * analysis heat map is precisely the carnival §8.2 forbids, and the two
 * answer different questions ("what does everything depend on" versus "what
 * depends on this"); showing them together invites reading one as the other.
 */
export function selectOverlay(
  state: OverlayState,
  name: OverlayButtonName,
  candidates: readonly BacklogEntry[],
  opts: { reverse?: boolean } = {},
): OverlayState {
  if (name === 'analysis') {
    return state.mode === 'analysis'
      ? { mode: 'off', target: state.target }
      : { mode: 'analysis', target: state.target };
  }

  if (!canBlast(candidates)) return state; // the button is disabled; be safe anyway
  if (state.mode !== 'blast') {
    return { mode: 'blast', target: blastTarget(state, candidates) };
  }
  const next = nextBlastTarget(
    candidates,
    blastTarget(state, candidates),
    opts.reverse === true ? -1 : 1,
  );
  return { mode: 'blast', target: next };
}

/** Everything the buttons need for one render, derived from state + document. */
export interface ResolvedOverlay {
  mode: OverlayMode;
  /** the id [blast] is pointed at, or null when there is nothing to point at */
  target: string | null;
  /** its label, for the button text */
  targetLabel: string | null;
  /** false when [blast] must render disabled */
  blastEnabled: boolean;
  /** the backlog, most impactful first — the order the button cycles in */
  candidates: BacklogEntry[];
}

/**
 * The whole per-render derivation from an ALREADY-COMPUTED backlog.
 *
 * Split out from resolveOverlay because the backlog is the one expensive thing
 * in this file — it runs a blast radius per candidate — and the hook must be
 * free to memoise it, and to skip it entirely until the user first asks for an
 * overlay. Everything below this line is O(candidates).
 */
export function resolveOverlayFrom(
  candidates: BacklogEntry[],
  state: OverlayState,
): ResolvedOverlay {
  const target = blastTarget(state, candidates);
  return {
    mode: state.mode,
    target,
    targetLabel: candidates.find((c) => c.id === target)?.label ?? null,
    blastEnabled: canBlast(candidates),
    candidates,
  };
}

/** resolveOverlayFrom, computing the backlog itself. Used by the tests. */
export function resolveOverlay(
  doc: GraphDoc | null,
  idx: DrawnIndex,
  state: OverlayState,
): ResolvedOverlay {
  return resolveOverlayFrom(blastCandidates(doc, idx), state);
}
