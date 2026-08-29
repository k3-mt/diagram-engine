// render/ViewButtons.tsx — the [exec] [eng] [focus] control in the status
// strip (spec §7, §8.4). Rendered into StatusBar's `views` slot by main.tsx.
//
// These are VIEWPORT controls, in exactly the sense §7 means: they change
// what this browser tab draws and nothing else. No write, no patch, no
// message back over the socket — see view/viewState.ts for the full
// argument and for how the agent's doc.collapsed reclaims the view.
//
// Accessibility, deliberately plain:
//  * real <button type="button">s, so Tab reaches them and Enter/Space fire
//    them with no key handling of our own,
//  * aria-pressed says which view is on (they are toggles in a group, not
//    links), and the pressed one is also drawn filled so the state is not
//    carried by colour alone,
//  * [focus] names its target in its own label (`focus: Payments`) and its
//    title spells out the cycling, because a button that means something
//    different on the second press must say so,
//  * with no groups, [focus] is `disabled` rather than silently inert.
//
// Shift-activate walks the focus cycle backwards. It is a convenience on top
// of a control that is complete without it — plain repeated presses reach
// every group — so nothing is keyboard-only or mouse-only.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import {
  VIEW_PRESET_NAMES,
  type ViewPresetName,
} from '../../../core/src/view/presets.js';
import { theme } from './theme.js';

/** Longest focus-target label shown before ellipsis — the strip is 28px tall. */
export const FOCUS_LABEL_MAX = 16;

export interface ViewButtonsProps {
  /** Which preset is on screen, or null when the collapsed list matches none. */
  active: ViewPresetName | null;
  /** Label of the group [focus] points at, or null when there is none. */
  focusLabel?: string | null;
  /** False renders [focus] disabled (no groups to focus). */
  focusEnabled?: boolean;
  /** Press handler; `reverse` is true when the user held Shift. */
  onSelect: (name: ViewPresetName, opts: { reverse: boolean }) => void;
}

/** `Payments checkout` -> `Payments check…` so the strip never reflows. */
export function focusButtonText(label: string | null | undefined): string {
  if (label === null || label === undefined || label.trim() === '') return 'focus';
  const trimmed = label.trim();
  const short =
    trimmed.length > FOCUS_LABEL_MAX
      ? `${trimmed.slice(0, FOCUS_LABEL_MAX - 1)}…`
      : trimmed;
  return `focus: ${short}`;
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

/** Why each preset exists, in the tooltip — the strip has no room to say it. */
const TITLES: Record<ViewPresetName, string> = {
  exec: 'Executive view: every top-level boundary collapsed to one box',
  eng: 'Engineering view: nothing collapsed, everything open',
  focus: 'Focus one group: press again to move to the next group (Shift for the previous)',
};

export function ViewButtons(props: ViewButtonsProps): JSX.Element {
  const { active, focusLabel = null, focusEnabled = true, onSelect } = props;
  return (
    <span
      role="group"
      aria-label="view"
      data-testid="view-buttons"
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      {VIEW_PRESET_NAMES.map((name) => {
        const isActive = active === name;
        const disabled = name === 'focus' && !focusEnabled;
        const text = name === 'focus' ? focusButtonText(focusLabel) : name;
        return (
          <button
            key={name}
            type="button"
            disabled={disabled}
            aria-pressed={isActive}
            data-testid={`view-button-${name}`}
            data-active={isActive ? 'true' : undefined}
            title={
              disabled ? 'This diagram has no groups to focus' : TITLES[name]
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
