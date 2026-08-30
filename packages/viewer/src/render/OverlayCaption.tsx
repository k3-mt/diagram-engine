// render/OverlayCaption.tsx — the fixed panel that says what the overlay is
// claiming, and what it does not know (spec §15.4, §15.3 A4/A5, §18.7, C2/C3).
//
// -------------------------------------------------------------------------
// WHY A PICTURE NEEDS THIS PANEL AT ALL
// -------------------------------------------------------------------------
// §15.4's coverage block and §18.7's assumptions line are described in the
// spec as "not padding" twice over, and the core report is blunter still: the
// honesty sentences are pre-composed in core precisely so the CLI, the MCP
// tools and the viewer print A4, A5, C2 and C3 in identical words, and
// omitting them is what would make them unenforceable.
//
// A viewer is a surface like any other, and it is the surface where the
// temptation is strongest: a ranked red tint reads as authoritative in a way
// a paragraph of text does not, which is exactly C3's warning. So the
// sentences from `analysis.notes` and `blastRadius.assumptions` are rendered
// VERBATIM. This module never rephrases, shortens or drops one; the only
// thing it adds is a further blind spot of its own — findings the CURRENT
// COLLAPSE has hidden — appended after them, because a picture can hide
// things a terminal cannot.
//
// It is HTML, not SVG, and a sibling of the <svg> like HoverCard.tsx, for one
// reason: it must not pan or zoom away. A caption you can scroll off screen
// is a caption that will be missing from the screenshot someone pastes into a
// decision. pointer-events are off, so it can never steal a hover or
// interrupt a pan.

import type { CSSProperties } from 'react';
import { articulationValue } from '../../../core/src/analysis/index.js';
import type {
  Analysis,
  MultiBlastResult,
} from '../../../core/src/analysis/index.js';
import type { AnalysisPlan, BlastPlan } from '../view/overlayPlan.js';
import { MAX_EDGE_ACCENT_TARGETS } from '../view/overlayPlan.js';
import { MAX_BLAST_TARGETS } from '../view/overlayState.js';
import { ANALYSIS_ACCENT } from './AnalysisOverlay.js';
import { theme } from './theme.js';

/** One caption: a headline, the counts, and the sentences that must be shown. */
export interface Caption {
  headline: string;
  /** short factual rows — the counts behind what is drawn */
  rows: string[];
  /**
   * The honesty sentences. The first ones are core's, verbatim (A4, A5, C2,
   * C3); anything this module appends is a blind spot of the VIEW.
   */
  notes: string[];
  /**
   * The gestures, in their own dimmed line under everything else.
   *
   * Separate from `rows` and from `notes` on purpose. It is not a finding and
   * not an honesty sentence — mixing it into either would dilute a block whose
   * whole value is that every line in it is a claim about the document. It
   * renders whenever the mode is on, because the one place it USED to render —
   * an empty selection — is a state entering the mode never produces, so the
   * line that teaches the gesture was only visible to someone who already
   * knew it.
   */
  hint?: string | null;
}

/** How many names a row lists before it stops and gives a count instead. */
export const MAX_NAMED = 6;

/** `auth, orders, api-gateway (+4 more)` */
export function namedList(labels: readonly string[], max = MAX_NAMED): string {
  if (labels.length === 0) return '—';
  const shown = labels.slice(0, max).join(', ');
  const rest = labels.length - max;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * The gestures, spelled out WHENEVER THE BLAST MODE IS ON — as `Caption.hint`,
 * a dimmed line of its own under the notes.
 *
 * It used to print only where the selection was empty, which sounded right and
 * was not: entering the mode seeds the backlog top, so an empty selection is a
 * state you can only reach by clicking a sole target twice or pressing Escape
 * — the two gestures this line exists to teach. Nothing else on the canvas
 * says a box is clickable except the pointer cursor the mode turns on.
 *
 * Escape is named because a way OUT of a selection that is only discoverable
 * by accident is not a way out (§18.7).
 */
export const HOW_TO_TARGET =
  'click a component to target it — a plain click replaces the selection, and clicking a sole target again clears it · shift-click to add one and see the combined radius · Esc to clear · [blast] walks the ranked backlog';

/** The one sentence that says what the CURRENT VIEW is hiding, or null. */
export function collapsedBlindSpot(
  hidden: number,
  what: string,
): string | null {
  if (hidden <= 0) return null;
  const plural = hidden === 1 ? '' : 's';
  return `${hidden} ${what}${plural} sit inside a collapsed boundary and cannot be shown under their own name here — open the view (eng) to see them`;
}

/** §15.4's blocks, condensed to a panel. */
export function analysisCaption(a: Analysis, plan: AnalysisPlan): Caption {
  const rows: string[] = [];
  rows.push(
    a.chokepoints.length === 0
      ? 'chokepoints  none'
      : `chokepoints  ${namedList(a.chokepoints.map((c) => c.label))}`,
  );
  rows.push(
    plan.chainDepth === 0
      ? 'sync chain  none — no synchronous edges'
      : `sync chain  depth ${plan.chainDepth}${plan.chainThroughCycle ? ' (through a cycle — drawn dashed)' : ''}`,
  );
  if (a.syncCycles.length > 0) {
    rows.push(`sync cycles  ${a.syncCycles.length}`);
  }
  const crossings = a.boundaryCrossings.reduce((n, c) => n + c.count, 0);
  if (crossings > 0) {
    rows.push(
      `boundary crossings  ${crossings} across ${a.boundaryCrossings.length} pair${a.boundaryCrossings.length === 1 ? '' : 's'}`,
    );
  }

  // core's sentences first and unaltered, then this view's own blind spot.
  const notes = [...a.notes];
  const hidden = collapsedBlindSpot(plan.hiddenChokepoints, 'chokepoint');
  if (hidden !== null) notes.push(hidden);
  return { headline: `analysis — ${a.title}`, rows, notes };
}

/**
 * §18.7's block, condensed to a panel. C3's wording is core's, not ours.
 *
 * -------------------------------------------------------------------------
 * WHAT A COMBINED PREDICTION HAS TO SAY THAT A SINGLE ONE DOES NOT
 * -------------------------------------------------------------------------
 * Three extra duties, and only three — this is a caption, not an essay (§8.2).
 *
 *  1. WHAT IS SELECTED, and that the number is a UNION. A reader who sees
 *     "at risk (11)" over three ringed boxes has no way to tell whether that
 *     is a joint prediction or the worst of three; one row says which.
 *  2. §18.11, VERBATIM, WHENEVER TWO OR MORE TARGETS RESOLVED. This is the
 *     honest caption the spec demands: toggle off two replicas, see a large
 *     at-risk set, and the model gives no signal that losing the first one
 *     alone was survivable. The sentence is core's `ASSUMPTION_NO_REDUNDANCY`,
 *     which core sets exactly when the combination exists, so it arrives here
 *     the same way C2 and C3 do — printed, never composed. It is the caveat
 *     about the COMBINATION, not about any one target, which is why a single
 *     target does not get it.
 *
 *     It is lifted OUT of the flat notes block and printed directly under the
 *     row it qualifies, in the rows' own weight. Left in `assumptions` it
 *     arrived fifth, in grey, after two sentences the reader has already seen
 *     on every single-target view and learned to skip — while the sentence
 *     asserting the union sat above it in dark text. That contrast is inverted
 *     relative to reliability.
 *  3. WHAT THE EXPERIMENT KILLS OUTRIGHT. The single-target caption already
 *     refuses to let a boundary experiment be summarised by its at-risk count
 *     alone; a combined one has exactly the same problem and more of it, since
 *     in the exec view every drawn box is a boundary. So `kills (n)` is a row
 *     for the combined case too, and the plan marks those boxes.
 *
 * The articulation row is NOT printed for a combined prediction. An
 * articulation point is a property of one vertex (§15.2) and core
 * deliberately omits the field from a multi result; summing or OR-ing the
 * per-target answers into one line would be the caption inventing a
 * structural claim nothing computed — the same failure the boundary case
 * below already guards against.
 */
export function blastCaption(b: MultiBlastResult, plan: BlastPlan): Caption {
  const rows: string[] = [];
  if (b.note !== null) rows.push(b.note);

  // Nothing selected. "no target" and "nothing is at risk" must never render
  // the same, so this is its own caption rather than a set of zeroes — core
  // makes the same distinction with its own note, printed above.
  if (b.targets.length === 0) {
    return {
      headline: 'blast radius — no target selected',
      rows,
      notes: [],
      hint: HOW_TO_TARGET,
    };
  }

  const multi = b.targets.length > 1;
  if (multi) {
    // The cap is read off the SAME list the count beside it comes from.
    // Counting `b.targets` while limiting on `plan.targets` is how a caption
    // ends up saying "targets (3)" and "8 is the limit" about two lists.
    const cap =
      b.targets.length >= MAX_BLAST_TARGETS
        ? ` — ${MAX_BLAST_TARGETS} is the limit; deselect one to add another`
        : '';
    rows.push(`targets (${b.targets.length})  ${namedList(b.targetLabels)}${cap}`);
    rows.push(
      'combined  the union of each target\u2019s at-risk set — a node is at risk if ANY of them dies',
    );
  }

  // Duty 2: the caveat goes next to the claim it qualifies, in the rows' own
  // weight — not fifth in a grey footnote under two sentences the reader has
  // already learned to skip. Core's wording, unaltered, and removed from
  // `notes` below so it prints exactly once.
  //
  // It is printed for ONE target as well as for a combination. The
  // over-report belongs to the document's untagged edges, not to the union, so
  // it is as true of a single click as of five; and while it was multi-only,
  // the CLI printed a redundancy sentence on every prediction and this surface
  // printed none — two surfaces making different honesty claims about one
  // document, the quieter one being the one you can click.
  if (b.redundancyCaveat !== null) rows.push(`but  ${b.redundancyCaveat}`);

  // Duty 3: what the experiment takes out DIRECTLY, beyond the targets
  // themselves — the components inside a killed boundary. They are absent
  // from `atRisk` because they are past risk, so an at-risk count alone
  // understates the experiment. The single-target headline has said this
  // since Phase 5; the combined one returned before reaching it.
  const killsAll = b.killed.length - b.resolved.length;
  if (multi && killsAll > 0) {
    rows.push(
      `kills (${killsAll})  inside the selected boundaries — already gone, not merely at risk`,
    );
  }

  rows.push(
    `at risk (${b.atRisk.length})  ${namedList(b.atRisk.map((r) => r.label))}`,
  );
  // §18.11, and the reason this feature exists on THIS surface: toggle off two
  // replicas and the at-risk set shrinks, with nothing on screen saying why.
  // A spared node is an absence in the list above, so it has to be named or it
  // is invisible — the same argument that makes `contained` a named row.
  // Core's computation, shared with the CLI, so the two cannot disagree about
  // who was held up. Printed only when something was actually spared, so a
  // document with no `alt` renders exactly as it did before.
  if (b.spared.length > 0) {
    rows.push(
      `spared (${b.spared.length})  ${namedList(
        b.spared.map(
          (s) =>
            `${s.label} (alt “${s.tag}” — lost ${s.lost
              .map((f) => (f.downInside === null ? f.target : `${f.target} (${f.downInside} is down inside it)`))
              .join(', ')}, still up: ${s.live.join(', ')})`,
        ),
      )}`,
    );
  }
  rows.push(
    `contained (${b.contained.length})  ${namedList(
      b.contained.map((c) => `${c.label} (${c.edgeLabel ?? 'async'} from ${c.from})`),
    )}`,
  );
  // core's sentence, not a second one. `articulation === null` means two
  // different things — "computed, and the answer is no" for a node, "not
  // applicable, never computed" for a boundary — and a branch on null alone
  // turns the second into an asserted negative. In the exec view every drawn
  // box IS a collapsed group, so that would be the caption on nearly every
  // blast target: a structural conclusion nothing derived, on the surface
  // §18.7 warns is the most persuasive one.
  //
  // The SAME trap on the other unresolved kind, and this one only became
  // reachable with click-to-target: an entity node is excluded from the
  // runtime projection (A4), so nothing ever computed an articulation for it,
  // yet `articulationValue` sees kind 'entity' with a null articulation and
  // falls through the group guard to the asserted "no". The backlog cycle
  // could never land on an entity; a click can. So the row is printed only
  // for a target that actually RESOLVED — `note === null` is core's own
  // record of that — and the honest note above it stands alone.
  const single = b.per.length === 1 ? b.per[0] : undefined;
  if (single !== undefined && single.note === null) {
    rows.push(`articulation  ${articulationValue(single)}`);
  }

  // A selected target the view stopped drawing changed WHICH EXPERIMENT ran,
  // which is a bigger claim than `rolledUp`'s "drawn on another box" — so it
  // is a row, in the rows' weight, not a footnote. It is not re-projected
  // onto its collapsed ancestor: ringing `Data` to mean "kill postgres" would
  // assert the wrong experiment (overlayPlan decision 4). The fix is to say
  // it, not to draw it.
  if (plan.hiddenTargets > 0) {
    const n = plan.hiddenTargets;
    rows.push(
      `not included (${n})  ${n} selected target${n === 1 ? '' : 's'} sit${n === 1 ? 's' : ''} inside a collapsed boundary and took no part in this prediction — open the view (eng) to include ${n === 1 ? 'it' : 'them'}`,
    );
  }

  const notes = b.assumptions.filter(
    // Printed as a row above, beside the claim it qualifies. Verbatim in
    // exactly one place, never twice and never nowhere.
    (note) => note !== b.redundancyCaveat,
  );
  if (plan.atRiskEdgesSuppressed > 0) {
    notes.push(
      `edge highlighting is off past ${MAX_EDGE_ACCENT_TARGETS} targets — ${plan.atRiskEdgesSuppressed} at-risk edge${plan.atRiskEdgesSuppressed === 1 ? '' : 's'} ${plan.atRiskEdgesSuppressed === 1 ? 'is' : 'are'} not drawn; the tinted boxes are still the whole at-risk set`,
    );
  }
  const rolled = collapsedBlindSpot(plan.rolledUp, 'at-risk component');
  if (rolled !== null) {
    notes.push(
      `${plan.rolledUp} at-risk component${plan.rolledUp === 1 ? ' is' : 's are'} tinted on the collapsed boundary containing ${plan.rolledUp === 1 ? 'it' : 'them'}, not on ${plan.rolledUp === 1 ? 'its' : 'their'} own box`,
    );
  }
  if (plan.dropped > 0) {
    notes.push(
      `${plan.dropped} at-risk component${plan.dropped === 1 ? ' is' : 's are'} not on screen in this view at all`,
    );
  }
  // A boundary experiment kills its contents outright — they are not `atRisk`
  // because they are already dead — so a headline showing only the at-risk
  // count understates the experiment. The CLI names them; so does this.
  if (single === undefined) {
    return {
      headline: `blast radius — ${b.targets.length} targets combined`,
      rows,
      notes,
      hint: HOW_TO_TARGET,
    };
  }
  const kills = single.killed.length - 1;
  const boundary =
    single.targetKind === 'group' && kills > 0
      ? ` (boundary — kills ${kills} component${kills === 1 ? '' : 's'})`
      : '';
  return {
    headline: `blast radius — ${single.label}${boundary}`,
    rows,
    notes,
    hint: HOW_TO_TARGET,
  };
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  maxWidth: 460,
  padding: '8px 10px',
  borderRadius: 8,
  boxSizing: 'border-box',
  background: 'rgba(255,255,255,.94)',
  border: `1px solid ${theme.node.stroke}`,
  boxShadow: theme.node.shadow,
  color: theme.text.secondary,
  font: '11px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  // Inspection only, and never in the way of the diagram it describes.
  pointerEvents: 'none',
  userSelect: 'none',
};

export interface OverlayCaptionProps {
  caption: Caption;
}

export function OverlayCaption({ caption }: OverlayCaptionProps): JSX.Element {
  return (
    <div style={panelStyle} data-testid="overlay-caption" role="note">
      <div
        style={{ color: ANALYSIS_ACCENT, fontWeight: 700, marginBottom: 4 }}
        data-testid="overlay-caption-headline"
      >
        {caption.headline}
      </div>
      {caption.rows.map((row) => (
        <div key={row} style={{ color: theme.text.primary, whiteSpace: 'pre-wrap' }}>
          {row}
        </div>
      ))}
      {caption.notes.length === 0 ? null : (
        <div
          data-testid="overlay-caption-notes"
          style={{ marginTop: 5, paddingTop: 5, borderTop: `1px solid ${theme.node.stroke}` }}
        >
          {caption.notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </div>
      )}
      {caption.hint === undefined || caption.hint === null ? null : (
        // Dimmer than the notes and last: it is how to drive the panel, not
        // anything the panel is claiming about the document.
        <div
          data-testid="overlay-caption-hint"
          style={{ marginTop: 4, opacity: 0.7, fontStyle: 'italic' }}
        >
          {caption.hint}
        </div>
      )}
    </div>
  );
}
