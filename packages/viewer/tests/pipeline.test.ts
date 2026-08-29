// Integration test: the full M2+M3 pipeline over every VALID fixture.
//
//   fixture -> layout() (toElk -> REAL elkjs -> flatten, spec §5)
//           -> composePath() per edge (segments -> crossings -> hops ->
//              corner rounding -> SVG d string, spec §6)
//
// Asserts, per fixture:
//  - no NaN (or non-finite value) anywhere in the laid-out geometry,
//  - every node/group rect sits inside its parent group's rect
//    (nesting containment — the M2 exit criterion),
//  - every edge produces a non-empty path string starting with "M"
//    and containing no NaN,
// and across the suite that the crossing-demo fixture yields at least
// one hop arc (an "A" command — arcs come only from hops, §6.5).
//
// Runs headless in Node through the same layout() code path the worker
// uses. Geometry stays in memory; nothing is written back (§1.4/§3.1).

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphDoc } from '@diagram-engine/core';
import { layout } from '../src/layout/runLayout.js';
import type { LaidOut, Rect } from '../src/layout/fromElk.js';
import { composePath, toSegments, type Seg } from '../src/geometry';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures',
);

/** Every schema-valid fixture (the invalid-* ones never reach layout). */
const VALID_FIXTURES = [
  'empty.json',
  'flat-three-nodes.json',
  'nested-two-deep.json',
  'cross-boundary-edges.json',
] as const;

/** The fixture whose edges are known to cross (the hop demo). */
const CROSSING_FIXTURE = 'cross-boundary-edges.json';

interface Laid {
  doc: GraphDoc;
  laid: LaidOut;
  /** SVG d strings, one per laid-out edge, via composePath. */
  paths: string[];
}

function loadDoc(name: string): GraphDoc {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as GraphDoc;
}

function finite(n: number): boolean {
  return Number.isFinite(n); // false for NaN and ±Infinity
}

function rectFinite(r: Rect): boolean {
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height);
}

/** Child rect fully inside parent rect (inclusive). */
function contains(parent: Rect, child: Rect): boolean {
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height
  );
}

// Lay out every fixture once, up front.
const results = new Map<string, Laid>();

beforeAll(async () => {
  for (const name of VALID_FIXTURES) {
    const doc = loadDoc(name);
    const laid = await layout(doc);
    // Same choices as the debug renderer (debug/frame.ts): crossings run
    // against ALL edges' segments; NODE_GUARD against node rects only
    // (groups are containers, not obstacles).
    const allSegments: Seg[] = laid.edges.flatMap((e) => toSegments(e));
    const nodeRects: Rect[] = doc.nodes.flatMap((n) => {
      const r = laid.nodes.get(n.id);
      return r ? [r] : [];
    });
    const paths = laid.edges.map((e) => composePath(e, allSegments, nodeRects));
    results.set(name, { doc, laid, paths });
  }
});

describe.each(VALID_FIXTURES)('pipeline: %s', (name) => {
  it('lays out every node, group, and edge of the document', () => {
    const { doc, laid } = results.get(name)!;
    for (const el of [...doc.nodes, ...doc.groups]) {
      expect(laid.nodes.get(el.id), `no rect for ${el.id}`).toBeDefined();
    }
    const laidEdgeIds = new Set(laid.edges.map((e) => e.id));
    for (const e of doc.edges) {
      expect(laidEdgeIds.has(e.id), `edge ${e.id} missing`).toBe(true);
    }
  });

  it('produces no NaN anywhere in the geometry', () => {
    const { laid, paths } = results.get(name)!;
    expect(finite(laid.width)).toBe(true);
    expect(finite(laid.height)).toBe(true);
    for (const [id, rect] of laid.nodes) {
      expect(rectFinite(rect), `rect of ${id} has a non-finite value`).toBe(true);
    }
    for (const e of laid.edges) {
      for (const p of e.points) {
        expect(
          finite(p.x) && finite(p.y),
          `edge ${e.id} has a non-finite point`,
        ).toBe(true);
      }
    }
    for (const d of paths) {
      expect(d).not.toContain('NaN');
    }
  });

  it('nests every element inside its parent group rect (M2 exit)', () => {
    const { doc, laid } = results.get(name)!;
    for (const el of [...doc.nodes, ...doc.groups]) {
      if (el.parent === null) continue;
      const child = laid.nodes.get(el.id)!;
      const parent = laid.nodes.get(el.parent)!;
      expect(
        contains(parent, child),
        `${el.id} ${JSON.stringify(child)} escapes its group ` +
          `${el.parent} ${JSON.stringify(parent)}`,
      ).toBe(true);
    }
  });

  it('composes a non-empty M-first path for every edge', () => {
    const { laid, paths } = results.get(name)!;
    expect(paths).toHaveLength(laid.edges.length);
    for (let i = 0; i < paths.length; i++) {
      const d = paths[i]!;
      expect(d.length, `edge ${laid.edges[i]!.id} path is empty`).toBeGreaterThan(0);
      expect(d.startsWith('M '), `edge ${laid.edges[i]!.id} path: ${d}`).toBe(true);
    }
  });
});

describe('pipeline: hops', () => {
  it(`${CROSSING_FIXTURE} renders at least one hop arc`, () => {
    const { paths } = results.get(CROSSING_FIXTURE)!;
    // Arc commands come only from hop spans (§6.5); corner rounding emits Q.
    const arcCount = paths
      .map((d) => (d.match(/A /g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(arcCount).toBeGreaterThanOrEqual(1);
  });
});
