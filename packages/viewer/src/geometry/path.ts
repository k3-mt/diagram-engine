// Geometry step 4 (spec §6.5): build the edge path WITH hop arcs as a
// structured command list, so corner rounding (§6.6) can run AFTER hops
// without re-parsing an SVG string. Pure functions — no DOM, safe under
// Node/vitest. Geometry is derived per frame and NEVER persisted to the
// document (spec §1.4/§3.1).

import type { Seg } from './segments.js';
import { HOP_R } from './crossings.js';
import { segKey, type Span } from './hops.js';

/**
 * One absolute SVG path command. Every command is tagged with the index of
 * the segment it belongs to (`Seg.index`), which is how the corner-rounding
 * pass finds segment boundaries in the command stream.
 */
export type PathCmd =
  | { kind: 'M'; x: number; y: number; segIndex: number }
  | { kind: 'L'; x: number; y: number; segIndex: number }
  | {
      kind: 'A';
      rx: number;
      ry: number;
      sweep: 0 | 1;
      x: number;
      y: number;
      segIndex: number;
    }
  | { kind: 'Q'; cx: number; cy: number; x: number; y: number; segIndex: number };

/** Format a coordinate: at most 2 decimals, no trailing zeros, no "-0". */
function fmt(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r === 0 ? 0 : r);
}

/**
 * Build the command list for one edge's segments plus its hop-span map
 * (spec §6.5).
 *
 * - Vertical segments, flagged diagonals, and segments with no spans are
 *   plain `L` lines — the ownership rule (§6.3), hardcoded.
 * - Spans are walked in travel order along each horizontal segment.
 * - Sweep-flag rule (§6.5): right-travelling arcs use sweep=1,
 *   left-travelling use sweep=0 — BOTH bulge up (smaller y). The flag
 *   inverts with travel direction.
 * - Arc height is capped at HOP_R regardless of span width (§6.4): a span
 *   wider than 2·HOP_R renders as a flat-topped double arc — quarter-circle
 *   up, flat run at y − HOP_R, quarter-circle down — instead of ballooning.
 * - Hops are guarded away from segment ends (CORNER_GUARD in §6.2), so every
 *   segment's LAST command is always an `L` to its endpoint. Corner rounding
 *   and arrowheads (§6.7) both rely on that invariant.
 */
export function buildPathCmds(
  segs: Seg[],
  hopsBySeg: Map<string, Span[]>
): PathCmd[] {
  const first = segs[0];
  if (!first) return [];
  const cmds: PathCmd[] = [
    { kind: 'M', x: first.x1, y: first.y1, segIndex: first.index }
  ];
  for (const seg of segs) {
    const spans = hopsBySeg.get(segKey(seg));
    if (seg.orient === 'v' || seg.diagonal || !spans || spans.length === 0) {
      cmds.push({ kind: 'L', x: seg.x2, y: seg.y2, segIndex: seg.index });
      continue;
    }
    const dir = seg.x2 > seg.x1 ? 1 : -1;
    const sweep: 0 | 1 = dir > 0 ? 1 : 0; // §6.5: both directions bulge UP
    const y = seg.y1;
    const top = y - HOP_R; // SVG y grows downward; "up" is smaller y
    const ordered = [...spans].sort((a, b) =>
      dir > 0 ? a.start - b.start : b.start - a.start
    );
    for (const s of ordered) {
      const enter = dir > 0 ? s.start : s.end;
      const exit = dir > 0 ? s.end : s.start;
      const width = Math.abs(exit - enter);
      cmds.push({ kind: 'L', x: enter, y, segIndex: seg.index });
      if (width <= 2 * HOP_R + 1e-6) {
        // Narrow span (single crossing): one semi-arc, height = HOP_R.
        cmds.push({
          kind: 'A',
          rx: width / 2,
          ry: HOP_R,
          sweep,
          x: exit,
          y,
          segIndex: seg.index
        });
      } else {
        // Wide merged span: flat-topped double arc, height capped at HOP_R.
        cmds.push({
          kind: 'A',
          rx: HOP_R,
          ry: HOP_R,
          sweep,
          x: enter + dir * HOP_R,
          y: top,
          segIndex: seg.index
        });
        cmds.push({
          kind: 'L',
          x: exit - dir * HOP_R,
          y: top,
          segIndex: seg.index
        });
        cmds.push({ kind: 'A', rx: HOP_R, ry: HOP_R, sweep, x: exit, y, segIndex: seg.index });
      }
    }
    cmds.push({ kind: 'L', x: seg.x2, y: seg.y2, segIndex: seg.index });
  }
  return cmds;
}

/** Serialize a command list to an SVG path `d` string. */
export function serializePath(cmds: PathCmd[]): string {
  const parts: string[] = [];
  for (const c of cmds) {
    switch (c.kind) {
      case 'M':
        parts.push(`M ${fmt(c.x)} ${fmt(c.y)}`);
        break;
      case 'L':
        parts.push(`L ${fmt(c.x)} ${fmt(c.y)}`);
        break;
      case 'A':
        parts.push(`A ${fmt(c.rx)} ${fmt(c.ry)} 0 0 ${c.sweep} ${fmt(c.x)} ${fmt(c.y)}`);
        break;
      case 'Q':
        parts.push(`Q ${fmt(c.cx)} ${fmt(c.cy)} ${fmt(c.x)} ${fmt(c.y)}`);
        break;
    }
  }
  return parts.join(' ');
}

/**
 * §6.5 entry point: segments + hop-span map -> SVG `d` string (hops only,
 * no corner rounding). Identical output to the string builder in hops.ts;
 * this one goes through the structured command list.
 */
export function buildPath(segs: Seg[], hopsBySeg: Map<string, Span[]>): string {
  return serializePath(buildPathCmds(segs, hopsBySeg));
}
