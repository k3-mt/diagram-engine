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
  BlastRadius,
} from '../../../core/src/analysis/index.js';
import type { AnalysisPlan, BlastPlan } from '../view/overlayPlan.js';
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

/** §18.7's block, condensed to a panel. C3's wording is core's, not ours. */
export function blastCaption(b: BlastRadius, plan: BlastPlan): Caption {
  const rows: string[] = [];
  if (b.note !== null) rows.push(b.note);
  rows.push(
    `at risk (${b.atRisk.length})  ${namedList(b.atRisk.map((r) => r.label))}`,
  );
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
  rows.push(`articulation  ${articulationValue(b)}`);

  const notes = [...b.assumptions];
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
  const kills = b.killed.length - 1;
  const boundary =
    b.targetKind === 'group' && kills > 0
      ? ` (boundary — kills ${kills} component${kills === 1 ? '' : 's'})`
      : '';
  return { headline: `blast radius — ${b.label}${boundary}`, rows, notes };
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
    </div>
  );
}
