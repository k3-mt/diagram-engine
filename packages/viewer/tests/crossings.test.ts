// Golden tests for geometry M3 step 10 (spec §6.8): T1, T5, T6, T7, T9.
// Polylines are built by hand — no ELK involved.

import { describe, expect, it } from 'vitest';
import { toSegments, type AbsEdge, type Point, type Seg } from '../src/geometry/segments';
import { findCrossings, pointNear, type Rect } from '../src/geometry/crossings';

function edge(id: string, ...points: Point[]): AbsEdge {
  return { id, points };
}

function segsOf(...edges: AbsEdge[]): Seg[] {
  return edges.flatMap((e) => toSegments(e));
}

describe('toSegments (§6.1)', () => {
  it('orients by the 0.5px rule', () => {
    const segs = toSegments(
      edge('e1', { x: 0, y: 100 }, { x: 80, y: 100.4 }, { x: 80, y: 200 })
    );
    expect(segs.map((s) => s.orient)).toEqual(['h', 'v']);
    expect(segs.map((s) => s.index)).toEqual([0, 1]);
    expect(segs.every((s) => s.edgeId === 'e1')).toBe(true);
    expect(segs.some((s) => s.diagonal)).toBe(false);
  });

  it('flags a true diagonal instead of crashing, and passes it through untouched', () => {
    const segs = toSegments(edge('e1', { x: 0, y: 0 }, { x: 50, y: 50 }));
    expect(segs).toHaveLength(1);
    const s = segs[0]!;
    expect(s.diagonal).toBe(true);
    expect([s.x1, s.y1, s.x2, s.y2]).toEqual([0, 0, 50, 50]);
    // Diagonals never take part in hop detection.
    expect(findCrossings(segsOf(edge('h', { x: 0, y: 25 }, { x: 100, y: 25 })).concat(segs), [])).toEqual([]);
  });
});

describe('findCrossings (§6.2 / §6.8)', () => {
  it('T1: two edges crossing at right angles -> exactly 1 hop, on the horizontal', () => {
    const horizontal = edge('h-edge', { x: 0, y: 50 }, { x: 100, y: 50 });
    const vertical = edge('v-edge', { x: 50, y: 0 }, { x: 50, y: 100 });
    const crossings = findCrossings(segsOf(horizontal, vertical), []);
    expect(crossings).toHaveLength(1);
    const c = crossings[0]!;
    expect(c.x).toBe(50);
    expect(c.y).toBe(50);
    // Ownership rule (§6.3): the horizontal segment carries the hop.
    expect(c.hSeg.edgeId).toBe('h-edge');
    expect(c.hSeg.orient).toBe('h');
    expect(c.vSeg.edgeId).toBe('v-edge');
    expect(c.vSeg.orient).toBe('v');
  });

  it('T5: crossing 4px from a bend -> 0 hops', () => {
    // Bent edge: horizontal run ends in a bend at (96, 50); the vertical edge
    // crosses that run at x=92, only 4px from the bend (< CORNER_GUARD=10).
    const bent = edge('bent', { x: 0, y: 50 }, { x: 96, y: 50 }, { x: 96, y: 150 });
    const vertical = edge('v-edge', { x: 92, y: 0 }, { x: 92, y: 100 });
    expect(findCrossings(segsOf(bent, vertical), [])).toEqual([]);
  });

  it('T6: edge crossing its own segment -> 0 hops', () => {
    // A hook that loops back over its own first segment at (50, 0).
    const hook = edge(
      'self',
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 50, y: -50 }
    );
    expect(findCrossings(segsOf(hook), [])).toEqual([]);
  });

  it('T7: two parallel horizontals, same y -> 0 hops', () => {
    const a = edge('a', { x: 0, y: 40 }, { x: 100, y: 40 });
    const b = edge('b', { x: 20, y: 40 }, { x: 140, y: 40 });
    expect(findCrossings(segsOf(a, b), [])).toEqual([]);
  });

  it('excludes shared endpoints (strict inequalities)', () => {
    // Vertical starts exactly on the horizontal — a T-junction, not a crossing.
    const h = edge('h-edge', { x: 0, y: 50 }, { x: 100, y: 50 });
    const v = edge('v-edge', { x: 50, y: 50 }, { x: 50, y: 150 });
    expect(findCrossings(segsOf(h, v), [])).toEqual([]);
  });

  it('rejects crossings within NODE_GUARD of a node boundary', () => {
    const h = edge('h-edge', { x: 0, y: 50 }, { x: 100, y: 50 });
    const v = edge('v-edge', { x: 50, y: 0 }, { x: 50, y: 100 });
    // Node whose right boundary is at x=45, 5px from the crossing (< 6).
    const near: Rect = { x: 5, y: 45, width: 40, height: 10 };
    expect(findCrossings(segsOf(h, v), [near])).toEqual([]);
    // Move it 7px away and the crossing survives.
    const far: Rect = { x: 3, y: 45, width: 40, height: 10 };
    expect(findCrossings(segsOf(h, v), [far])).toHaveLength(1);
  });
});

describe('pointNear', () => {
  it('is true inside, on, and within guard of the rect; false beyond', () => {
    const r: Rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(pointNear(r, 20, 20, 6)).toBe(true); // inside
    expect(pointNear(r, 30, 20, 6)).toBe(true); // on boundary
    expect(pointNear(r, 36, 20, 6)).toBe(true); // exactly guard away
    expect(pointNear(r, 37, 20, 6)).toBe(false); // beyond guard
    expect(pointNear(r, 37, 37, 6)).toBe(false); // beyond on both axes
  });
});

describe('T9: performance', () => {
  // Deterministic PRNG (mulberry32) so the workload never varies between runs.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('200 random orthogonal edges under 50ms', () => {
    const rand = mulberry32(0xd1a6);
    const edges: AbsEdge[] = [];
    for (let i = 0; i < 200; i++) {
      // 5-point orthogonal polyline (4 segments), alternating h/v moves.
      const pts: Point[] = [{ x: rand() * 2000, y: rand() * 2000 }];
      let horizontal = rand() < 0.5;
      for (let j = 0; j < 4; j++) {
        const prev = pts[pts.length - 1]!;
        const step = 40 + rand() * 400;
        pts.push(
          horizontal
            ? { x: prev.x + (rand() < 0.5 ? -step : step), y: prev.y }
            : { x: prev.x, y: prev.y + (rand() < 0.5 ? -step : step) }
        );
        horizontal = !horizontal;
      }
      edges.push(edge(`e${i}`, ...pts));
    }
    const nodeRects: Rect[] = [];
    for (let i = 0; i < 50; i++) {
      nodeRects.push({ x: rand() * 2000, y: rand() * 2000, width: 160, height: 56 });
    }
    const segs = segsOf(...edges);
    expect(segs.length).toBe(800);

    // Best of N, not a single run: vitest runs test files in parallel, so one
    // timed call competes with ~19 other files for CPU and reads several times
    // slower than the algorithm actually is. The fastest run is the honest
    // measure of the code, and still catches a real regression — an algorithm
    // 4x slower blows the budget on every attempt, not just the unlucky ones.
    const RUNS = 5;
    let best = Infinity;
    let crossings: ReturnType<typeof findCrossings> = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      crossings = findCrossings(segs, nodeRects);
      best = Math.min(best, performance.now() - t0);
    }

    expect(crossings.length).toBeGreaterThan(0); // the workload is non-trivial
    for (const c of crossings) {
      expect(c.hSeg.edgeId).not.toBe(c.vSeg.edgeId);
    }
    expect(best).toBeLessThan(50);
  });
});
