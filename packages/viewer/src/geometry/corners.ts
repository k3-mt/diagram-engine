// Geometry step 5 (spec §6.6): corner rounding, applied AFTER hops — never
// before. Rounding first would move segment endpoints and invalidate every
// crossing already computed, so this pass transforms the hop-bearing command
// list from path.ts instead of the raw polyline. Pure function — no DOM,
// safe under Node/vitest.

import type { Seg } from './segments';
import { segKey, type Span } from './hops';
import type { PathCmd } from './path';

/** Corner radius (px): the trim distance on each side of a bend. */
export const CORNER_R = 8;
/** A corner is only rounded when BOTH adjoining segments are at least this long. */
export const MIN_ROUND_SEG = 20;
/** No rounding when a hop span comes within this many px of the corner. */
export const HOP_CLEARANCE = 12;

interface Vec {
  x: number;
  y: number;
}

function segLength(s: Seg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function unit(s: Seg): Vec {
  const len = segLength(s);
  return len === 0 ? { x: 0, y: 0 } : { x: (s.x2 - s.x1) / len, y: (s.y2 - s.y1) / len };
}

/**
 * Distance from the corner to the nearest hop span on `seg` (Infinity when
 * the segment carries none). Only horizontal segments own spans (§6.3), and
 * their spans are x-intervals, so the corner's x-coordinate is compared.
 */
function hopSpanDistance(
  seg: Seg,
  cornerX: number,
  hopsBySeg: Map<string, Span[]>
): number {
  const spans = hopsBySeg.get(segKey(seg));
  if (!spans || spans.length === 0) return Infinity;
  let min = Infinity;
  for (const s of spans) {
    const d = Math.max(s.start - cornerX, cornerX - s.end, 0);
    if (d < min) min = d;
  }
  return min;
}

/** Should the corner between segments `a` and `b` be rounded? (§6.6 skips.) */
function shouldRound(a: Seg, b: Seg, hopsBySeg: Map<string, Span[]>): boolean {
  const lenA = segLength(a);
  const lenB = segLength(b);
  if (lenA < MIN_ROUND_SEG || lenB < MIN_ROUND_SEG) return false;
  const ua = unit(a);
  const ub = unit(b);
  // No actual turn (collinear continuation, or degenerate) — nothing to round.
  if (Math.abs(ua.x * ub.y - ua.y * ub.x) < 1e-9) return false;
  const cornerX = a.x2; // == b.x1
  if (hopSpanDistance(a, cornerX, hopsBySeg) < HOP_CLEARANCE) return false;
  if (hopSpanDistance(b, cornerX, hopsBySeg) < HOP_CLEARANCE) return false;
  return true;
}

/**
 * Round the corners of a hop-bearing command list (spec §6.6).
 *
 * The corner point P between segments A and B becomes a line to
 * P − unit(A)·8 followed by a quadratic `Q P (P + unit(B)·8)` — control
 * point at P itself. A corner is skipped when either segment is under 20px
 * or a hop span comes within 12px of it (CORNER_GUARD in §6.2 keeps spans
 * at least a few px away from bends; this is the belt to that braces).
 *
 * Relies on the §6.5 invariant that every segment's LAST command is an `L`
 * ending exactly at the segment's endpoint — hops are guarded away from
 * segment ends, so trimming that `L` back by 8px never touches an arc.
 * Returns a new command list; the input is not mutated.
 */
export function roundCorners(
  cmds: PathCmd[],
  segs: Seg[],
  hopsBySeg: Map<string, Span[]>
): PathCmd[] {
  const out: PathCmd[] = cmds.map((c) => ({ ...c }));
  // Walk corners back to front so splice indices stay valid.
  for (let k = segs.length - 2; k >= 0; k--) {
    const a = segs[k]!;
    const b = segs[k + 1]!;
    if (!shouldRound(a, b, hopsBySeg)) continue;

    // Last command belonging to segment A: the `L` that ends at P.
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.segIndex === a.index) {
        idx = i;
        break;
      }
    }
    if (idx < 0) continue;
    const last = out[idx]!;
    // Defensive: only trim a straight line ending at the corner.
    if (last.kind !== 'L') continue;
    if (Math.abs(last.x - a.x2) > 1e-6 || Math.abs(last.y - a.y2) > 1e-6) continue;

    const ua = unit(a);
    const ub = unit(b);
    const P = { x: a.x2, y: a.y2 };
    last.x = P.x - ua.x * CORNER_R;
    last.y = P.y - ua.y * CORNER_R;
    out.splice(idx + 1, 0, {
      kind: 'Q',
      cx: P.x,
      cy: P.y,
      x: P.x + ub.x * CORNER_R,
      y: P.y + ub.y * CORNER_R,
      segIndex: b.index
    });
  }
  return out;
}
