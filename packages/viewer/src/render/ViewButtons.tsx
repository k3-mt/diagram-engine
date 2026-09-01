// render/ViewButtons.tsx — the [exec] [eng] and focus controls in the status
// strip (spec §7, §8.4). Rendered into StatusBar's `views` slot by main.tsx.
//
// These are VIEWPORT controls, in exactly the sense §7 means: they change
// what this browser tab draws and nothing else. No write, no patch, no
// message back over the socket — see view/viewState.ts for the full
// argument and for how the agent's doc.collapsed reclaims the view.
//
// WHY FOCUS IS A DROPDOWN AND THE OTHER TWO ARE BUTTONS. `exec` and `eng` are
// each ONE picture — a button toggles them and that is the whole interaction.
// `focus` is not one picture; it is one picture PER GROUP, so the control has
// to answer "which group" before it can do anything. It used to answer that by
// cycling: press once to enter focus, press again to advance to the next
// group, Shift to go back. That works, and on a diagram with thirteen groups
// it means up to thirteen presses to reach the one you want, with the target
// only readable in the button's own label as it goes past. A select names
// every option at once, reaches any of them in one action, and says which one
// is on without having to be pressed at all.
//
// Accessibility, deliberately plain:
//  * real <button type="button">s and a real <select>, so Tab reaches them and
//    Enter/Space/arrows work with no key handling of our own,
//  * aria-pressed says which preset is on (the buttons are toggles in a group,
//    not links), and the pressed one is also drawn filled so the state is not
//    carried by colour alone,
//  * the select is wrapped in a real <label> reading "focus", so the control
//    says what it is even when it is showing a group name — a bare dropdown
//    reading "Payments" could be anything — and its first option is "no
//    focus", putting the way OUT of focus in the same control as the way in
//    instead of in an unlabelled fourth state of a button,
//  * with no groups the select is `disabled` rather than silently inert.

import type { CSSProperties, ChangeEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { ViewPresetName } from '../../../core/src/view/presets.js';
// The SAME ordinal parser the layout uses to rank numbered stages (§5.6).
// Shared deliberately: if the picker and the canvas disagreed about what
// counts as "1 · ", a diagram could read 1-2-3 down the page and list its
// stages in some other order two inches below it.
import { leadingOrdinal } from '../layout/order.js';
import { theme } from './theme.js';

/** The presets that are one picture each, and so get a button. */
export const TOGGLE_PRESETS = ['exec', 'eng'] as const;

/** Longest group label shown in the select before ellipsis. */
export const FOCUS_LABEL_MAX = 22;

/** The value of the "no focus" option. Empty string: a group id is never ''. */
export const NO_FOCUS = '';

export interface FocusOption {
  id: string;
  label: string;
}

export interface ViewButtonsProps {
  /** Which preset is on screen, or null when the collapsed list matches none. */
  active: ViewPresetName | null;
  /** Every group that can be focused, in document order. */
  focusOptions?: readonly FocusOption[];
  /** The group focus is on right now, or null when the view is not focused. */
  focusId?: string | null;
  /** Press handler for [exec] / [eng]; `reverse` is true when Shift was held. */
  onSelect: (name: ViewPresetName, opts: { reverse: boolean }) => void;
  /** Pick a group to focus, or null for "no focus". */
  onFocus?: (id: string | null) => void;
}

/**
 * Picker order: numbered stages first, in NUMERIC order, then everything else
 * alphabetically.
 *
 * Not document order, which interleaves them — "4 · Landing zone", "/raw/…",
 * "Source registry", "5 · Standardisation" — and not a plain string sort,
 * which would put "10 · " between "1 · " and "2 · " and break the sequence at
 * exactly the size where a picker starts to need it.
 *
 * The unnumbered boundaries go last rather than being interleaved: they are
 * not stages of anything, and a list whose first N entries count 1, 2, 3 is
 * scannable in a way that one with infrastructure spliced between them is not.
 */
export function sortFocusOptions(options: readonly FocusOption[]): FocusOption[] {
  const by = (a: FocusOption, b: FocusOption): number => {
    const oa = leadingOrdinal(a.label);
    const ob = leadingOrdinal(b.label);
    if (oa !== undefined && ob !== undefined) {
      // Two containers in different parents can both be "1 · " — §5.6 scopes
      // ordinals to siblings — so ties fall back to the label.
      return oa - ob || a.label.localeCompare(b.label);
    }
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return a.label.localeCompare(b.label);
  };
  return [...options].sort(by);
}

/** `A very long boundary name` -> `A very long boundary…` so the strip holds. */
export function focusOptionText(label: string): string {
  const trimmed = label.trim();
  if (trimmed === '') return '(unnamed group)';
  if (trimmed.length <= FOCUS_LABEL_MAX) return trimmed;
  // trimEnd BEFORE the ellipsis: cutting at a space otherwise leaves
  // "A very long boundary …", which reads as a gap rather than a truncation.
  return `${trimmed.slice(0, FOCUS_LABEL_MAX - 1).trimEnd()}…`;
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
const TITLES: Record<string, string> = {
  exec: 'Executive view: every top-level boundary collapsed to one box',
  eng: 'Engineering view: nothing collapsed, everything open',
};

export function ViewButtons(props: ViewButtonsProps): JSX.Element {
  const {
    active,
    focusOptions = [],
    focusId = null,
    onSelect,
    onFocus,
  } = props;

  const canFocus = focusOptions.length > 0;
  const focused = active === 'focus' && focusId !== null;

  return (
    <span
      role="group"
      aria-label="view"
      data-testid="view-buttons"
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      {TOGGLE_PRESETS.map((name) => {
        const isActive = active === name;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={isActive}
            data-testid={`view-button-${name}`}
            data-active={isActive ? 'true' : undefined}
            title={TITLES[name]}
            onClick={(e: ReactMouseEvent<HTMLButtonElement>) =>
              onSelect(name, { reverse: e.shiftKey })
            }
            style={{ ...baseStyle, ...(isActive ? activeStyle : {}) }}
          >
            {name}
          </button>
        );
      })}

      {/* A real <label>, not a floating span: clicking the word focuses the
          select, and a screen reader reads the two as one control. */}
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          color: canFocus ? theme.text.secondary : theme.text.secondary,
          ...(canFocus ? {} : disabledStyle),
        }}
      >
        <span data-testid="view-focus-label">focus</span>
      <select
        data-testid="view-focus"
        data-active={focused ? 'true' : undefined}
        disabled={!canFocus}
        // The CURRENT view decides what is selected, not a remembered choice:
        // the moment the collapsed list stops being a focus view — [eng] is
        // pressed, the agent sends a new doc, a container is toggled in the
        // side panel — this reads "no focus" again, because that is what the
        // picture now shows. A select that keeps claiming a focus the canvas
        // has left is worse than no indicator at all.
        value={focused ? focusId : NO_FOCUS}
        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
          onFocus?.(e.target.value === NO_FOCUS ? null : e.target.value)
        }
        title={
          canFocus
            ? 'Focus one group: open it and every boundary above it, and collapse the rest'
            : 'This diagram has no groups to focus'
        }
        style={{
          ...baseStyle,
          ...(focused ? activeStyle : {}),
          ...(canFocus ? {} : disabledStyle),
          // A native select needs a little more room than a button, and the
          // strip is 28px tall — so no vertical padding beyond the buttons'.
          paddingRight: 6,
          maxWidth: 190,
        }}
      >
        <option value={NO_FOCUS}>no focus</option>
        {sortFocusOptions(focusOptions).map((g) => (
          <option key={g.id} value={g.id}>
            {focusOptionText(g.label)}
          </option>
        ))}
      </select>
      </label>
    </span>
  );
}
