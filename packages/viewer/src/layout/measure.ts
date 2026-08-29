// layout/measure.ts — text measurement and node sizing (spec §5.1).
//
// ELK needs dimensions before layout. Measure once, cache by string.
// In the browser we measure with a cached offscreen canvas 2d context;
// in Node (vitest) we fall back to a deterministic per-character
// estimate. Truncating an over-wide label with an ellipsis is the
// RENDERER's job — this module only sizes the box.
//
// Pure module: no DOM access except behind the explicit feature check
// in canvasContext(), with a deterministic fallback.

import type { GField, GNode } from '@diagram-engine/core';
import type { Size } from './types.js';

/** Node sizing constants (spec §5.1). */
export const NODE = {
  minW: 150,
  maxW: 260,
  h: 60,
  hWithNote: 76,
  padX: 24,
  iconW: 28,
} as const;

/**
 * The font labels are measured in. The renderer must draw node labels
 * with this same font, or measured widths will not match drawn widths.
 */
export const LABEL_FONT = '600 14px system-ui, sans-serif';

/**
 * The font EDGE labels are measured in — smaller and lighter than node
 * labels so they read as annotations on the line, not boxes. The
 * renderer must draw edge labels with this same font.
 */
export const EDGE_LABEL_FONT = '500 11px system-ui, sans-serif';

/** Height of an edge label box handed to ELK (one 11px line + leading). */
export const EDGE_LABEL_H = 14;

/**
 * Entity (ERD) node sizing constants. An `entity` node with fields is a
 * TABLE, not a box: a header band carrying the icon + entity name, then
 * one row per field, then a little breathing room at the bottom.
 *
 * These are still §5.1 in spirit — the width is clamped, rows never wrap
 * (the renderer truncates with an ellipsis) — only the height varies, and
 * it varies with the DOCUMENT (how many fields), not with the viewport,
 * so a re-layout of an unchanged document is still stable.
 */
export const ENTITY = {
  /** header band: entity name + type icon, a touch taller than one line */
  headerH: 34,
  /** one field row */
  rowH: 20,
  /** wider than NODE.maxW: "created_at  timestamptz" needs the room */
  maxW: 340,
  /** space below the last row */
  padB: 8,
  /** horizontal inset of a field row from each side of the box */
  padX: 12,
  /** gap between the parts of a row: name | type | badge | badge */
  gap: 6,
  /** horizontal padding inside one PK/FK badge pill */
  badgePadX: 4,
} as const;

/**
 * Width of the type-coloured left border (spec §8.2). It is a LAYOUT
 * constant, not just chrome: a field row starts inside it, so sizing has
 * to account for it. render/NodeBox.tsx re-exports this name.
 */
export const ACCENT_W = 3;

/**
 * The font ENTITY FIELD ROWS are measured in — smaller and monospaced so
 * column types line up down the table. The renderer must draw field rows
 * with this same font, or measured widths will not match drawn widths.
 */
export const ENTITY_FIELD_FONT = '400 11px ui-monospace, monospace';

/**
 * The font a PK/FK badge pill is drawn in. Here rather than in the
 * renderer because sizing has to measure the badge cluster: reserving a
 * constant for it was what made boxes too narrow for composite keys.
 * render/EntityBox.tsx re-exports this name.
 */
export const BADGE_FONT = '600 9px system-ui, sans-serif';

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Canvas-backed measurement (browser), created once and reused.

let cachedCtx: CanvasRenderingContext2D | null | undefined;

function canvasContext(): CanvasRenderingContext2D | null {
  if (cachedCtx !== undefined) return cachedCtx;
  cachedCtx = null;
  // Feature check: only touch the DOM when it actually exists (browser).
  // In Node/vitest this is skipped and the deterministic estimate is used.
  if (
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  ) {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx && typeof ctx.measureText === 'function') {
        ctx.font = LABEL_FONT;
        cachedCtx = ctx;
      }
    } catch {
      cachedCtx = null; // e.g. canvas unsupported in this environment
    }
  }
  return cachedCtx;
}

// ---------------------------------------------------------------------------
// Deterministic fallback for Node/tests.
//
// Approximation: per-character advance widths for a 14px semibold
// sans-serif, in px. Characters are bucketed into three classes —
// narrow glyphs (~4.5px), wide glyphs (~12.5px), uppercase/digits
// (~9.5px) — with everything else at ~7.8px (typical lowercase).
// This is intentionally rough: sizeNode clamps the result into
// [minW, maxW], which absorbs most of the error, and the only
// requirement in tests is that the estimate is stable (same string →
// same width, monotonic in length), not that it matches a real font.

const NARROW = /[iljfrtI.,':;|!()[\] ]/;
const WIDE = /[mwMW@%&]/;
const UPPER_OR_DIGIT = /[A-HJ-VXYZ0-9]/; // I, W handled by the classes above

const NARROW_W = 4.5;
const WIDE_W = 12.5;
const UPPER_W = 9.5;
const DEFAULT_W = 7.8;

function estimateWidth(label: string): number {
  let w = 0;
  for (const ch of label) {
    if (NARROW.test(ch)) w += NARROW_W;
    else if (WIDE.test(ch)) w += WIDE_W;
    else if (UPPER_OR_DIGIT.test(ch)) w += UPPER_W;
    else w += DEFAULT_W;
  }
  return w;
}

// ---------------------------------------------------------------------------

const widthCache = new Map<string, number>();

/** Px size parsed from a CSS font shorthand, for scaling the estimate. */
function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 14;
}

/**
 * Width of a label in px at the given font (default: the node label
 * font), measured with the cached offscreen canvas when available,
 * else the deterministic estimate (calibrated at 14px, scaled linearly
 * to the font's px size). Cached by font + string.
 */
export function measureText(label: string, font: string = LABEL_FONT): number {
  const key = `${font}\u0000${label}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const ctx = canvasContext();
  let w: number;
  if (ctx) {
    ctx.font = font; // reassert: other callers may share the context
    w = ctx.measureText(label).width;
  } else {
    w = estimateWidth(label) * (fontPx(font) / 14);
  }
  widthCache.set(key, w);
  return w;
}

/**
 * Node box for ELK (spec §5.1): width clamped to [minW, maxW] around
 * the measured label plus padding and icon; height depends only on
 * whether the node has a note. No wrapping — variable-height nodes
 * make the layout jumpier between turns.
 */
export function sizeNode(n: GNode): Size {
  const entity = sizeEntity(n);
  if (entity) return entity;
  const textW = measureText(n.label);
  const width = clamp(textW + NODE.padX * 2 + NODE.iconW, NODE.minW, NODE.maxW);
  return { width, height: n.note ? NODE.hWithNote : NODE.h };
}

/** Width of one PK/FK badge pill at BADGE_FONT. */
export function badgeWidth(text: string): number {
  return measureText(text, BADGE_FONT) + ENTITY.badgePadX * 2;
}

/** The badges a field carries, in a fixed order: PK before FK. */
export function fieldBadges(f: GField): string[] {
  const out: string[] = [];
  if (f.pk === true) out.push('PK');
  if (f.fk === true) out.push('FK');
  return out;
}

/** Total width of a field's badge cluster, 0 when it carries none. */
export function badgeClusterWidth(f: GField): number {
  const badges = fieldBadges(f);
  if (badges.length === 0) return 0;
  return (
    badges.reduce((sum, b) => sum + badgeWidth(b), 0) +
    (badges.length - 1) * ENTITY.gap
  );
}

/**
 * Width one field row needs to be drawn IN FULL, i.e. with nothing
 * ellipsised. This is the single source of truth for the row layout:
 * render/EntityBox.tsx's FieldRow lays the row out with exactly these
 * terms, in this order —
 *
 *   ACCENT_W | padX | name | gap | type | gap | badges | padX
 *
 * — so a box sized with this function fits what the renderer draws. The
 * two earlier bugs both lived here: sizing used a constant badge column
 * (too narrow for a composite PK+FK row) and it added the field's `note`,
 * which the row never draws (§5.1 keeps a row to one line; the full note
 * is in the hover panel instead).
 */
export function fieldRowWidth(f: GField): number {
  let w = ACCENT_W + ENTITY.padX * 2 + measureText(f.name, ENTITY_FIELD_FONT);
  if (f.type !== undefined) {
    w += ENTITY.gap + measureText(f.type, ENTITY_FIELD_FONT);
  }
  const cluster = badgeClusterWidth(f);
  if (cluster > 0) w += ENTITY.gap + cluster;
  return w;
}

/**
 * Table box for an `entity` node that actually has fields, or null for
 * every other node (which keeps the plain §5.1 box, unchanged).
 *
 * Width  = max(header label, widest field row) + padding, clamped into
 *          [NODE.minW, ENTITY.maxW].
 * Height = header + rows * rowH + bottom padding — exactly, so a row
 *          count is readable straight off the rendered box.
 *
 * A field row is never wrapped; if it is wider than the clamp the
 * renderer truncates it with an ellipsis (§5.1). Sizing only clamps.
 */
function sizeEntity(n: GNode): Size | null {
  if (n.type !== 'entity') return null;
  const fields = n.fields;
  if (fields === undefined || fields.length === 0) return null;

  // Header: same measurement as a normal node (icon + label + padding).
  let widest = measureText(n.label) + NODE.padX * 2 + NODE.iconW;
  for (const f of fields) {
    const rowW = fieldRowWidth(f);
    if (rowW > widest) widest = rowW;
  }

  return {
    width: clamp(widest, NODE.minW, ENTITY.maxW),
    height: ENTITY.headerH + fields.length * ENTITY.rowH + ENTITY.padB,
  };
}
