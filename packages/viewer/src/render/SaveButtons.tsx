// render/SaveButtons.tsx — the [SVG] [PNG 2×] control at the right-hand end
// of the status strip, and the ⌘S §8.4 advertises (spec Part 10 Step 16).
//
// Rendered into StatusBar's `save` slot by main.tsx. Like ViewButtons these
// are read-only controls in the §7 sense: they serialise the frame already on
// screen and hand it to the browser's download. Nothing is written to the
// document or sent back over the socket.
//
// Two buttons rather than one menu, because both formats are one press and a
// menu would hide the format that is not the default. The SVG button carries
// the ⌘S hint in its own text, so the shortcut is discoverable from the strip
// instead of only from the spec.
//
// Disabled until there is a frame: a button that saves an empty file is worse
// than one that says it has nothing yet.

import type { CSSProperties } from 'react';
import { theme } from './theme.js';

export interface SaveButtonsProps {
  /** Save the current frame as .svg. */
  onSaveSvg: () => void;
  /** Save the current frame as .png at 2×. */
  onSavePng: () => void;
  /** False while there is nothing drawn — both buttons render disabled. */
  enabled?: boolean;
  /** Set while a PNG is rasterising, so the press is not repeated. */
  busy?: boolean;
  /** Set when the last save failed; shown as the buttons' title. */
  error?: string | null;
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

const disabledStyle: CSSProperties = { cursor: 'default', opacity: 0.45 };

export function SaveButtons(props: SaveButtonsProps): JSX.Element {
  const { onSaveSvg, onSavePng, enabled = true, busy = false, error = null } = props;
  const off = !enabled || busy;
  const style = { ...baseStyle, ...(off ? disabledStyle : {}) };
  return (
    <span
      role="group"
      aria-label="save"
      data-testid="save-buttons"
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      <button
        type="button"
        disabled={off}
        data-testid="save-button-svg"
        title={error ?? (enabled ? 'Save this diagram as .svg (⌘S / Ctrl-S)' : 'Nothing drawn yet')}
        onClick={onSaveSvg}
        style={style}
      >
        SVG ⌘S
      </button>
      <button
        type="button"
        disabled={off}
        data-testid="save-button-png"
        title={error ?? (enabled ? 'Save this diagram as a 2× .png' : 'Nothing drawn yet')}
        onClick={onSavePng}
        style={style}
      >
        {busy ? 'PNG…' : 'PNG 2×'}
      </button>
    </span>
  );
}
