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
import { formatBinding } from '../../../core/src/bindings/ref.js';
import {
  COLLAPSED_META_KEY,
  collapsedGroupKind,
  isCollapsedGroupNode,
} from '../../../core/src/view/derive.js';
import { bindingHref, type EditorScheme } from './bindingLink.js';
import { theme } from './theme.js';

/** Card width, px. Fixed so the flip math needs no measurement. */
export const CARD_W = 300;
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

// --- the wrap model ------------------------------------------------------
//
// NOTHING IN THIS CARD IS EVER CLIPPED. The card exists to answer "what is
// this box" without a click, and a meta value, a field annotation or a file
// path cut off at `overflow: hidden` answers it with a lie of omission --
// the reader cannot tell whether they are seeing the whole value or a
// prefix. So every row wraps to as many lines as it needs, and the card
// grows; only the CARD as a whole scrolls, and only when it runs out of
// container.
//
// That makes the height a function of how the text wraps, which the flip
// math (placeCard) has to know BEFORE the card is in the DOM -- it is a
// pure function with no measurement, deliberately (see the header note).
// So the line count is ESTIMATED from an average glyph advance. It only
// feeds placement: an estimate that is a line short flips the card a few
// pixels early, and the maxHeight clamp plus `overflow-y: auto` still keep
// it on screen. It can never clip content.

/** Content width inside the paddings, px. */
const CONTENT_W = CARD_W - PAD * 2;
/** Width of the key column on a meta row, px. */
const KEY_W = 78;
/** Gap between the two columns of a row, px. */
const ROW_GAP = 8;
/** Width a meta value or a field annotation wraps within, px. */
const VALUE_W = CONTENT_W - KEY_W - ROW_GAP;
/** Width a field NAME wraps within, px (it shares the row with the type). */
const FIELD_NAME_W = CONTENT_W - KEY_W - ROW_GAP;
/** Width a binding chip's text wraps within, px (chip padding + border). */
const CHIP_W = CONTENT_W - 16;

/** Average glyph advance at 11px system-ui, px. */
const CHAR_W = 5.9;
/** Average glyph advance at 10px ui-monospace, px. */
const MONO_CHAR_W = 6.0;

/**
 * How many lines `text` takes when wrapped into `width` px. Estimated from
 * an average advance -- see the wrap-model note above for why an estimate
 * is the right tool here and what it can and cannot get wrong.
 */
export function wrappedLines(text: string, width: number, charW = CHAR_W): number {
  const perLine = Math.max(1, Math.floor(width / charW));
  return Math.max(1, Math.ceil(text.length / perLine));
}

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

/**
 * The text of a field row's right-hand column -- type, key flags, nullability
 * and note, joined. One function so the height estimate and the markup can
 * never disagree about what is on the line.
 */
export function fieldDetail(f: NonNullable<GNode['fields']>[number]): string {
  return [
    f.type,
    f.pk === true ? 'PK' : undefined,
    f.fk === true ? 'FK' : undefined,
    f.nullable === true ? 'nullable' : undefined,
    f.note,
  ]
    .filter((s): s is string => s !== undefined)
    .join(' \u00b7 ');
}

/**
 * Estimated card height for `node`, used by the flip math.
 *
 * Every row is counted at the number of lines it WRAPS to, not at one line
 * apiece: a 160-character note or a deep repo path is several lines tall and
 * a card placed as though it were one would ride off the bottom of the
 * container.
 */
export function cardHeight(node: GNode): number {
  const meta = visibleMeta(node);
  const fields = node.fields ?? [];
  const bindings = node.bindings ?? [];
  let h = HEAD_H + PAD;
  if (node.note !== undefined) {
    h += wrappedLines(node.note, CONTENT_W) * LINE_H + 2;
  }
  if (meta.length > 0) {
    h += SECTION_GAP;
    for (const [k, v] of meta) {
      // The row is as tall as its taller column.
      h +=
        Math.max(wrappedLines(k, KEY_W), wrappedLines(v, VALUE_W)) * LINE_H;
    }
  }
  if (bindings.length > 0) {
    h += SECTION_GAP + LINE_H;
    for (const b of bindings) {
      h += wrappedLines(formatBinding(b), CHIP_W, MONO_CHAR_W) * LINE_H + 4;
    }
  }
  if (fields.length > 0) {
    h += SECTION_GAP + LINE_H;
    for (const f of fields) {
      h +=
        Math.max(
          wrappedLines(f.name, FIELD_NAME_W),
          wrappedLines(fieldDetail(f), KEY_W),
        ) * LINE_H;
    }
  }
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
  /**
   * The project root a repo-relative ref resolves against (§3.8), as `diagram
   * serve` reports it. Null when the viewer was not told one — then a binding
   * chip is text, not a link, because the file it names cannot be located.
   */
  root?: string | null;
  /** Which URL scheme a chip's link uses. See bindingLink.ts. */
  editor?: EditorScheme;
  /**
   * Called when the pointer enters / leaves the bindings row, the one part of
   * this card that takes the pointer at all. The parent uses it to hold the
   * card open long enough for a chip to be clicked. NOT a mutation callback —
   * §8.6's prohibition is on the card touching the document, and it still
   * cannot.
   */
  onChipsEnter?: () => void;
  onChipsLeave?: () => void;
}

// `align-items: baseline` keeps a one-line key sitting on the first line of a
// value that wrapped to four, instead of floating in the middle of them.
const rowStyle: CSSProperties = {
  display: 'flex',
  gap: ROW_GAP,
  alignItems: 'baseline',
  lineHeight: `${LINE_H}px`,
};

// A FIXED key column, not `0 0 auto` with a min-width: the keys have to line
// up down the card now that the values beside them run to several lines, and
// a column that sizes to its own content puts every value at a different x.
// `overflowWrap: anywhere` so a 24-character key breaks rather than pushing
// the value column off the card.
const keyStyle: CSSProperties = {
  color: theme.text.secondary,
  flex: `0 0 ${KEY_W}px`,
  overflowWrap: 'anywhere',
};

// No `overflow: hidden`, no `text-overflow: ellipsis`. See the wrap-model
// note above: this card never clips. `anywhere` rather than `break-word`
// because the values that overflow are the ones with no spaces to break at —
// URLs, image tags, repo paths, ARNs.
const valueStyle: CSSProperties = {
  color: theme.text.primary,
  flex: '1 1 auto',
  minWidth: 0,
  overflowWrap: 'anywhere',
};

const sectionStyle: CSSProperties = {
  marginTop: SECTION_GAP,
  paddingTop: SECTION_GAP,
  borderTop: `1px solid ${theme.node.stroke}`,
};

// A chip shows the WHOLE ref. An ellipsised path is the one thing on this
// card a reader is most likely to want to copy or type, and a prefix of it is
// useless — so the chip wraps inside itself and grows to as many lines as the
// ref needs.
const chipStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '1px 6px',
  marginTop: 4,
  marginRight: 4,
  borderRadius: 4,
  border: `1px solid ${theme.node.stroke}`,
  font: '400 10px ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: `${LINE_H}px`,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  verticalAlign: 'top',
};

/** The panel. Renders nothing but markup — no effects, no state. */
export function HoverCard({
  node,
  x,
  y,
  vw,
  vh,
  root = null,
  editor = 'vscode',
  onChipsEnter,
  onChipsLeave,
}: HoverCardProps): JSX.Element {
  const place = placeCard(x, y, vw, vh, cardHeight(node));
  const meta = visibleMeta(node);
  const fields = node.fields ?? [];
  const bindings = node.bindings ?? [];

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

      {/* Provenance (§3.8, P5-03). Present ONLY when the node cites something,
          the same rule the get-table's optional sections follow: an
          architecture-only document's card is unchanged to the pixel.

          Each chip is the checker's own spelling of the binding — formatBinding
          from core, so the string here, the string in `### Bindings` and the
          string in a `diagram check --bindings` failure row are one string, and
          a reader can match them by eye. A path chip is an anchor that opens
          the file; an identifier chip is a span with no link, because there is
          no file to open and offering one would be a claim the document does
          not support. */}
      {bindings.length === 0 ? null : (
        <div
          data-hover-bindings={bindings.length}
          style={{
            ...sectionStyle,
            // The one part of the card that takes the pointer. The card itself
            // stays pointer-events:none (§8.6) so it can never steal the hover
            // it describes; a chip has to be clickable or "a link that opens
            // that file" is not a link.
            pointerEvents: 'auto',
          }}
          onMouseEnter={onChipsEnter}
          onMouseLeave={onChipsLeave}
        >
          <div style={{ color: theme.text.secondary, lineHeight: `${LINE_H}px` }}>
            {bindings.length === 1 ? 'read from' : `read from ${bindings.length} sources`}
          </div>
          {bindings.map((b, i) => {
            const text = formatBinding(b);
            const href = bindingHref(b, root, editor);
            return href === null ? (
              <span
                key={`${text} ${i}`}
                data-binding={text}
                title={`${text} — nothing to open: this names something inside a file, not a file`}
                style={{ ...chipStyle, color: theme.text.secondary }}
              >
                {text}
              </span>
            ) : (
              <a
                key={`${text} ${i}`}
                data-binding={text}
                href={href}
                title={`open ${text}`}
                style={{ ...chipStyle, color: theme.text.primary, textDecoration: 'none' }}
              >
                {text}
              </a>
            );
          })}
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
              <span style={{ ...keyStyle, textAlign: 'right' }}>{fieldDetail(f)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
