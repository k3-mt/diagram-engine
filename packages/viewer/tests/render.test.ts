// tests/render.test.ts — the product renderer (spec M4 Step 13).
//
// Covers: the §8.2 theme is complete, one icon per NodeType, the STRICT
// §8.1 z-order of a composed frame, dashed edges, and the §6.7 arrowhead
// marker attributes.
//
// Rendered with react-dom/server (no DOM needed), so the assertions are on
// the emitted markup, which is exactly what the z-order rule is about:
// document order is paint order in SVG.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeTypeSchema, type GraphDoc, type NodeType } from '@diagram-engine/core';
import type { LaidOut } from '../src/layout/fromElk.js';
import { theme } from '../src/render/theme.js';
import { ICON_SIZE, NODE_ICONS } from '../src/render/icons.js';
import { Canvas } from '../src/render/Canvas.js';
import { ArrowMarker } from '../src/render/EdgePath.js';
import { truncateToWidth } from '../src/render/NodeBox.js';
import { ERROR_COLOR, StatusBar } from '../src/render/StatusBar.js';

const NODE_TYPES = NodeTypeSchema.options as readonly NodeType[];

// --- fixture ---------------------------------------------------------------
// One group holding one node, one node outside it, one dashed labelled edge
// between them and one solid edge back. Geometry is hand-written: this suite
// tests the RENDERER, not the layout pipeline (which pipeline.test.ts covers).

const doc: GraphDoc = {
  schemaVersion: 1,
  title: 'Render fixture',
  direction: 'DOWN',
  groups: [
    { id: 'outer', label: 'Outer', kind: 'vpc', parent: null },
    { id: 'inner', label: 'Inner', kind: 'cluster', parent: 'outer' },
  ],
  nodes: [
    { id: 'api', label: 'API', type: 'service', parent: 'inner', note: 'edge' },
    { id: 'db', label: 'Postgres', type: 'database', parent: null },
  ],
  edges: [
    { id: 'e1', from: 'api', to: 'db', label: 'writes', style: 'dashed' },
    { id: 'e2', from: 'db', to: 'api', arrow: 'both' },
    { id: 'e3', from: 'api', to: 'db', arrow: 'none' },
  ],
  collapsed: [],
};

const laidOut: LaidOut = {
  width: 400,
  height: 400,
  nodes: new Map([
    ['outer', { x: 0, y: 0, width: 240, height: 180 }],
    ['inner', { x: 20, y: 20, width: 200, height: 140 }],
    ['api', { x: 40, y: 64, width: 160, height: 76 }],
    ['db', { x: 40, y: 260, width: 160, height: 60 }],
  ]),
  edges: [
    {
      id: 'e1',
      points: [
        { x: 120, y: 140 },
        { x: 120, y: 260 },
      ],
      label: { text: 'writes', x: 126, y: 194, width: 34, height: 14 },
    },
    {
      id: 'e2',
      points: [
        { x: 150, y: 260 },
        { x: 150, y: 140 },
      ],
    },
    {
      id: 'e3',
      points: [
        { x: 90, y: 140 },
        { x: 90, y: 260 },
      ],
    },
  ],
};

const paths = [
  'M 120 140 L 120 260',
  'M 150 260 L 150 140',
  'M 90 140 L 90 260',
];

function markup(): string {
  return renderToStaticMarkup(
    createElement(Canvas, { doc, laidOut, paths, transform: 'translate(4,4)' }),
  );
}

// --- §8.2 theme ------------------------------------------------------------

describe('theme (§8.2)', () => {
  it('carries every value from the spec listing', () => {
    expect(theme.canvas).toBe('#FBFBF9');
    expect(theme.node).toEqual({
      fill: '#FFFFFF',
      stroke: '#D4D2CC',
      radius: 8,
      shadow: '0 1px 2px rgba(0,0,0,.06)',
    });
    expect(theme.text).toEqual({ primary: '#1F1E1C', secondary: '#77756E' });
    expect(theme.edge).toEqual({ stroke: '#8A8880', width: 1.5 });
    expect(theme.group).toEqual({
      fill: 'rgba(0,0,0,.018)',
      stroke: '#C9C7C0',
      dash: '4 4',
      radius: 12,
    });
  });

  it('has an accent for all seven node types', () => {
    expect(NODE_TYPES).toHaveLength(7);
    expect(Object.keys(theme.accent).sort()).toEqual([...NODE_TYPES].sort());
    expect(theme.accent).toEqual({
      service: '#3B6FD4',
      database: '#2E8B69',
      queue: '#C4791E',
      cache: '#B8452F',
      storage: '#6B5BA8',
      client: '#4A4845',
      external: '#8A8880',
    });
  });
});

// --- icons -----------------------------------------------------------------

describe('icons (§8.2)', () => {
  it('has one 20px inline glyph per NodeType, stroked in currentColor', () => {
    expect(Object.keys(NODE_ICONS).sort()).toEqual([...NODE_TYPES].sort());
    expect(ICON_SIZE).toBe(20);
    for (const type of NODE_TYPES) {
      const Icon = NODE_ICONS[type];
      const html = renderToStaticMarkup(createElement(Icon, { x: 5, y: 7 }));
      expect(html, type).toContain('<svg');
      expect(html, type).toContain('stroke="currentColor"');
      expect(html, type).toContain('width="20"');
      expect(html, type).toContain('height="20"');
      expect(html, type).toContain('x="5"');
      expect(html, type).toContain('y="7"');
      // Line art, not a filled blob.
      expect(html, type).toContain('fill="none"');
    }
  });

  it('draws distinct glyphs (no placeholder repeated)', () => {
    const shapes = NODE_TYPES.map((t) =>
      renderToStaticMarkup(createElement(NODE_ICONS[t], {})),
    );
    expect(new Set(shapes).size).toBe(NODE_TYPES.length);
  });
});

// --- §8.1 z-order ----------------------------------------------------------

describe('Canvas z-order (§8.1)', () => {
  const html = markup();

  it('emits the six layers in strict paint order', () => {
    const at = (marker: string): number => {
      const i = html.indexOf(marker);
      expect(i, marker).toBeGreaterThanOrEqual(0);
      return i;
    };
    const groupRect = at('data-layer="group-rect"');
    const groupLabel = at('data-layer="group-label"');
    const edgePath = at('data-layer="edge-path"');
    const edgeLabel = at('data-layer="edge-label"');
    const nodeBox = at('data-layer="node-box"');
    const nodeContent = at('data-layer="node-content"');

    expect(groupRect).toBeLessThan(groupLabel);
    expect(groupLabel).toBeLessThan(edgePath);
    expect(edgePath).toBeLessThan(edgeLabel);
    expect(edgeLabel).toBeLessThan(nodeBox);
    expect(nodeBox).toBeLessThan(nodeContent);
  });

  it('draws group rectangles outermost first', () => {
    expect(html.indexOf('data-group="outer"')).toBeLessThan(
      html.indexOf('data-group="inner"'),
    );
  });

  it('gives every edge label a halo rect in the canvas colour', () => {
    const label = html.slice(html.indexOf('data-edge-label="e1"'));
    const halo = label.slice(0, label.indexOf('</g>'));
    expect(halo).toContain(`fill="${theme.canvas}"`);
    expect(halo.indexOf('<rect')).toBeLessThan(halo.indexOf('<text'));
    expect(halo).toContain('writes');
  });

  it('applies the parent viewport transform and a 150ms cross-fade', () => {
    expect(html).toContain('transform="translate(4,4)"');
    expect(html).toContain('150ms');
  });

  it('paints node boxes white with a 3px type-coloured left border', () => {
    const box = html.slice(html.indexOf('data-node="api"'));
    const frag = box.slice(0, box.indexOf('</g>'));

    // The box rect itself, whatever order React emits its attributes in.
    const rect = /<rect\b[^>]*>/.exec(frag)?.[0];
    expect(rect, 'node box <rect>').toBeTruthy();
    const attr = (el: string, name: string): string | undefined =>
      new RegExp(`\\b${name}="([^"]*)"`).exec(el)?.[1];

    // §8.2: the box fill is the theme's white — NEVER the type colour.
    expect(attr(rect!, 'fill')).toBe(theme.node.fill);
    expect(attr(rect!, 'stroke')).toBe(theme.node.stroke);
    expect(attr(rect!, 'rx')).toBe(String(theme.node.radius));

    // The accent appears exactly once, as the fill of the left-border <path>.
    const paths = frag.match(/<path\b[^>]*>/g) ?? [];
    expect(paths.length).toBe(1);
    expect(attr(paths[0]!, 'fill')).toBe(theme.accent.service);

    // No element other than that <path> may carry the accent colour.
    const accentCarriers = (frag.match(/<[a-z]+\b[^>]*>/g) ?? []).filter((el) =>
      el.includes(theme.accent.service),
    );
    expect(accentCarriers).toEqual(paths);
  });
});

// --- edge styling and §6.7 marker -----------------------------------------

describe('edges', () => {
  const html = markup();

  /** The single <path …> element for one edge, attributes only. */
  const frag = (id: string): string => {
    const s = html.slice(html.indexOf(`data-edge="${id}"`));
    return s.slice(0, s.indexOf('>'));
  };

  it('dashes only edges with style "dashed"', () => {
    expect(frag('e1')).toContain('stroke-dasharray="6 4"');
    expect(frag('e2')).not.toContain('stroke-dasharray');
  });

  it('marks ends per edge.arrow (default forward)', () => {
    // e1 has no arrow field -> forward: end only
    expect(frag('e1')).toContain('marker-end="url(#arrow)"');
    expect(frag('e1')).not.toContain('marker-start');
    // e2 is "both"
    expect(frag('e2')).toContain('marker-end="url(#arrow)"');
    expect(frag('e2')).toContain('marker-start="url(#arrow)"');
    // e3 is "none"
    expect(frag('e3')).not.toContain('marker-end');
    expect(frag('e3')).not.toContain('marker-start');
  });

  it('defines the §6.7 arrowhead marker exactly once, in the canvas defs', () => {
    expect(html.split('<marker').length - 1).toBe(1);
    const defs = html.slice(html.indexOf('<defs>'), html.indexOf('</defs>'));
    expect(defs).toContain('<marker');
    const m = renderToStaticMarkup(createElement(ArrowMarker, {}));
    expect(m).toContain('id="arrow"');
    expect(m).toContain('viewBox="0 0 10 10"');
    expect(m).toContain('refX="9"');
    expect(m).toContain('refY="5"');
    expect(m).toContain('markerWidth="7"');
    expect(m).toContain('markerHeight="7"');
    expect(m).toContain('orient="auto-start-reverse"');
    expect(m).toContain('d="M 0 0 L 10 5 L 0 10 z"');
    expect(m).toContain('fill="currentColor"');
  });
});

// --- §5.1 label truncation -------------------------------------------------

describe('node labels (§5.1)', () => {
  it('truncates with an ellipsis rather than wrapping', () => {
    const short = truncateToWidth('API', 200);
    expect(short).toBe('API');
    const long = truncateToWidth('A very long service label indeed', 60);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan('A very long service label indeed'.length);
  });

  it('renders the note as a second line in the secondary colour', () => {
    const html = markup();
    const content = html.slice(html.indexOf('data-node-content="api"'));
    const frag = content.slice(0, content.indexOf('data-node-content="db"'));
    expect(frag).toContain('API');
    expect(frag).toContain('edge');
    expect(frag).toContain(theme.text.secondary);
  });
});

// --- §9 rejected document: the status bar goes amber -----------------------

describe('StatusBar on a rejected graph.json (§9)', () => {
  const bar = (docError: { errors: string[]; at: number } | null): string =>
    renderToStaticMarkup(
      createElement(StatusBar, {
        title: 'Checkout platform',
        counts: { nodes: 11, groups: 2, edges: 9 },
        connection: 'connected' as const,
        lastUpdate: 1_000,
        docError,
      }),
    );

  it('shows no error treatment while the document is good', () => {
    const html = bar(null);
    expect(html).not.toContain('data-doc-error');
    expect(html).not.toContain(ERROR_COLOR);
    expect(html).toContain('last update');
  });

  it('turns amber and names the rejection instead of the stale timestamp', () => {
    const html = bar({ errors: ['nodes: expected array', 'edges: bad ref'], at: 5 });
    expect(html).toContain('data-doc-error="true"');
    // The amber is used, for both the border and the message.
    expect(html).toContain(ERROR_COLOR);
    expect(html).toContain('graph.json rejected');
    expect(html).toContain('(+1 more)');
    // "last update 5s ago" under a rejection is exactly the lie §9 forbids.
    expect(html).not.toContain('last update');
  });

  it('keeps the dot reporting the SOCKET, not the document', () => {
    // The connection is genuinely fine; only the document was rejected.
    const html = bar({ errors: ['bad'], at: 5 });
    expect(html).toContain('connected');
  });

  it('carries the full error list in the title for hovering', () => {
    const html = bar({ errors: ['first problem', 'second problem'], at: 5 });
    expect(html).toContain('first problem');
    expect(html).toContain('second problem');
  });
});
