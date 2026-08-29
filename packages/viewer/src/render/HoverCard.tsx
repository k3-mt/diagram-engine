// render/HoverCard.tsx — the node inspection panel (capability B).
//
// READ-ONLY, and pure: it takes a GNode and a screen position and returns
// markup. It never patches, never calls back into the document, and never
// stores anything — hovering is inspection, not editing (§1.6 forbids
// mouse editing; §7 permits viewport and inspection controls).
//
// It is plain HTML, absolutely positioned — NOT <foreignObject>, and not
// SVG text. The parent already hosts the <svg> inside a positioned <div>
// (main.tsx), so it can host this next to it, and HTML gives real text
// wrapping and scrolling for a 40-row field list for free.
//
// ---------------------------------------------------------------------
// INTERFACE THE PARENT MUST SATISFY (main.tsx / the integration file):
//
//   1. Host it inside the same `position: absolute/relative` container as
//      the <svg>, as a SIBLING of the <svg> — after it in the DOM, so it
//      paints on top (it is the seventh layer, above §8.1's six).
//   2. Drive `node` from Canvas's `onHoverNode(id | null)`: null → render
//      nothing at all.
//   3. Drive `x` / `y` from the mouse position in CONTAINER coordinates:
//        const r = container.getBoundingClientRect();
//        { x: e.clientX - r.left, y: e.clientY - r.top }
//      (Canvas's node groups also take an `onMouseMove`, so the same
//      handler can supply both the id and the point.)
//   4. Pass `vw` / `vh` — the container's size — so the card can FLIP near
//      the edges instead of rendering off-screen.
//   5. Nothing else. The card sets `pointer-events: none` itself, so it
//      can never steal the hover it is describing, and it must never be
//      handed a mutation callback.
// ---------------------------------------------------------------------

import type { CSSProperties } from 'react';
import type { GNode } from '@diagram-engine/core';
// Runtime import of the core SOURCE module, not the barrel (node:fs) — the
// same route toSvg.ts and NodeBox.tsx take.
import {
  COLLAPSED_META_KEY,
  collapsedGroupKind,
  isCollapsedGroupNode,
} from '../../../core/src/view/derive.js';
import { theme } from './theme.js';

/** Card width, px. Fixed so the flip math needs no measurement. */
export const CARD_W = 260;
/** Gap between the cursor and the card. */
export const CARD_OFFSET = 14;
/** Minimum gap between the card and the container edge. */
export const CARD_MARGIN = 8;

/** Vertical space one key/value or field line takes, px. */
const LINE_H = 16;
/** Everything above the first line: label, type, paddings. */
const HEAD_H = 46;
const SECTION_GAP = 8;
const PAD = 10;

/**
 * The meta rows actually shown. COLLAPSED_META_KEY is deriveView's private
 * marker for the stand-in it emits for a collapsed group (§7) — it is not
 * something the author wrote, so listing it as `collapsed  vpc` beside the
 * user's own metadata would be inventing a document field. Its value is
 * shown in the kind line instead, where it belongs.
 */
export function visibleMeta(node: GNode): [string, string][] {
  return Object.entries(node.meta ?? {}).filter(([k]) => k !== COLLAPSED_META_KEY);
}

/**
 * The line under the label: what this box IS. A collapsed group says so in
 * its own words ("collapsed vpc") rather than reporting the `external` type
 * derive.ts had to borrow to stay inside the published type enum.
 */
export function kindText(node: GNode): string {
  if (!isCollapsedGroupNode(node)) return node.type;
  const kind = collapsedGroupKind(node);
  return kind === undefined || kind === '' ? 'collapsed group' : `collapsed ${kind}`;
}

/** Estimated card height for `node`, used by the flip math. */
export function cardHeight(node: GNode): number {
  const metaCount = visibleMeta(node).length;
  const fieldCount = node.fields?.length ?? 0;
  let h = HEAD_H + PAD;
  if (node.note !== undefined) h += LINE_H + 2;
  if (metaCount > 0) h += SECTION_GAP + metaCount * LINE_H;
  if (fieldCount > 0) h += SECTION_GAP + LINE_H + fieldCount * LINE_H;
  return h;
}

export interface CardPlacement {
  left: number;
  top: number;
  /** True when the card was flipped to the cursor's left / above. */
  flippedX: boolean;
  flippedY: boolean;
  /** Height cap so a long field list scrolls instead of overflowing. */
  maxHeight: number;
}

/**
 * Place the card near (x, y) inside a vw×vh container, FLIPPING it rather
 * than letting it render off-screen: past the right edge it moves to the
 * cursor's left, past the bottom it rides up. Both axes are clamped last,
 * so a container smaller than the card still yields a visible card.
 */
export function placeCard(
  x: number,
  y: number,
  vw: number,
  vh: number,
  height: number,
  width: number = CARD_W,
): CardPlacement {
  const maxHeight = Math.max(LINE_H, vh - CARD_MARGIN * 2);
  const h = Math.min(height, maxHeight);

  let left = x + CARD_OFFSET;
  const flippedX = left + width + CARD_MARGIN > vw;
  if (flippedX) left = x - CARD_OFFSET - width;

  let top = y + CARD_OFFSET;
  const flippedY = top + h + CARD_MARGIN > vh;
  if (flippedY) top = y - CARD_OFFSET - h;

  left = Math.min(Math.max(left, CARD_MARGIN), Math.max(CARD_MARGIN, vw - width - CARD_MARGIN));
  top = Math.min(Math.max(top, CARD_MARGIN), Math.max(CARD_MARGIN, vh - h - CARD_MARGIN));
  return { left, top, flippedX, flippedY, maxHeight };
}

export interface HoverCardProps {
  node: GNode;
  /** Cursor position in CONTAINER coordinates, px. */
  x: number;
  y: number;
  /** Container size, px — what the flip math is measured against. */
  vw: number;
  vh: number;
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  lineHeight: `${LINE_H}px`,
  whiteSpace: 'nowrap',
};

const keyStyle: CSSProperties = {
  color: theme.text.secondary,
  flex: '0 0 auto',
  minWidth: 68,
};

const valueStyle: CSSProperties = {
  color: theme.text.primary,
  flex: '1 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const sectionStyle: CSSProperties = {
  marginTop: SECTION_GAP,
  paddingTop: SECTION_GAP,
  borderTop: `1px solid ${theme.node.stroke}`,
};

/** The panel. Renders nothing but markup — no effects, no state. */
export function HoverCard({ node, x, y, vw, vh }: HoverCardProps): JSX.Element {
  const place = placeCard(x, y, vw, vh, cardHeight(node));
  const meta = visibleMeta(node);
  const fields = node.fields ?? [];

  return (
    <div
      data-hover-card={node.id}
      data-layer="hover-card"
      data-flipped-x={place.flippedX ? 'true' : undefined}
      data-flipped-y={place.flippedY ? 'true' : undefined}
      style={{
        position: 'absolute',
        left: place.left,
        top: place.top,
        width: CARD_W,
        maxHeight: place.maxHeight,
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: PAD,
        borderRadius: theme.node.radius,
        background: theme.node.fill,
        border: `1px solid ${theme.node.stroke}`,
        boxShadow: '0 4px 14px rgba(0,0,0,.10)',
        color: theme.text.primary,
        font: '400 11px system-ui, sans-serif',
        // Inspection only: the card must never intercept the pointer, or
        // it would cancel the very hover that opened it.
        pointerEvents: 'none',
      }}
    >
      <div style={{ font: '600 13px system-ui, sans-serif' }}>{node.label}</div>
      <div style={{ color: theme.text.secondary, marginTop: 2 }}>
        <span style={{ color: theme.accent[node.type] }}>●</span> {kindText(node)}
      </div>
      {node.note === undefined ? null : (
        <div data-hover-note style={{ marginTop: 6, whiteSpace: 'normal' }}>
          {node.note}
        </div>
      )}

      {meta.length === 0 ? null : (
        <div data-hover-meta style={sectionStyle}>
          {meta.map(([k, v]) => (
            <div key={k} style={rowStyle} data-meta-key={k}>
              <span style={keyStyle}>{k}</span>
              <span style={valueStyle}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {fields.length === 0 ? null : (
        <div data-hover-fields style={sectionStyle}>
          <div style={{ color: theme.text.secondary, lineHeight: `${LINE_H}px` }}>
            {fields.length} {fields.length === 1 ? 'field' : 'fields'}
          </div>
          {fields.map((f, i) => (
            <div key={`${f.name} ${i}`} style={rowStyle} data-hover-field={f.name}>
              <span
                style={{
                  ...valueStyle,
                  color: f.nullable === true ? theme.text.secondary : theme.text.primary,
                }}
              >
                {f.name}
              </span>
              <span style={{ ...keyStyle, minWidth: 0, textAlign: 'right' }}>
                {[
                  f.type,
                  f.pk === true ? 'PK' : undefined,
                  f.fk === true ? 'FK' : undefined,
                  f.nullable === true ? 'nullable' : undefined,
                  f.note,
                ]
                  .filter((s): s is string => s !== undefined)
                  .join(' · ')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
