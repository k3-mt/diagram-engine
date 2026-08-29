// Tests for geometry M3 step 12 (spec §6.5–§6.7): structured path building,
// corner rounding applied AFTER hops, and the arrowhead precondition that a
// hopped path's final segment stays straight. Polylines built by hand.

import { describe, expect, it } from 'vitest';
import { toSegments, type AbsEdge, type Point, type Seg } from '../src/geometry/segments';
import { findCrossings, HOP_R, type Rect } from '../src/geometry/crossings';
import { buildHopSpans, segKey, type Span } from '../src/geometry/hops';
import { buildPath, buildPathCmds, serializePath, type PathCmd } from '../src/geometry/path';
import { roundCorners, CORNER_R, HOP_CLEARANCE } from '../src/geometry/corners';
import { composePath } from '../src/geometry/index';

function edge(id: string, ...points: Point[]): AbsEdge {
  return { id, points };
}

function segsOf(...edges: AbsEdge[]): Seg[] {
  return edges.flatMap((e) => toSegments(e));
}

/** Full pipeline for `main` against `others`, WITHOUT corner rounding. */
function hoppedCmds(main: AbsEdge, others: AbsEdge[], nodeRects: Rect[] = []): {
  cmds: PathCmd[];
  segs: Seg[];
  spans: Map<string, Span[]>;
} {
  const segs = toSegments(main);
  const spans = buildHopSpans(findCrossings(segsOf(main, ...others), nodeRects));
  return { cmds: buildPathCmds(segs, spans), segs, spans };
}

describe('buildPath via command list matches the §6.5 string builder', () => {
  it('produces the exact golden strings for hop and merged-span cases', () => {
    const h = edge('h', { x: 0, y: 50 }, { x: 100, y: 50 });
    const v = edge('v', { x: 50, y: 0 }, { x: 50, y: 100 });
    const spans = buildHopSpans(findCrossings(segsOf(h, v), []));
    expect(buildPath(toSegments(h), spans)).toBe(
      'M 0 50 L 44 50 A 6 6 0 0 1 56 50 L 100 50'
    );
    // Left-travelling: sweep flag inverts.
    const back = edge('h2', { x: 100, y: 50 }, { x: 0, y: 50 });
    const spans2 = buildHopSpans(findCrossings(segsOf(back, v), []));
    expect(buildPath(toSegments(back), spans2)).toBe(
      'M 100 50 L 56 50 A 6 6 0 0 0 44 50 L 0 50'
    );
  });

  it('serializePath round-trips a hand-built command list', () => {
    const cmds: PathCmd[] = [
      { kind: 'M', x: 0, y: 0, segIndex: 0 },
      { kind: 'L', x: 92, y: 0, segIndex: 0 },
      { kind: 'Q', cx: 100, cy: 0, x: 100, y: 8, segIndex: 1 },
      { kind: 'A', rx: 6, ry: 6, sweep: 1, x: 112, y: 8, segIndex: 1 }
    ];
    expect(serializePath(cmds)).toBe('M 0 0 L 92 0 Q 100 0 100 8 A 6 6 0 0 1 112 8');
  });
});

describe('corner rounding (§6.6)', () => {
  it('replaces a corner with a trimmed line and a Q through the corner point', () => {
    const bent = edge('b', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 });
    const segs = toSegments(bent);
    const rounded = roundCorners(buildPathCmds(segs, new Map()), segs, new Map());
    // Line stops CORNER_R short of P=(100,0); Q's control point IS P;
    // Q ends CORNER_R into the next segment.
    expect(serializePath(rounded)).toBe('M 0 0 L 92 0 Q 100 0 100 8 L 100 100');
    const q = rounded.find((c) => c.kind === 'Q');
    expect(q).toBeDefined();
    expect(q).toMatchObject({ cx: 100, cy: 0, x: 100, y: 8 });
    expect(CORNER_R).toBe(8);
  });

  it('rounds every eligible corner of a multi-bend path, any travel direction', () => {
    const z = edge(
      'z',
      { x: 200, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 }
    );
    const segs = toSegments(z);
    const d = serializePath(roundCorners(buildPathCmds(segs, new Map()), segs, new Map()));
    // Leftward then down then leftward: unit vectors (-1,0), (0,1), (-1,0).
    expect(d).toBe(
      'M 200 0 L 108 0 Q 100 0 100 8 L 100 92 Q 100 100 92 100 L 0 100'
    );
  });

  it('skips the corner when either adjoining segment is under 20px', () => {
    const short = edge('s', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 15 });
    const segs = toSegments(short);
    const rounded = roundCorners(buildPathCmds(segs, new Map()), segs, new Map());
    expect(serializePath(rounded)).toBe('M 0 0 L 100 0 L 100 15');
    expect(rounded.some((c) => c.kind === 'Q')).toBe(false);
    // Exactly 20px is NOT under 20px — it rounds.
    const ok = edge('ok', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 });
    const okSegs = toSegments(ok);
    const okRounded = roundCorners(buildPathCmds(okSegs, new Map()), okSegs, new Map());
    expect(okRounded.some((c) => c.kind === 'Q')).toBe(true);
  });

  it('skips a corner with a hop span within 12px, rounds one safely away', () => {
    // Main bends at (100,50). A vertical at x=85 crosses the horizontal:
    // crossing is 15px from the bend (>= CORNER_GUARD, so it hops), and the
    // span [79,91] ends 9px from the corner — inside HOP_CLEARANCE.
    const main = edge('m', { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 });
    const near = edge('vn', { x: 85, y: 0 }, { x: 85, y: 100 });
    const { cmds, segs, spans } = hoppedCmds(main, [near]);
    expect(spans.get(segKey({ edgeId: 'm', index: 0 }))).toEqual([
      { start: 85 - HOP_R, end: 85 + HOP_R }
    ]);
    expect(100 - (85 + HOP_R)).toBeLessThan(HOP_CLEARANCE);
    const rounded = roundCorners(cmds, segs, spans);
    expect(rounded.some((c) => c.kind === 'Q')).toBe(false);
    expect(serializePath(rounded)).toBe(
      'M 0 50 L 79 50 A 6 6 0 0 1 91 50 L 100 50 L 100 150'
    );

    // Same shape, vertical at x=50: span [44,56] is 44px clear — it rounds.
    const far = edge('vf', { x: 50, y: 0 }, { x: 50, y: 100 });
    const clear = hoppedCmds(main, [far]);
    const clearRounded = roundCorners(clear.cmds, clear.segs, clear.spans);
    expect(clearRounded.some((c) => c.kind === 'Q')).toBe(true);
  });

  it('does not round a collinear continuation (no actual turn)', () => {
    const straight = edge('c', { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 120, y: 0 });
    const segs = toSegments(straight);
    const rounded = roundCorners(buildPathCmds(segs, new Map()), segs, new Map());
    expect(rounded.some((c) => c.kind === 'Q')).toBe(false);
  });

  it('does not mutate the input command list', () => {
    const bent = edge('b', { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 });
    const segs = toSegments(bent);
    const cmds = buildPathCmds(segs, new Map());
    const before = JSON.parse(JSON.stringify(cmds));
    roundCorners(cmds, segs, new Map());
    expect(cmds).toEqual(before);
  });
});

describe('rounding after hops: arcs are untouched (§6.6 ordering)', () => {
  // Main: right along y=50, bend at (100,50), down to (100,150).
  // A vertical at x=50 crosses the horizontal run.
  const main = edge('m', { x: 0, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 150 });
  const cross = edge('v', { x: 50, y: 0 }, { x: 50, y: 100 });

  it('a path with both keeps its A commands bit-identical and gains a Q', () => {
    const { cmds, segs, spans } = hoppedCmds(main, [cross]);
    const arcsBefore = cmds.filter((c) => c.kind === 'A');
    expect(arcsBefore).toHaveLength(1);

    const rounded = roundCorners(cmds, segs, spans);
    const arcsAfter = rounded.filter((c) => c.kind === 'A');
    expect(arcsAfter).toEqual(arcsBefore); // hop arc completely undisturbed

    expect(serializePath(rounded)).toBe(
      'M 0 50 L 44 50 A 6 6 0 0 1 56 50 L 92 50 Q 100 50 100 58 L 100 150'
    );
  });

  it('composePath runs the whole pipeline to the same string', () => {
    const all = segsOf(main, cross);
    expect(composePath(main, all, [])).toBe(
      'M 0 50 L 44 50 A 6 6 0 0 1 56 50 L 92 50 Q 100 50 100 58 L 100 150'
    );
    // And the crossing edge itself renders straight (ownership rule).
    expect(composePath(cross, all, [])).toBe('M 50 0 L 50 100');
  });
});

describe('arrowhead precondition (§6.7): final segment of a hopped path is straight', () => {
  it('no A command lives in the last segment; the path ends with an L at the endpoint', () => {
    // Two-segment main whose FIRST segment is hopped; a second edge crosses
    // the vertical tail too — but verticals never hop (§6.3), so the tail
    // stays straight no matter what.
    const main = edge('m', { x: 0, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 200 });
    const v = edge('v', { x: 100, y: 0 }, { x: 100, y: 100 });
    const h2 = edge('h2', { x: 150, y: 120 }, { x: 300, y: 120 });
    const { cmds, segs, spans } = hoppedCmds(main, [v, h2]);
    const rounded = roundCorners(cmds, segs, spans);

    expect(rounded.some((c) => c.kind === 'A')).toBe(true); // path IS hopped
    const lastSegIndex = segs[segs.length - 1]!.index;
    // No arc within the final segment...
    expect(
      rounded.filter((c) => c.segIndex === lastSegIndex && c.kind === 'A')
    ).toHaveLength(0);
    // ...and the last command is a straight L landing exactly on the endpoint,
    // so the marker orients correctly with no manual angle math.
    const last = rounded[rounded.length - 1]!;
    expect(last.kind).toBe('L');
    expect(last).toMatchObject({ x: 200, y: 200 });
    // String-level check: nothing after the final A except L commands.
    const d = serializePath(rounded);
    const tail = d.slice(d.lastIndexOf('A'));
    expect(tail).toMatch(/^A [^AQ]*(Q [^AQ]*)?L 200 200$/);
  });

  it('holds when the LAST segment is horizontal and hopped: guards keep the arc off the tip', () => {
    // Hops are guarded 10px away from segment ends (CORNER_GUARD), so even a
    // hop on the final segment leaves the endpoint approach straight.
    const main = edge('m', { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    const v = edge('v', { x: 150, y: 50 }, { x: 150, y: 150 });
    const all = segsOf(main, v);
    const d = composePath(main, all, []);
    expect(d).toBe(
      'M 50 0 L 50 92 Q 50 100 58 100 L 144 100 A 6 6 0 0 1 156 100 L 250 100'
    );
    // The path ends with a straight L run into the endpoint, after the arc.
    expect(d.endsWith('L 250 100')).toBe(true);
  });
});
