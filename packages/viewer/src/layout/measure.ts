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

import type { GNode } from '@diagram-engine/core';
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
  const textW = measureText(n.label);
  const width = clamp(textW + NODE.padX * 2 + NODE.iconW, NODE.minW, NODE.maxW);
  return { width, height: n.note ? NODE.hWithNote : NODE.h };
}
