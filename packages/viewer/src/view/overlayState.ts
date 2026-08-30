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
// 3. PICKING BLAST TARGETS — TWO GESTURES, ONE SET (§18.7)
// -------------------------------------------------------------------------
// §18.7 names two ways to choose, because they answer different questions:
//
//   * CLICK A NODE — "what happens if THIS dies", the question you have while
//     looking at the diagram. A plain click REPLACES the selection, so on a
//     sole target clicking again clears it (§18.7's own wording) and on a set
//     it narrows to the one clicked. That is the standard selection idiom, and
//     the caption's hint says both halves rather than only the first — "click
//     again clears it" on its own reads as safe on a set of eight, where the
//     same gesture discards seven.
//   * CYCLE THE BUTTON — "what should I break first", walking the ranked
//     experiment backlog (§18.4), Shift for the previous. This is the only
//     mechanism when nothing is worth clicking yet, and the button prints the
//     node it is on so the control always says what it will show.
//
// The cycle runs in EXPERIMENT BACKLOG ORDER (§18.4 — at-risk count, then
// articulation point, then sync fan-in), not document order. Document order
// would be arbitrary; the backlog is the ranking Part 18 exists to produce, so
// the first press lands on the highest-impact experiment and repeated presses
// walk down the list. That turns the button into the backlog itself, and no
// ranking has to be duplicated in the viewer.
//
// Candidates are restricted to targets that are THEMSELVES drawn. A hidden
// node projects onto its collapsed boundary, and ringing a whole VPC to mean
// "kill postgres" would be a lie about what the experiment is. In the exec
// view the drawn elements are the boundaries, and `backlog({includeGroups:
// true})` supplies exactly those as group experiments (§18.3 detail 2) — so
// the exec view offers region and VPC outages and the eng view offers nodes,
// with no special case anywhere.
//
// CLICKING IS NOT EDITING. §1.6 forbids mouse EDITING — moving, resizing or
// re-parenting a box. §7 permits viewport controls, and a selection that only
// decides which prediction is drawn in one browser tab is a lens: there is no
// schema field for "which overlay am I looking at" and there must never be one
// (§18.7's closing paragraph). Nothing here patches, writes or sends.
//
// -------------------------------------------------------------------------
// 4. THE TARGET IS A SET, AND THE SET IS THE ONLY SOURCE OF TRUTH
// -------------------------------------------------------------------------
// §18.7's multi-select — "can we survive losing an availability zone" — makes
// the target plural, so `targets` is an ORDERED LIST and there is no second
// field beside it holding "the" target. A `target: string | null` next to a
// `targets: string[]` is exactly how a surface ends up ringing one node and
// captioning another. Every consumer reads the list; the button label and the
// cycle read `targets[0]` as the primary, derived on the spot.
//
// The distinctions the list has to carry:
//
//   * EMPTY MEANS EMPTY. An empty list is "nothing is selected", drawn as no
//     ring and captioned as such — never silently re-seeded with the backlog
//     top, or clicking a node a second time to clear it would appear to do
//     nothing. Entering the mode from the button seeds the top eagerly instead,
//     so the first press still lands on the highest-impact experiment.
//   * A TARGET THAT IS NO LONGER DRAWN IS DROPPED, not stranded: a view change
//     or an agent's delete leaves the button working. If that empties a
//     non-empty selection the backlog top is taken, which is the pre-existing
//     recovery behaviour and is the one case where the fallback is right —
//     the user did not clear anything, the picture moved under them.
//     DROPPING ONE IS SAID OUT LOUD. Removing a target changes WHICH
//     EXPERIMENT IS RUNNING, which is a bigger claim than the projection's
//     `rolledUp`: that one says a finding is drawn on a different box, this
//     one says a component the user selected took no part in the answer. So
//     the removed ids come back as `hidden` beside the kept ones and the
//     caption prints a row. Under-reporting a union silently is the mirror
//     image of the over-reporting §18.11 makes us print a caveat about.
//   * THE VISIBLE SET IS THE ONE THAT COUNTS. Every transition that takes a
//     drawn index prunes the remembered list before acting on it, so the cap,
//     the refusal and the rings are all measured on the same list. Measuring
//     the cap on the raw state while drawing the filtered one is how a click
//     gets refused for a reason that is nowhere on screen.
//   * A CLICKED TARGET NEED NOT BE IN THE BACKLOG. The backlog excludes entry
//     points (§18.4 — killing the browser client is not an experiment worth
//     RANKING), but a direct click is the user asking anyway, and answering
//     "the web client has nothing at risk behind it" is a real answer. So the
//     validity test for a remembered target is "is it drawn", with the
//     candidate list as the fallback when the caller has no index to hand.
//
// CYCLING WITH SEVERAL SELECTED REPLACES THE WHOLE SELECTION with the single
// next backlog entry, and the caption immediately says so by naming one
// target. The alternative — advancing only the primary and keeping the rest —
// would silently mix a chosen set with a walked ranking, and the union drawn
// on screen would answer a question nobody asked. Replacing is visible and
// reversible; dropping part of a selection is neither.
//
// THE CAP (§8.2). Rings assert identity, and ten of them plus a union tint is
// the carnival §8.2 forbids. Extending past MAX_BLAST_TARGETS is refused, and
// the caption prints `targets (n/8)` whenever the cap is reached so a click
// that did nothing has its reason already on screen rather than in a log.

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
 * How many targets can be combined at once (see header note 4).
 *
 * Eight is the point at which counting rings stops being free. A real
 * question — an AZ, a replica pair, a shard set — is a handful of components;
 * past that the union stops being a prediction anyone can check and the
 * picture stops being a picture.
 */
export const MAX_BLAST_TARGETS = 8;

/**
 * The whole overlay state. `targets` is remembered across a trip through
 * `off`, so toggling the overlay off to read the diagram and back on returns
 * you to the same experiment rather than to the top of the backlog.
 */
export interface OverlayState {
  mode: OverlayMode;
  /**
   * The nodes and groups [blast] points at, in selection order — the ONLY
   * record of what is targeted (header note 4). Empty means nothing is
   * selected, which is a state the caption says out loud.
   */
  targets: readonly string[];
}

/** First paint: no overlay. The diagram is the diagram until asked otherwise. */
export const INITIAL_OVERLAY_STATE: OverlayState = { mode: 'off', targets: [] };

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

/** Nothing is drawn — the default when a caller has no index to hand. */
const NO_DRAWN: ReadonlySet<string> = new Set();

/**
 * Can `id` still be targeted? Drawn under its own name, or — when the caller
 * has no index — at least still in the backlog (header note 4, third bullet).
 */
function targetable(
  id: string,
  candidates: readonly BacklogEntry[],
  drawn: ReadonlySet<string>,
): boolean {
  return drawn.has(id) || candidates.some((c) => c.id === id);
}

/**
 * The targets [blast] is pointed at right now: the remembered selection minus
 * anything the picture no longer draws.
 *
 * An EMPTY selection stays empty — that is the user having cleared it. A
 * selection every one of whose members has gone falls back to the top of the
 * backlog, because there the picture moved rather than the user choosing, and
 * a stranded button is worse than a re-seeded one (header note 4).
 */
export function blastTargets(
  state: OverlayState,
  candidates: readonly BacklogEntry[],
  drawn: ReadonlySet<string> = NO_DRAWN,
): string[] {
  return blastSelection(state, candidates, drawn).targets;
}

/** The same answer, plus the targets that had to be dropped to reach it. */
export interface BlastSelection {
  /** what the overlay is actually predicting for */
  targets: string[];
  /**
   * Selected ids the picture no longer draws, so they took NO PART in the
   * prediction. Never silently swallowed: the caption prints them, because a
   * dropped target changes the experiment (header note 4).
   */
  hidden: string[];
}

/** `blastTargets`, keeping what it removed. See BlastSelection. */
export function blastSelection(
  state: OverlayState,
  candidates: readonly BacklogEntry[],
  drawn: ReadonlySet<string> = NO_DRAWN,
): BlastSelection {
  if (state.targets.length === 0) return { targets: [], hidden: [] };
  const kept: string[] = [];
  const hidden: string[] = [];
  for (const id of state.targets) {
    (targetable(id, candidates, drawn) ? kept : hidden).push(id);
  }
  if (kept.length > 0) return { targets: kept, hidden };
  const top = candidates[0]?.id;
  return { targets: top === undefined ? [] : [top], hidden };
}

/** The one the button names and the cycle advances from: the first selected. */
export function primaryBlastTarget(
  state: OverlayState,
  candidates: readonly BacklogEntry[],
  drawn: ReadonlySet<string> = NO_DRAWN,
): string | null {
  return blastTargets(state, candidates, drawn)[0] ?? null;
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
  opts: { reverse?: boolean; drawn?: ReadonlySet<string> } = {},
): OverlayState {
  if (name === 'analysis') {
    return state.mode === 'analysis'
      ? { mode: 'off', targets: state.targets }
      : { mode: 'analysis', targets: state.targets };
  }

  if (!canBlast(candidates)) return state; // the button is disabled; be safe anyway
  const drawn = opts.drawn ?? NO_DRAWN;
  if (state.mode !== 'blast') {
    // Entering seeds the backlog top when nothing is selected, so the first
    // press still lands on the highest-impact experiment (header note 4).
    const kept = blastTargets(state, candidates, drawn);
    const seed = candidates[0]?.id;
    return {
      mode: 'blast',
      targets: kept.length > 0 ? kept : seed === undefined ? [] : [seed],
    };
  }
  // Already on: advance. With several selected this REPLACES the selection
  // with the single next entry — visible and reversible, where advancing the
  // primary and keeping the rest would silently mix a chosen set with a
  // walked ranking (header note 4).
  const next = nextBlastTarget(
    candidates,
    primaryBlastTarget(state, candidates, drawn),
    opts.reverse === true ? -1 : 1,
  );
  return { mode: 'blast', targets: next === null ? [] : [next] };
}

/**
 * Click a node: make it the only target, or clear it when it already is
 * (§18.7 — "Clicking again clears it").
 *
 * With `extend`, TOGGLE its membership of the set instead: the modifier-click
 * that builds the "can we survive losing an AZ" question. Adding past
 * MAX_BLAST_TARGETS is refused — the state comes back unchanged and the
 * caption is already saying the cap is reached (header note 4).
 *
 * IT ACTS ON THE VISIBLE MEMBERSHIP. Given the drawn index it first prunes
 * the targets the picture no longer draws, so the cap it enforces and the
 * `capped` the caption prints are computed from ONE list. Without that, eight
 * targets remembered from another view refuse every click while the caption,
 * looking at the filtered list, reports one target and no cap: a click that
 * does nothing with its reason nowhere on screen. With no index to hand,
 * every remembered target counts — the same fallback `targetable` takes.
 *
 * Outside `blast` mode this is a no-op. There is nothing for a click to mean
 * in the plain picture or under the analysis overlay, and inventing a hidden
 * selection that only appears when a mode is switched on would be a second
 * kind of state to reason about.
 */
export function toggleBlastTarget(
  state: OverlayState,
  id: string,
  opts: {
    extend?: boolean;
    candidates?: readonly BacklogEntry[];
    drawn?: ReadonlySet<string>;
  } = {},
): OverlayState {
  if (state.mode !== 'blast') return state;
  const base =
    opts.candidates === undefined && opts.drawn === undefined
      ? [...state.targets]
      : state.targets.filter((t) =>
          targetable(t, opts.candidates ?? [], opts.drawn ?? NO_DRAWN),
        );
  const has = base.includes(id);
  if (opts.extend !== true) {
    // Plain click: replace, or clear when it is already the sole target.
    if (has && base.length === 1) return { ...state, targets: [] };
    return { ...state, targets: [id] };
  }
  if (has) return { ...state, targets: base.filter((t) => t !== id) };
  if (base.length >= MAX_BLAST_TARGETS) return state; // capped
  return { ...state, targets: [...base, id] };
}

/**
 * Clear the whole selection, staying in the mode.
 *
 * One gesture, not a hunt (Escape in the viewer): with eight targets ringed,
 * un-clicking them one at a time is not a way out. The mode stays on and the
 * caption says nothing is selected, so the next click is still a target.
 */
export function clearBlastTargets(state: OverlayState): OverlayState {
  return state.targets.length === 0 ? state : { ...state, targets: [] };
}

/** Everything the buttons need for one render, derived from state + document. */
export interface ResolvedOverlay {
  mode: OverlayMode;
  /**
   * The ids [blast] is pointed at, empty when nothing is. The single record
   * of what is targeted — the button label below is derived from it, never
   * held alongside it (header note 4).
   */
  targets: string[];
  /**
   * Selected ids this view does not draw, which therefore took no part in the
   * prediction (header note 4). The caption says so; nothing here re-projects
   * them onto a collapsed ancestor, which would assert the wrong experiment.
   */
  hiddenTargets: string[];
  /** the button's text: one target's label, or `n targets`, or null for none */
  targetLabel: string | null;
  /** true when the selection is at MAX_BLAST_TARGETS and refusing to grow */
  capped: boolean;
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
  opts: { drawn?: ReadonlySet<string>; labelOf?: (id: string) => string | null } = {},
): ResolvedOverlay {
  const { targets, hidden } = blastSelection(state, candidates, opts.drawn ?? NO_DRAWN);
  const one = targets.length === 1 ? (targets[0] as string) : null;
  const label =
    one === null
      ? null
      : (opts.labelOf?.(one) ?? candidates.find((c) => c.id === one)?.label ?? one);
  return {
    mode: state.mode,
    targets,
    hiddenTargets: hidden,
    // Several targets: a count, not a list. The strip is 28px tall and the
    // caption is where the names belong.
    targetLabel: targets.length > 1 ? `${targets.length} targets` : label,
    capped: targets.length >= MAX_BLAST_TARGETS,
    blastEnabled: canBlast(candidates),
    candidates,
  };
}

/** Labels for anything targetable in a document — nodes and boundaries alike. */
export function labelIndex(doc: GraphDoc | null): (id: string) => string | null {
  if (doc === null) return () => null;
  const map = new Map<string, string>([
    ...doc.groups.map((g) => [g.id, g.label] as const),
    ...doc.nodes.map((n) => [n.id, n.label] as const),
  ]);
  return (id) => map.get(id) ?? null;
}

/** resolveOverlayFrom, computing the backlog itself. Used by the tests. */
export function resolveOverlay(
  doc: GraphDoc | null,
  idx: DrawnIndex,
  state: OverlayState,
): ResolvedOverlay {
  return resolveOverlayFrom(blastCandidates(doc, idx), state, {
    drawn: idx.ids,
    labelOf: labelIndex(doc),
  });
}
