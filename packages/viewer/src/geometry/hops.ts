// Geometry step 3 (spec §6.3–§6.5): turn detected crossings into hop spans
// and build the SVG path string for an edge. Pure functions — no DOM, safe
// under Node/vitest. Geometry is derived per frame and NEVER persisted to the
// document (spec §1.4/§3.1).

import type { Seg } from './segments.js';
import { HOP_R, type Crossing } from './crossings.js';

/**
 * One hop span on a horizontal segment: the x-interval the arc covers.
 * A single crossing produces a span exactly 2·HOP_R wide; merged clusters
 * (§6.4) produce wider spans.
 */
export interface Span {
  start: number;
  end: number;
}

/**
 * Stable key for a segment, used by the per-segment span map that
 * `buildPath` consumes.
 */
export function segKey(seg: Pick<Seg, 'edgeId' | 'index'>): string {
  return `${seg.edgeId}:${seg.index}`;
}

/**
 * Merge clustered crossing coordinates into spans (spec §6.4, verbatim rule):
 * two crossings within 2·r + 2 of each other produce touching arcs that read
 * as a blob, so their intervals [x−r, x+r] are merged whenever the next
 * interval starts within 2px of the current span's end.
 *
 * Returns spans sorted ascending by `start`. Empty input yields no spans.
 */
export function mergeClusters(points: number[], r: number): Span[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a - b);
  const spans: Span[] = [];
  let start = sorted[0]! - r;
  let end = sorted[0]! + r;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p - r <= end + 2) {
      end = p + r;
    } else {
      spans.push({ start, end });
      start = p - r;
      end = p + r;
    }
  }
  spans.push({ start, end });
  return spans;
}

/**
 * Build the per-segment hop-span map consumed by `buildPath`.
 *
 * Ownership rule (spec §6.3, hardcoded, no exceptions): the HORIZONTAL
 * segment always hops; the vertical always runs straight. Every crossing is
 * therefore charged to its `hSeg` — vertical segments never get an entry in
 * the returned map, so `buildPath` always draws them as plain lines.
 */
export function buildHopSpans(crossings: Crossing[]): Map<string, Span[]> {
  // Group crossing x-coordinates by owning (horizontal) segment.
  const xsBySeg = new Map<string, number[]>();
  for (const c of crossings) {
    const key = segKey(c.hSeg);
    const xs = xsBySeg.get(key);
    if (xs) xs.push(c.x);
    else xsBySeg.set(key, [c.x]);
  }
  const out = new Map<string, Span[]>();
  for (const [key, xs] of xsBySeg) {
    out.set(key, mergeClusters(xs, HOP_R));
  }
  return out;
}

/** Format a coordinate: at most 2 decimals, no trailing zeros, no "-0". */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/**
 * Build the SVG path `d` string for one edge's segment list (spec §6.5).
 *
 * - Vertical segments (and flagged diagonals, and any segment with no spans)
 *   are plain `L` lines — the ownership rule again, hardcoded.
 * - Spans are walked in travel order along the segment.
 * - Sweep-flag rule (§6.5): right-travelling arcs use sweep=1,
 *   left-travelling arcs use sweep=0 — BOTH bulge up. The flag inverts with
 *   travel direction; get it wrong and half the hops dent downward.
 * - Arc height is capped at HOP_R regardless of span width (§6.4): a span
 *   wider than 2·HOP_R renders as a flat-topped double arc — quarter-circle
 *   up, flat run at y − HOP_R, quarter-circle down — instead of ballooning.
 */
export function buildPath(segs: Seg[], hopsBySeg: Map<string, Span[]>): string {
  const first = segs[0];
  if (!first) return '';
  let d = `M ${fmt(first.x1)} ${fmt(first.y1)}`;
  for (const seg of segs) {
    const spans = hopsBySeg.get(segKey(seg));
    if (seg.orient === 'v' || seg.diagonal || !spans || spans.length === 0) {
      d += ` L ${fmt(seg.x2)} ${fmt(seg.y2)}`;
      continue;
    }
    const dir = seg.x2 > seg.x1 ? 1 : -1;
    const sweep = dir > 0 ? 1 : 0; // §6.5: both directions bulge UP
    const y = seg.y1;
    const top = y - HOP_R; // SVG y grows downward; "up" is smaller y
    const ordered = [...spans].sort((a, b) =>
      dir > 0 ? a.start - b.start : b.start - a.start
    );
    for (const s of ordered) {
      const enter = dir > 0 ? s.start : s.end;
      const exit = dir > 0 ? s.end : s.start;
      const width = Math.abs(exit - enter);
      d += ` L ${fmt(enter)} ${fmt(y)}`;
      if (width <= 2 * HOP_R + 1e-6) {
        // Narrow span (single crossing): one semi-arc, height = HOP_R.
        d += ` A ${fmt(width / 2)} ${HOP_R} 0 0 ${sweep} ${fmt(exit)} ${fmt(y)}`;
      } else {
        // Wide merged span: flat-topped double arc, height capped at HOP_R.
        d += ` A ${HOP_R} ${HOP_R} 0 0 ${sweep} ${fmt(enter + dir * HOP_R)} ${fmt(top)}`;
        d += ` L ${fmt(exit - dir * HOP_R)} ${fmt(top)}`;
        d += ` A ${HOP_R} ${HOP_R} 0 0 ${sweep} ${fmt(exit)} ${fmt(y)}`;
      }
    }
    d += ` L ${fmt(seg.x2)} ${fmt(seg.y2)}`;
  }
  return d;
}
