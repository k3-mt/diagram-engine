// render/NodeBox.tsx — the node box (spec §8.1 layer 5) and its icon +
// label (layer 6), themed per §8.2.
//
// White fill, 1px stroke, radius 8, a soft shadow. The type colour
// appears ONLY as a 3px left border and in the icon — never as a box
// fill: at 30 nodes a filled palette becomes a carnival (§8.2).
//
// Labels are drawn in LABEL_FONT — the same font measure.ts sized the
// box with — and truncated with an ellipsis past the available width
// (§5.1: truncate, never wrap; wrapping makes heights vary and the
// layout jumpier between turns).

import type { GNode } from '@diagram-engine/core';
import type { Rect } from '../layout/fromElk.js';
import { LABEL_FONT, NODE, measureText } from '../layout/measure.js';
import { NODE_ICONS, ICON_SIZE } from './icons.js';
import { theme } from './theme.js';

/** Width of the type-coloured left border (§8.2). */
export const ACCENT_W = 3;

/** The font the optional second line (note) is drawn in. */
export const NOTE_FONT = '400 11px system-ui, sans-serif';

/** Horizontal box of the icon zone, from §5.1 sizing (padX + iconW). */
const ICON_ZONE_X = NODE.padX;
const TEXT_X = NODE.padX + NODE.iconW;

/** Width available to the label text: box width minus padding and icon. */
export function labelWidth(rect: Rect): number {
  return rect.width - NODE.padX * 2 - NODE.iconW;
}

/**
 * Shorten `text` with a trailing ellipsis until it fits `maxWidth` at
 * `font` (§5.1). Returns the text unchanged when it already fits.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  font: string = LABEL_FONT,
): string {
  if (maxWidth <= 0) return '';
  if (measureText(text, font) <= maxWidth) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  // Largest prefix whose "prefix…" still fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${chars.slice(0, mid).join('').trimEnd()}…`;
    if (measureText(candidate, font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return '…';
  return `${chars.slice(0, lo).join('').trimEnd()}…`;
}

export interface NodeBoxProps {
  node: GNode;
  rect: Rect;
}

/** Rounded-left-edge strip: the 3px type-coloured border (§8.2). */
function accentPath(rect: Rect, r: number): string {
  const { x, y, height } = rect;
  const rr = Math.min(r, height / 2);
  return [
    `M ${x + ACCENT_W} ${y}`,
    `H ${x + rr}`,
    `A ${rr} ${rr} 0 0 0 ${x} ${y + rr}`,
    `V ${y + height - rr}`,
    `A ${rr} ${rr} 0 0 0 ${x + rr} ${y + height}`,
    `H ${x + ACCENT_W}`,
    'Z',
  ].join(' ');
}

/** Layer 5: the box itself — white fill, thin stroke, accent border. */
export function NodeBox({ node, rect }: NodeBoxProps): JSX.Element {
  const accent = theme.accent[node.type];
  return (
    <g data-node={node.id} data-layer="node-box">
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={theme.node.radius}
        ry={theme.node.radius}
        fill={theme.node.fill}
        stroke={theme.node.stroke}
        strokeWidth={1}
        style={{ filter: `drop-shadow(${theme.node.shadow})` }}
      />
      <path d={accentPath(rect, theme.node.radius)} fill={accent} />
    </g>
  );
}

/** Layer 6: the type icon plus the label (and optional note line). */
export function NodeContent({ node, rect }: NodeBoxProps): JSX.Element {
  const Icon = NODE_ICONS[node.type];
  const accent = theme.accent[node.type];
  const avail = labelWidth(rect);
  const label = truncateToWidth(node.label, avail, LABEL_FONT);
  const note =
    node.note === undefined
      ? undefined
      : truncateToWidth(node.note, avail, NOTE_FONT);
  const cx = rect.x + ICON_ZONE_X + (NODE.iconW - ICON_SIZE) / 2;
  const cy = rect.y + (rect.height - ICON_SIZE) / 2;
  const midY = rect.y + rect.height / 2;
  const labelY = note === undefined ? midY : midY - 8;

  return (
    <g data-node-content={node.id} data-layer="node-content">
      <g style={{ color: accent }}>
        <Icon x={cx} y={cy} />
      </g>
      <text
        x={rect.x + TEXT_X}
        y={labelY}
        dominantBaseline="central"
        textAnchor="start"
        fill={theme.text.primary}
        style={{ font: LABEL_FONT }}
      >
        {label}
      </text>
      {note === undefined ? null : (
        <text
          x={rect.x + TEXT_X}
          y={midY + 10}
          dominantBaseline="central"
          textAnchor="start"
          fill={theme.text.secondary}
          style={{ font: NOTE_FONT }}
        >
          {note}
        </text>
      )}
    </g>
  );
}
