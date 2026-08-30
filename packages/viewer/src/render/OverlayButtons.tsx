// render/OverlayButtons.tsx — the [analysis] [blast: X] control in the status
// strip (spec §15.5, §18.7, §8.4). Rendered into StatusBar's `analysis` slot
// by main.tsx, immediately after the [exec] [eng] [focus] group.
//
// These are VIEWPORT controls in exactly the sense §7 means, like the view
// presets beside them: they change what this browser tab draws and nothing
// else. No write, no patch, no message back over the socket. The analysis
// itself is a read (A1). See view/overlayState.ts for the full argument.
//
// Accessibility follows ViewButtons.tsx deliberately — a second control group
// in the same strip that behaved differently would be worse than one that is
// merely plain:
//  * real <button type="button">s, so Tab reaches them and Enter/Space fire
//    them with no key handling of our own,
//  * aria-pressed says which overlay is on (they are toggles, not links), and
//    the pressed one is drawn filled so the state is not carried by colour
//    alone,
//  * [blast] names its target in its own label (`blast: Postgres`) and its
//    title spells out both the cycling and the ranking, because a button that
//    means something different on the second press must say so,
//  * with nothing to experiment on, [blast] is `disabled` rather than
//    silently inert.
//
// Shift-activate walks the backlog backwards — a convenience on top of a
// control that is complete without it, so nothing is keyboard- or mouse-only.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import {
  OVERLAY_BUTTONS,
  type OverlayButtonName,
  type OverlayMode,
} from '../view/overlayState.js';
import { theme } from './theme.js';

/** Longest blast-target label shown before ellipsis — the strip is 28px tall. */
export const TARGET_LABEL_MAX = 16;

export interface OverlayButtonsProps {
  /** Which overlay is on. `off` leaves both buttons unpressed. */
  mode: OverlayMode;
  /**
   * What [blast] points at: one target's label, or `3 targets` when several
   * are combined (§18.7), or null when nothing is selected. A count rather
   * than a list, because the strip is 28px tall and the caption is where the
   * names belong — see view/overlayState.ts.
   */
  targetLabel?: string | null;
  /** False renders [blast] disabled (nothing on screen to experiment on). */
  blastEnabled?: boolean;
  /** Press handler; `reverse` is true when the user held Shift. */
  onSelect: (name: OverlayButtonName, opts: { reverse: boolean }) => void;
}

/** `Orders service` -> `Orders servic…` so the strip never reflows. */
export function blastButtonText(label: string | null | undefined): string {
  if (label === null || label === undefined || label.trim() === '') return 'blast';
  const trimmed = label.trim();
  const short =
    trimmed.length > TARGET_LABEL_MAX
      ? `${trimmed.slice(0, TARGET_LABEL_MAX - 1)}…`
      : trimmed;
  return `blast: ${short}`;
}

const baseStyle: CSSProperties = {
  font: 'inherit',
  lineHeight: 1,
  padding: '3px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  background: 'transparent',
  border: `1px solid ${theme.node.stroke}`,
  color: theme.text.secondary,
};

const activeStyle: CSSProperties = {
  background: theme.text.primary,
  borderColor: theme.text.primary,
  color: theme.canvas,
  fontWeight: 600,
};

const disabledStyle: CSSProperties = {
  cursor: 'default',
  opacity: 0.45,
};

/** Why each overlay exists, in the tooltip — the strip has no room to say it. */
const TITLES: Record<OverlayButtonName, string> = {
  analysis:
    'Analysis view: edges weighted by fan-in, chokepoints ringed, the longest synchronous chain highlighted. Computed over the FULL document, not the collapsed view.',
  blast:
    'Predicted blast radius: ring the target, tint what depends on it, mark where dashed edges contain the cascade. Click a component on the canvas to target it, shift-click to combine several and see the union, Esc to clear. Press this button for the next experiment in the ranked backlog (Shift for the previous) — which replaces a multi-selection with that single target. "At risk" is not "will fail".',
};

export function OverlayButtons(props: OverlayButtonsProps): JSX.Element {
  const { mode, targetLabel = null, blastEnabled = true, onSelect } = props;
  return (
    <span
      role="group"
      aria-label="analysis"
      data-testid="overlay-buttons"
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      {OVERLAY_BUTTONS.map((name) => {
        const isActive = mode === name;
        const disabled = name === 'blast' && !blastEnabled;
        const text = name === 'blast' ? blastButtonText(targetLabel) : name;
        return (
          <button
            key={name}
            type="button"
            disabled={disabled}
            aria-pressed={isActive}
            data-testid={`overlay-button-${name}`}
            data-active={isActive ? 'true' : undefined}
            title={
              disabled
                ? 'Nothing on screen to experiment on — every drawn component is an entry point or a data model'
                : TITLES[name]
            }
            onClick={(e: ReactMouseEvent<HTMLButtonElement>) =>
              onSelect(name, { reverse: e.shiftKey })
            }
            style={{
              ...baseStyle,
              ...(isActive ? activeStyle : {}),
              ...(disabled ? disabledStyle : {}),
            }}
          >
            {text}
          </button>
        );
      })}
    </span>
  );
}
