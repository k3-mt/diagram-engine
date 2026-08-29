// Golden tests for geometry M3 step 11 (spec §6.3–§6.5, §6.8): T2, T3, T4.
// Polylines are built by hand — no ELK involved. Assertions run against the
// produced span data AND the path strings, parsing the A commands' sweep
// flags directly.

import { describe, expect, it } from 'vitest';
import { toSegments, type AbsEdge, type Point, type Seg } from '../src/geometry/segments';
import { findCrossings, HOP_R, type Rect } from '../src/geometry/crossings';
import {
  buildHopSpans,
  buildPath,
  mergeClusters,
  segKey,
  type Span
} from '../src/geometry/hops';

function edge(id: string, ...points: Point[]): AbsEdge {
  return { id, points };
}

function segsOf(...edges: AbsEdge[]): Seg[] {
  return edges.flatMap((e) => toSegments(e));
}

/** Full pipeline for one horizontal edge crossed by others: path of `main`. */
function pathFor(main: AbsEdge, others: AbsEdge[], nodeRects: Rect[] = []): string {
  const all = segsOf(main, ...others);
  const spans = buildHopSpans(findCrossings(all, nodeRects));
  return buildPath(toSegments(main), spans);
}

/** One parsed `A` command plus the current point it started from. */
interface ParsedArc {
  rx: number;
  ry: number;
  largeArc: number;
  sweep: number;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
}

interface ParsedPath {
  arcs: ParsedArc[];
  /** Every point visited by M/L/A commands, in order. */
  points: Point[];
}

/**
 * Minimal parser for the absolute M/L/A subset buildPath emits. Tracks the
 * current point so each arc knows where it started.
 */
function parsePath(d: string): ParsedPath {
  const tokens = d.match(/[MLA]|-?\d+(?:\.\d+)?/g) ?? [];
  const arcs: ParsedArc[] = [];
  const points: Point[] = [];
  let cx = 0;
  let cy = 0;
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      cx = num();
      cy = num();
      points.push({ x: cx, y: cy });
    } else if (cmd === 'A') {
      const rx = num();
      const ry = num();
      num(); // x-axis-rotation, always 0
      const largeArc = num();
      const sweep = num();
      const x = num();
      const y = num();
      arcs.push({ rx, ry, largeArc, sweep, x, y, fromX: cx, fromY: cy });
      cx = x;
      cy = y;
      points.push({ x, y });
    } else {
      throw new Error(`unexpected token ${cmd} in ${d}`);
    }
  }
  return { arcs, points };
}

/**
 * Apex y of an arc whose endpoints share the same y (both arc shapes
 * buildPath emits for a hop start and end on the segment's y, or on the flat
 * top). Small arc, center on the chord's perpendicular bisector at the
 * endpoints' y: sweep=1 tops out ABOVE (smaller y) when travelling right,
 * BELOW when travelling left — and vice versa for sweep=0.
 */
function arcApexY(a: ParsedArc): number {
  expect(a.fromY).toBeCloseTo(a.y, 6);
  const goingRight = a.x > a.fromX;
  const up = (a.sweep === 1) === goingRight;
  return a.y + (up ? -a.ry : a.ry);
}

describe('ownership rule (§6.3, hardcoded)', () => {
  it('charges every crossing to the horizontal; the vertical stays straight', () => {
    const h = edge('h', { x: 0, y: 50 }, { x: 100, y: 50 });
    const v = edge('v', { x: 50, y: 0 }, { x: 50, y: 100 });
    const crossings = findCrossings(segsOf(h, v), []);
    const spans = buildHopSpans(crossings);
    // Exactly one entry, keyed by the horizontal segment.
    expect([...spans.keys()]).toEqual([segKey({ edgeId: 'h', index: 0 })]);
    // The vertical's path has no arcs even though it participated.
    const vPath = buildPath(toSegments(v), spans);
    expect(vPath).toBe('M 50 0 L 50 100');
    expect(vPath).not.toContain('A');
  });

  it('draws a vertical segment straight even if a span map entry existed for it', () => {
    // Belt and braces: the rule is hardcoded in buildPath too.
    const v = toSegments(edge('v', { x: 50, y: 0 }, { x: 50, y: 100 }));
    const rogue = new Map<string, Span[]>([
      [segKey({ edgeId: 'v', index: 0 }), [{ start: 44, end: 56 }]]
    ]);
    expect(buildPath(v, rogue)).toBe('M 50 0 L 50 100');
  });
});

describe('T2: same crossing, horizontal travel direction reversed (§6.5)', () => {
  const v = edge('v', { x: 50, y: 0 }, { x: 50, y: 100 });

  it('right-travelling horizontal: sweep=1, arc bulges UP', () => {
    const d = pathFor(edge('h', { x: 0, y: 50 }, { x: 100, y: 50 }), [v]);
    expect(d).toBe('M 0 50 L 44 50 A 6 6 0 0 1 56 50 L 100 50');
    const { arcs } = parsePath(d);
    expect(arcs).toHaveLength(1);
    const a = arcs[0]!;
    expect(a.sweep).toBe(1);
    expect(a.fromX).toBe(44); // enters on the left, exits right
    expect(a.x).toBe(56);
    expect(arcApexY(a)).toBe(50 - HOP_R); // apex ABOVE the segment
  });

  it('left-travelling horizontal: sweep INVERTS to 0, arc still bulges UP', () => {
    // The one people skip and then lose an afternoon to: same crossing,
    // horizontal points reversed. Sweep must flip or the hop dents downward.
    const d = pathFor(edge('h', { x: 100, y: 50 }, { x: 0, y: 50 }), [v]);
    expect(d).toBe('M 100 50 L 56 50 A 6 6 0 0 0 44 50 L 0 50');
    const { arcs } = parsePath(d);
    expect(arcs).toHaveLength(1);
    const a = arcs[0]!;
    expect(a.sweep).toBe(0); // inverted flag...
    expect(a.fromX).toBe(56); // enters on the right, exits left
    expect(a.x).toBe(44);
    expect(arcApexY(a)).toBe(50 - HOP_R); // ...same UPWARD bulge
  });
});

describe('T3: three verticals 40px apart -> 3 separate arcs (§6.4)', () => {
  const h = edge('h', { x: 0, y: 100 }, { x: 200, y: 100 });
  const verts = [60, 100, 140].map((x) =>
    edge(`v${x}`, { x, y: 0 }, { x, y: 200 })
  );

  it('produces 3 separate spans, each 2*HOP_R wide', () => {
    const crossings = findCrossings(segsOf(h, ...verts), []);
    expect(crossings).toHaveLength(3);
    const spans = buildHopSpans(crossings).get(segKey({ edgeId: 'h', index: 0 }))!;
    expect(spans).toEqual([
      { start: 54, end: 66 },
      { start: 94, end: 106 },
      { start: 134, end: 146 }
    ]);
  });

  it('renders 3 arcs, all sweep=1, all bulging up, in travel order', () => {
    const d = pathFor(h, verts);
    expect(d).toBe(
      'M 0 100 L 54 100 A 6 6 0 0 1 66 100' +
        ' L 94 100 A 6 6 0 0 1 106 100' +
        ' L 134 100 A 6 6 0 0 1 146 100 L 200 100'
    );
    const { arcs } = parsePath(d);
    expect(arcs).toHaveLength(3);
    for (const a of arcs) {
      expect(a.sweep).toBe(1);
      expect(a.rx).toBe(HOP_R);
      expect(a.ry).toBe(HOP_R);
      expect(arcApexY(a)).toBe(100 - HOP_R);
    }
    // Travel order: left to right.
    expect(arcs.map((a) => a.fromX)).toEqual([54, 94, 134]);
  });
});

describe('T4: three verticals 8px apart -> 1 merged span (§6.4)', () => {
  const h = edge('h', { x: 0, y: 100 }, { x: 200, y: 100 });
  const verts = [92, 100, 108].map((x) =>
    edge(`v${x}`, { x, y: 0 }, { x, y: 200 })
  );

  it('mergeClusters folds crossings within 2*HOP_R+2 into one span', () => {
    expect(mergeClusters([92, 100, 108], HOP_R)).toEqual([{ start: 86, end: 114 }]);
    // Sanity: 40px gaps do NOT merge (the T3 case), and order doesn't matter.
    expect(mergeClusters([140, 60, 100], HOP_R)).toHaveLength(3);
    expect(mergeClusters([], HOP_R)).toEqual([]);
  });

  it('the merged span renders as a flat-topped double arc capped at HOP_R', () => {
    const crossings = findCrossings(segsOf(h, ...verts), []);
    expect(crossings).toHaveLength(3);
    const spans = buildHopSpans(crossings).get(segKey({ edgeId: 'h', index: 0 }))!;
    expect(spans).toEqual([{ start: 86, end: 114 }]); // ONE span, not three

    const d = pathFor(h, verts);
    expect(d).toBe(
      'M 0 100 L 86 100 A 6 6 0 0 1 92 94 L 108 94 A 6 6 0 0 1 114 100 L 200 100'
    );
    const { arcs, points } = parsePath(d);
    // Flat-topped double arc: two quarter arcs, both sweep=1 (rightward).
    expect(arcs).toHaveLength(2);
    expect(arcs.map((a) => a.sweep)).toEqual([1, 1]);
    expect(arcs.every((a) => a.rx === HOP_R && a.ry === HOP_R)).toBe(true);
    // Height cap: nothing in the path rises above y - HOP_R — no balloon.
    const minY = Math.min(...points.map((p) => p.y));
    expect(minY).toBe(100 - HOP_R);
    // The flat top runs at exactly y - HOP_R between the two arcs.
    expect(arcs[0]!.y).toBe(100 - HOP_R);
    expect(arcs[1]!.fromY).toBe(100 - HOP_R);
    expect(arcs[1]!.fromX - arcs[0]!.x).toBe(108 - 92);
  });

  it('reversed travel over the merged span: sweep=0 both arcs, still capped up', () => {
    const back = edge('h', { x: 200, y: 100 }, { x: 0, y: 100 });
    const d = pathFor(back, verts);
    expect(d).toBe(
      'M 200 100 L 114 100 A 6 6 0 0 0 108 94 L 92 94 A 6 6 0 0 0 86 100 L 0 100'
    );
    const { arcs, points } = parsePath(d);
    expect(arcs.map((a) => a.sweep)).toEqual([0, 0]);
    expect(Math.min(...points.map((p) => p.y))).toBe(100 - HOP_R);
    expect(Math.max(...points.map((p) => p.y))).toBe(100); // never dips below
  });
});

describe('buildPath edge cases', () => {
  it('multiple spans on one segment are walked in travel order when going left', () => {
    const back = edge('h', { x: 200, y: 100 }, { x: 0, y: 100 });
    const verts = [
      edge('va', { x: 60, y: 0 }, { x: 60, y: 200 }),
      edge('vb', { x: 140, y: 0 }, { x: 140, y: 200 })
    ];
    const { arcs } = parsePath(pathFor(back, verts));
    expect(arcs).toHaveLength(2);
    // Right span first, then left span; each entered from its right end.
    expect(arcs.map((a) => a.fromX)).toEqual([146, 66]);
    expect(arcs.map((a) => a.x)).toEqual([134, 54]);
    expect(arcs.map((a) => a.sweep)).toEqual([0, 0]);
  });

  it('segments with no spans stay plain lines; empty input yields empty path', () => {
    const bent = edge('b', { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 });
    expect(buildPath(toSegments(bent), new Map())).toBe('M 0 0 L 50 0 L 50 50');
    expect(buildPath([], new Map())).toBe('');
  });
});
