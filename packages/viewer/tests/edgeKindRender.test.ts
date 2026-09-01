// tests/edgeKindRender.test.ts — §3.9 in the picture: the return leg, the
// step badge, and the geometry that puts the second stroke beside the first.
//
// Rendered with react-dom/server, like tests/render.test.ts: no DOM, no
// browser, every rule driven directly as a pure function.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GEdge } from '@diagram-engine/core';
import {
  ARROW_MARKER_ID,
  EDGE_DASH,
  EdgePath,
  LIT_W,
  RETURN_MARKER_ID,
  ReturnMarker,
  SEQ_ANCHOR,
  edgeDash,
} from '../src/render/EdgePath.js';
import {
  midpointAlong,
  pathLength,
  pointAlong,
  pointAtFraction,
  pointNearStart,
} from '../src/geometry/polyline.js';

const edge = (over: Partial<GEdge> = {}): GEdge => ({
  id: 'e1',
  from: 'a',
  to: 'b',
  ...over,
});

/** A straight horizontal run, and an L-shaped orthogonal route. */
const STRAIGHT = [
  { x: 0, y: 100 },
  { x: 200, y: 100 },
];
const ELBOW = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 80 },
];

const markup = (props: Parameters<typeof EdgePath>[0]): string =>
  renderToStaticMarkup(createElement(EdgePath, props));

/** Minimum clear distance between the step badge and the return label, px. */
const SEQ_R_GAP = 12;

describe('reading a point off a polyline', () => {
  it('midpointAlong measures by ARC LENGTH, not by vertex', () => {
    // The middle VERTEX of the elbow is the corner (100,0). By arc length the
    // route is 180 long, so half way is 90 along the first leg.
    const mid = midpointAlong(ELBOW);
    expect(mid).toEqual({ x: 90, y: 0, dx: 1, dy: 0 });
  });

  it('pointAlong clamps to both ends', () => {
    expect(pointAlong(STRAIGHT, 0)).toMatchObject({ x: 0, y: 100 });
    expect(pointAlong(STRAIGHT, 50)).toMatchObject({ x: 50, y: 100 });
    expect(pointAlong(STRAIGHT, 10_000)).toMatchObject({ x: 200, y: 100 });
    expect(pointAlong(STRAIGHT, -10)).toMatchObject({ x: 0, y: 100 });
  });

  it('answers null when there is nothing to measure', () => {
    expect(midpointAlong([])).toBe(null);
    expect(pointAlong([{ x: 1, y: 1 }], 5)).toBe(null);
  });

  it('pathLength measures the whole route, bends included', () => {
    expect(pathLength(STRAIGHT)).toBe(200);
    expect(pathLength(ELBOW)).toBe(180);
    expect(pathLength([])).toBe(0);
  });

  it('pointAtFraction reads a proportion of the way along', () => {
    expect(pointAtFraction(STRAIGHT, 0.25)).toMatchObject({ x: 50, y: 100 });
    expect(pointAtFraction(STRAIGHT, 2)).toMatchObject({ x: 200, y: 100 });
  });

  it('pointNearStart holds a fixed distance, then yields on a short edge', () => {
    // A decoration anchored near the source should sit at a predictable
    // distance on a long edge...
    expect(pointNearStart(STRAIGHT, 48, 0.34)).toMatchObject({ x: 48 });
    // ...and pull BACK on a short one rather than sliding past the middle
    // into the edge label parked there: 34% of 200 is 68, so 80 is capped.
    expect(pointNearStart(STRAIGHT, 80, 0.34)).toMatchObject({ x: 68 });
    expect(pointNearStart([{ x: 0, y: 0 }], 48, 0.34)).toBe(null);
  });
});

describe('edgeDash — rule 6, asked once', () => {
  it('dashes the async kinds and only those', () => {
    expect(edgeDash(edge({ kind: 'publish' }))).toBe(EDGE_DASH);
    expect(edgeDash(edge({ kind: 'consume' }))).toBe(EDGE_DASH);
    expect(edgeDash(edge({ kind: 'call' }))).toBeUndefined();
    expect(edgeDash(edge({ style: 'dashed' }))).toBe(EDGE_DASH);
    expect(edgeDash(edge())).toBeUndefined();
  });
});

describe('the return head marker', () => {
  it('is an OPEN chevron, not a filled triangle', () => {
    // The whole distinction the design rests on. A filled head at the source
    // would say "these two call each other" (which is `arrow: "both"`); an
    // open one says "this end called, and this came back".
    const m = renderToStaticMarkup(createElement(ReturnMarker));
    expect(m).toContain(`id="${RETURN_MARKER_ID}"`);
    expect(m).toContain('fill="none"');
    expect(m).toContain('stroke="currentColor"');
    expect(m).not.toContain('fill="currentColor"');
    // auto-start-reverse is what makes it face back down the line when used
    // as a markerStart.
    expect(m).toContain('orient="auto-start-reverse"');
  });
});

describe('EdgePath markup', () => {
  const D = 'M 0 100 L 200 100';

  it('is UNCHANGED for an edge with none of §3.9s fields', () => {
    // The compatibility guarantee, asserted rather than assumed: a document
    // written before the kind existed must render to the same bytes, with no
    // wrapping group and no extra elements.
    const before = markup({ edge: edge(), d: D });
    const after = markup({ edge: edge(), d: D, points: STRAIGHT });
    expect(after).toBe(before);
    expect(after.startsWith('<path')).toBe(true);
    expect(after).not.toContain('data-edge-group');
    expect(after).not.toContain('data-edge-return');
  });

  it('puts an OPEN return head at the source for a call', () => {
    const html = markup({ edge: edge({ kind: 'call' }), d: D, points: STRAIGHT });
    // One stroke, two heads: filled at the target, open back at the caller.
    expect(html).toContain(`marker-end="url(#${ARROW_MARKER_ID})"`);
    expect(html).toContain(`marker-start="url(#${RETURN_MARKER_ID})"`);
    // And NOT a second stroke. The parallel-leg design is gone: at any sane
    // offset the second line read as a rendering seam rather than an arrow.
    expect(html).not.toContain('data-edge-return=');
    expect((html.match(/<path/g) ?? []).length).toBe(1);
  });

  it('needs no polyline for the heads', () => {
    // The arrowheads are markers on the path itself, so an edge draws its
    // return correctly even where the caller has no points to give.
    const html = markup({ edge: edge({ kind: 'call' }), d: D });
    expect(html).toContain(`marker-start="url(#${RETURN_MARKER_ID})"`);
  });

  it('puts no return head on a write or a publish', () => {
    for (const kind of ['write', 'publish'] as const) {
      const html = markup({ edge: edge({ kind }), d: D, points: STRAIGHT });
      expect(html, kind).not.toContain('marker-start');
    }
  });

  it('dashes a consume edge, which still answers', () => {
    const html = markup({ edge: edge({ kind: 'consume' }), d: D, points: STRAIGHT });
    expect(html).toContain(`stroke-dasharray="${EDGE_DASH}"`);
    expect(html).toContain(`marker-start="url(#${RETURN_MARKER_ID})"`);
  });

  it('names what comes back, beside the head where it lands', () => {
    const html = markup({
      edge: edge({ kind: 'read', returns: 'order[]' }),
      d: D,
      points: STRAIGHT,
    });
    expect(html).toContain('data-edge-returns="e1"');
    expect(html).toContain('order[]');
    // Near the SOURCE end — that is where the open head is and where the
    // response arrives. Anywhere near the midpoint would collide with the
    // edge's own label, which is painted over it from layer 4.
    const x = Number(/data-edge-returns="e1"[\s\S]*?<text x="([\d.]+)"/.exec(html)?.[1]);
    expect(x).toBeLessThan(100);
  });

  it('draws the head with nothing named', () => {
    // `returns` names the head; the KIND is what says there is one. An author
    // should not have to know the payload's name to state that a call answers.
    const html = markup({ edge: edge({ kind: 'read' }), d: D, points: STRAIGHT });
    expect(html).toContain(`marker-start="url(#${RETURN_MARKER_ID})"`);
    expect(html).not.toContain('data-edge-returns');
  });

  it('keeps TWO FILLED heads distinct from a call and its answer', () => {
    // `arrow: "both"` is a symmetric peer relationship and keeps the filled
    // marker at both ends; a returning kind gets filled-plus-open. Two
    // different claims, two different pictures.
    const both = markup({ edge: edge({ arrow: 'both' }), d: D, points: STRAIGHT });
    expect(both).toContain(`marker-start="url(#${ARROW_MARKER_ID})"`);
    expect(both).not.toContain(RETURN_MARKER_ID);
  });

  it('refuses the return head where it would contradict the picture', () => {
    // A crow's-foot edge is an ERD relationship with no caller; a `both`
    // arrow already draws a filled head where the open one would go; `none`
    // says draw no heads at all. V20 rejects the middle combination outright
    // — this is the renderer declining to draw a contradiction even when
    // handed one.
    for (const over of [
      { kind: 'call' as const, cardinality: '1:N' as const },
      { kind: 'call' as const, arrow: 'both' as const },
      { kind: 'call' as const, arrow: 'none' as const },
    ]) {
      const html = markup({ edge: edge(over), d: D, points: STRAIGHT });
      expect(html, JSON.stringify(over)).not.toContain(RETURN_MARKER_ID);
    }
  });

  it('draws the step badge near the SOURCE end', () => {
    const html = markup({ edge: edge({ seq: 3 }), d: D, points: STRAIGHT });
    expect(html).toContain('data-edge-seq="e1"');
    expect(html).toContain('data-seq="3"');
    expect(html).toContain(`cx="${SEQ_ANCHOR}"`);
  });

  it('keeps the badge and the return label apart', () => {
    // Both belong near the source. They are separated ALONG the line (the
    // badge nearer) and ACROSS it (the label offset perpendicular), so an
    // edge carrying both does not stack them.
    const html = markup({
      edge: edge({ kind: 'call', returns: '200 OK', seq: 1 }),
      d: D,
      points: STRAIGHT,
    });
    const badgeX = Number(/data-edge-seq[\s\S]*?<circle cx="([\d.]+)"/.exec(html)?.[1]);
    const labelX = Number(/data-edge-returns[\s\S]*?<text x="([\d.]+)"/.exec(html)?.[1]);
    expect(badgeX).toBeLessThan(labelX);
    expect(labelX - badgeX).toBeGreaterThan(SEQ_R_GAP);
  });

  it('puts a badge on an edge with no kind at all', () => {
    // `seq` is ordering, independent of what the line means: numbering the
    // steps of a flow must not force a kind onto every edge in it.
    const html = markup({ edge: edge({ seq: 7 }), d: D, points: STRAIGHT });
    expect(html).toContain('data-seq="7"');
    expect(html).not.toContain(RETURN_MARKER_ID);
  });

  it('lights itself, rather than being painted over', () => {
    // §8.7's emphasis is applied to the edge IN LAYER 3. Drawn as a second
    // heavy stroke in the overlay layer it went straight through the step
    // badge and the edge label, because layer 7 is above both.
    const html = markup({
      edge: edge({ kind: 'call', seq: 1 }),
      d: D,
      points: STRAIGHT,
      lit: '#3B6FD4',
    });
    expect(html).toContain('data-lit="true"');
    expect(html).toContain(`stroke-width="${LIT_W}"`);
    expect(html).toContain('#3B6FD4');
    // The badge is emitted AFTER the path, so it paints over it — which is
    // the whole reason the emphasis moved here.
    expect(html.indexOf('data-edge-seq')).toBeGreaterThan(html.indexOf('data-edge='));
  });

  it('carries the kind onto the outbound path for styling and tests', () => {
    expect(markup({ edge: edge({ kind: 'read' }), d: D, points: STRAIGHT })).toContain(
      'data-kind="read"',
    );
  });
});
