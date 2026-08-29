// tests/erdRender.test.ts — ERD rendering, the hover panel and the
// seventh z-layer (spec Part 13 item 2; capability B).
//
// Same technique as render.test.ts: react-dom/server, assertions on the
// emitted markup, because document order IS paint order in SVG.
//
// The guard that matters most here is the LAST describe: an edge without a
// cardinality must still render byte-for-byte as it did before ERD mode
// existed. Those literals were captured from the pre-change component.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GEdge, GNode, GraphDoc } from '@diagram-engine/core';
import type { LaidOut } from '../src/layout/fromElk.js';
import { ENTITY, fieldRowWidth, sizeNode } from '../src/layout/measure.js';
import { Canvas } from '../src/render/Canvas.js';
import {
  ARROW_MARKER_ID,
  CrowManyMarker,
  CrowOneMarker,
  EdgePath,
  MANY_MARKER_ID,
  ONE_MARKER_ID,
  cardinalityMarkers,
} from '../src/render/EdgePath.js';
import { EntityBox, EntityContent } from '../src/render/EntityBox.js';
import { HoverCard, CARD_W, cardHeight, placeCard } from '../src/render/HoverCard.js';
import { NODE_ICONS } from '../src/render/icons.js';
import { theme } from '../src/render/theme.js';

// --- fixture ---------------------------------------------------------------

const customer: GNode = {
  id: 'customer',
  label: 'customer',
  type: 'entity',
  parent: null,
  fields: [
    { name: 'id', type: 'uuid', pk: true },
    { name: 'org_id', type: 'uuid', fk: true },
    { name: 'email', type: 'varchar(255)' },
    { name: 'deleted_at', type: 'timestamptz', nullable: true },
  ],
  meta: { owner: 'growth', sla: '99.9%' },
};

const orderEntity: GNode = {
  id: 'order',
  label: 'order',
  type: 'entity',
  parent: null,
  // No fields at all: must fall back to the plain §5.1 node box.
  meta: { owner: 'checkout' },
};

const doc: GraphDoc = {
  schemaVersion: 1,
  title: 'ERD fixture',
  direction: 'DOWN',
  groups: [{ id: 'core', label: 'Core', kind: 'generic', parent: null }],
  nodes: [customer, orderEntity, { id: 'api', label: 'API', type: 'service', parent: null }],
  edges: [
    { id: 'e11', from: 'customer', to: 'order', cardinality: '1:1' },
    { id: 'e1n', from: 'customer', to: 'order', cardinality: '1:N' },
    { id: 'en1', from: 'customer', to: 'order', cardinality: 'N:1' },
    { id: 'enm', from: 'customer', to: 'order', cardinality: 'N:M' },
    { id: 'plain', from: 'api', to: 'order' },
  ],
  collapsed: [],
};

const entityRect = {
  x: 20,
  y: 20,
  width: 240,
  height: ENTITY.headerH + 4 * ENTITY.rowH + ENTITY.padB,
};

const laidOut: LaidOut = {
  width: 600,
  height: 600,
  nodes: new Map([
    ['core', { x: 0, y: 0, width: 300, height: 300 }],
    ['customer', entityRect],
    ['order', { x: 320, y: 20, width: 160, height: 60 }],
    ['api', { x: 320, y: 200, width: 160, height: 60 }],
  ]),
  edges: doc.edges.map((e) => ({
    id: e.id,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
  })),
};

const paths = doc.edges.map(() => 'M 0 0 L 10 10');

function markup(extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(Canvas, { doc, laidOut, paths, ...extra } as never),
  );
}

function edgeFrag(html: string, id: string): string {
  const s = html.slice(html.indexOf(`data-edge="${id}"`));
  return s.slice(0, s.indexOf('>'));
}

// --- the entity table ------------------------------------------------------

describe('entity node (ERD)', () => {
  const html = renderToStaticMarkup(
    createElement('svg', null, [
      createElement(EntityBox, { key: 'b', node: customer, rect: entityRect }),
      createElement(EntityContent, { key: 'c', node: customer, rect: entityRect }),
    ]),
  );

  it('has its own accent colour and glyph', () => {
    expect(theme.accent.entity).toMatch(/^#[0-9A-F]{6}$/i);
    expect(NODE_ICONS.entity).toBeTypeOf('function');
    const icon = renderToStaticMarkup(createElement(NODE_ICONS.entity, {}));
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).toContain('width="20"');
  });

  it('keeps §8.2 box chrome: white fill, one accent path, no accent fill', () => {
    const frag = html.slice(html.indexOf('data-node="customer"'));
    const box = frag.slice(0, frag.indexOf('</g>'));
    expect(box).toContain(`fill="${theme.node.fill}"`);
    const accentPaths = (box.match(/<path\b[^>]*>/g) ?? []).filter((p) =>
      p.includes(theme.accent.entity),
    );
    expect(accentPaths).toHaveLength(1);
  });

  it('draws one row per field, in document order', () => {
    const order = ['id', 'org_id', 'email', 'deleted_at'];
    const positions = order.map((n) => html.indexOf(`data-field="customer:${n}"`));
    for (const [i, p] of positions.entries()) expect(p, order[i]).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect((html.match(/data-field="customer:/g) ?? []).length).toBe(4);
    // Rows sit below the header band, one ENTITY.rowH apart.
    expect(html).toContain(`data-entity-separator="customer"`);
  });

  it('renders each field type in the secondary text colour', () => {
    expect(html).toContain('varchar(255)');
    expect(html).toContain('timestamptz');
    expect(html).toContain(theme.text.secondary);
  });

  it('badges PK and FK rows, compactly and without accent colour', () => {
    const row = (name: string): string => {
      const s = html.slice(html.indexOf(`data-field="customer:${name}"`));
      return s.slice(0, s.indexOf('data-field="') > 0 ? s.indexOf('data-field="') : s.length);
    };
    expect(row('id')).toContain('data-badge="PK"');
    expect(row('org_id')).toContain('data-badge="FK"');
    expect(row('email')).not.toContain('data-badge');
    // Muted chrome only — badges never carry the type accent.
    const badges = html.slice(html.indexOf('data-badge="PK"'));
    expect(badges.slice(0, 200)).not.toContain(theme.accent.entity);
  });

  it('marks a nullable field and lightens its name', () => {
    const s = html.slice(html.indexOf('data-field="customer:deleted_at"'));
    const row = s.slice(0, s.indexOf('</g>') + 4);
    expect(row).toContain('data-nullable="true"');
    expect(row).toContain(theme.text.secondary);
    const notNull = html.slice(html.indexOf('data-field="customer:email"'));
    expect(notNull.slice(0, notNull.indexOf('</g>'))).not.toContain('data-nullable');
  });

  it('truncates a long field row with an ellipsis rather than wrapping', () => {
    const wide: GNode = {
      ...customer,
      id: 'wide',
      fields: [
        {
          name: 'an_extremely_long_column_name_that_cannot_possibly_fit',
          type: 'character varying',
        },
      ],
    };
    const narrow = { x: 0, y: 0, width: 150, height: ENTITY.headerH + ENTITY.rowH + ENTITY.padB };
    const out = renderToStaticMarkup(
      createElement(EntityContent, { node: wide, rect: narrow }),
    );
    // The DRAWN name is an ellipsised prefix; the full name survives only
    // in the data attribute (and in the hover card).
    const drawn = /<text\b[^>]*>([^<]*)<\/text>/.exec(
      out.slice(out.indexOf('data-field="wide:')),
    )?.[1];
    expect(drawn).toBeTruthy();
    expect(drawn!.endsWith('…')).toBe(true);
    expect(drawn!.length).toBeLessThan(wide.fields![0]!.name.length);
    expect(out).not.toContain(`>${wide.fields![0]!.name}<`);
  });

  it('falls back to the plain node box when the entity has no fields', () => {
    const html2 = markup();
    const frag = html2.slice(html2.indexOf('data-node="order"'));
    expect(frag.slice(0, frag.indexOf('</g>'))).not.toContain('data-entity="true"');
    expect(html2).not.toContain('data-field="order:');
    // And the entity WITH fields did take the table path.
    const ent = html2.slice(html2.indexOf('data-node="customer"'));
    expect(ent.slice(0, ent.indexOf('</g>'))).toContain('data-entity="true"');
  });
});

// --- sizing vs. drawing ----------------------------------------------------
//
// The bug this guards: sizeNode() and FieldRow disagreed about how wide a
// row is, so a box "sized to fit" still ellipsised its own field names.
// Only a test that RENDERS at the SIZED rect can see that, which is why it
// lives here and not in entitySizing.test.ts.

describe('an entity box is wide enough for what it draws', () => {
  const demanding: GNode = {
    id: 'join',
    label: 'x', // deliberately tiny: the rows, not the header, set the width
    type: 'entity',
    parent: null,
    fields: [
      // The normal join-table row: a composite key carrying BOTH badges.
      { name: 'order_reference_id', type: 'uuid', pk: true, fk: true },
      { name: 'subscription_item_id', type: 'bigint', pk: true },
      { name: 'created_at', type: 'timestamptz' },
      // A note is hover-panel detail, never drawn on the row.
      { name: 'email', type: 'citext', note: 'unique, lowercased on write' },
      { name: 'id' }, // no type, no badges
    ],
  };

  const size = sizeNode(demanding);
  const rect = { x: 0, y: 0, ...size };
  const out = renderToStaticMarkup(
    createElement('svg', null, [
      createElement(EntityContent, { key: 'c', node: demanding, rect }),
    ]),
  );

  it('never truncates a row that fits under the maximum width', () => {
    for (const f of demanding.fields!) {
      expect(fieldRowWidth(f)).toBeLessThanOrEqual(ENTITY.maxW);
      expect(out).toContain(`>${f.name}<`);
      if (f.type !== undefined) expect(out).toContain(`>${f.type}<`);
    }
    expect(out).not.toContain('…');
  });

  it('wastes no width on a note it does not draw', () => {
    expect(out).not.toContain('lowercased on write');
    const withoutNote: GNode = {
      ...demanding,
      fields: demanding.fields!.map(({ note: _note, ...f }) => f),
    };
    expect(sizeNode(withoutNote)).toEqual(size);
  });
});

// --- crow's-foot markers ---------------------------------------------------

describe("crow's-foot markers (ERD)", () => {
  const html = markup();

  it('defines both markers once, in the canvas defs, beside the arrow', () => {
    const defs = html.slice(html.indexOf('<defs>'), html.indexOf('</defs>'));
    expect(defs).toContain(`id="${ARROW_MARKER_ID}"`);
    expect(defs).toContain(`id="${ONE_MARKER_ID}"`);
    expect(defs).toContain(`id="${MANY_MARKER_ID}"`);
    expect((html.match(new RegExp(`id="${ONE_MARKER_ID}"`, 'g')) ?? []).length).toBe(1);
    expect((html.match(new RegExp(`id="${MANY_MARKER_ID}"`, 'g')) ?? []).length).toBe(1);
  });

  it('orients both markers for either end of a path', () => {
    for (const M of [CrowOneMarker, CrowManyMarker]) {
      const m = renderToStaticMarkup(createElement(M, {}));
      expect(m).toContain('orient="auto-start-reverse"');
      expect(m).toContain('stroke="currentColor"');
      expect(m).toContain('fill="none"');
      expect(m).toContain('viewBox="0 0 10 10"');
    }
    // The "many" foot really has three prongs converging on one point.
    const many = renderToStaticMarkup(createElement(CrowManyMarker, {}));
    expect(many).toContain('M 9 1 L 1 5 L 9 9 M 1 5 L 9 5');
    // The "one" marker is a single perpendicular bar.
    expect(renderToStaticMarkup(createElement(CrowOneMarker, {}))).toContain('M 5 1 L 5 9');
  });

  it('maps every cardinality to the right marker at the right end', () => {
    expect(cardinalityMarkers('1:1')).toEqual({ start: ONE_MARKER_ID, end: ONE_MARKER_ID });
    expect(cardinalityMarkers('1:N')).toEqual({ start: ONE_MARKER_ID, end: MANY_MARKER_ID });
    expect(cardinalityMarkers('N:1')).toEqual({ start: MANY_MARKER_ID, end: ONE_MARKER_ID });
    expect(cardinalityMarkers('N:M')).toEqual({ start: MANY_MARKER_ID, end: MANY_MARKER_ID });

    const cases: [string, string, string][] = [
      ['e11', ONE_MARKER_ID, ONE_MARKER_ID],
      ['e1n', ONE_MARKER_ID, MANY_MARKER_ID],
      ['en1', MANY_MARKER_ID, ONE_MARKER_ID],
      ['enm', MANY_MARKER_ID, MANY_MARKER_ID],
    ];
    for (const [id, start, end] of cases) {
      const frag = edgeFrag(html, id);
      expect(frag, id).toContain(`marker-start="url(#${start})"`);
      expect(frag, id).toContain(`marker-end="url(#${end})"`);
    }
  });

  it('replaces the arrowhead — a relationship is not a directed call', () => {
    for (const id of ['e11', 'e1n', 'en1', 'enm']) {
      expect(edgeFrag(html, id), id).not.toContain(`url(#${ARROW_MARKER_ID})`);
    }
    // Cardinality beats an explicit arrow field too.
    const frag = renderToStaticMarkup(
      createElement(EdgePath, {
        edge: { id: 'x', from: 'a', to: 'b', arrow: 'both', cardinality: '1:N' } as GEdge,
        d: 'M 0 0 L 10 10',
      }),
    );
    expect(frag).not.toContain(`url(#${ARROW_MARKER_ID})`);
    expect(frag).toContain(`marker-start="url(#${ONE_MARKER_ID})"`);
    expect(frag).toContain(`marker-end="url(#${MANY_MARKER_ID})"`);
  });
});

// --- regression guard: non-ERD edges are untouched --------------------------

describe('edges without a cardinality (regression guard)', () => {
  const render = (edge: GEdge): string =>
    renderToStaticMarkup(createElement(EdgePath, { edge, d: 'M 0 0 L 10 10' }));

  it('emits byte-identical markup to the pre-ERD renderer', () => {
    expect(render({ id: 'e1', from: 'a', to: 'b' })).toBe(
      '<path data-edge="e1" data-layer="edge-path" d="M 0 0 L 10 10" fill="none" stroke="#8A8880" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)" style="color:#8A8880"></path>',
    );
    expect(
      render({ id: 'e2', from: 'a', to: 'b', arrow: 'both', style: 'dashed', label: 'x' }),
    ).toBe(
      '<path data-edge="e2" data-layer="edge-path" d="M 0 0 L 10 10" fill="none" stroke="#8A8880" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="6 4" marker-start="url(#arrow)" marker-end="url(#arrow)" style="color:#8A8880"></path>',
    );
    expect(render({ id: 'e3', from: 'a', to: 'b', arrow: 'none' })).toBe(
      '<path data-edge="e3" data-layer="edge-path" d="M 0 0 L 10 10" fill="none" stroke="#8A8880" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:#8A8880"></path>',
    );
  });

  it('carries no data-cardinality attribute at all', () => {
    expect(render({ id: 'e1', from: 'a', to: 'b' })).not.toContain('data-cardinality');
    expect(edgeFrag(markup(), 'e11')).toContain('data-cardinality="1:1"');
  });
});

// --- the hover panel (capability B) ----------------------------------------

describe('HoverCard', () => {
  const card = (node: GNode, x = 10, y = 10, vw = 1200, vh = 800): string =>
    renderToStaticMarkup(createElement(HoverCard, { node, x, y, vw, vh }));

  it('shows the label, the type, the note and every meta pair', () => {
    const html = card({ ...customer, note: 'billing owner of record' });
    expect(html).toContain('customer');
    expect(html).toContain('entity');
    expect(html).toContain('billing owner of record');
    expect(html).toContain('data-meta-key="owner"');
    expect(html).toContain('growth');
    expect(html).toContain('data-meta-key="sla"');
    expect(html).toContain('99.9%');
  });

  it('lists the FULL field list, including what the box truncated', () => {
    const html = card(customer);
    for (const f of customer.fields!) {
      expect(html, f.name).toContain(`data-hover-field="${f.name}"`);
    }
    expect(html).toContain('4 fields');
    expect(html).toContain('nullable');
    expect(html).toContain('PK');
    expect(html).toContain('FK');
  });

  it('works on a plain node with meta and no fields', () => {
    const html = card({ id: 'api', label: 'API', type: 'service', parent: null, meta: { team: 'core' } });
    expect(html).toContain('data-meta-key="team"');
    expect(html).not.toContain('data-hover-fields');
  });

  it('never intercepts the pointer and never offers a mutation', () => {
    const html = card(customer);
    expect(html).toContain('pointer-events:none');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
  });

  it('flips near the right and bottom edges so it stays on screen', () => {
    const h = cardHeight(customer);
    const near = placeCard(50, 50, 1200, 800, h);
    expect(near.flippedX).toBe(false);
    expect(near.flippedY).toBe(false);
    expect(near.left).toBeGreaterThan(50);

    const right = placeCard(1180, 50, 1200, 800, h);
    expect(right.flippedX).toBe(true);
    expect(right.left + CARD_W).toBeLessThanOrEqual(1200);

    const bottom = placeCard(50, 790, 1200, 800, h);
    expect(bottom.flippedY).toBe(true);
    expect(bottom.top).toBeGreaterThanOrEqual(0);
    expect(bottom.top + Math.min(h, bottom.maxHeight)).toBeLessThanOrEqual(800);

    const corner = placeCard(1195, 795, 1200, 800, h);
    expect(corner.flippedX && corner.flippedY).toBe(true);
    expect(corner.left).toBeGreaterThanOrEqual(0);
    expect(corner.top).toBeGreaterThanOrEqual(0);

    // Even a container smaller than the card keeps it on screen.
    const tiny = placeCard(5, 5, 200, 120, h);
    expect(tiny.left).toBeGreaterThanOrEqual(0);
    expect(tiny.top).toBeGreaterThanOrEqual(0);
    expect(tiny.maxHeight).toBeLessThanOrEqual(120);
  });

  it('marks the flip in the markup for the parent to key off', () => {
    expect(card(customer, 1195, 795)).toContain('data-flipped-x="true"');
  });
});

// --- §8.1 z-order, with the hover layer on top ------------------------------

describe('z-order with the hover layer (§8.1 + 7)', () => {
  it('keeps the six layers in order and puts hover last', () => {
    const html = markup({ hoveredId: 'customer' });
    const at = (marker: string): number => {
      const i = html.indexOf(marker);
      expect(i, marker).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at('data-layer="group-rect"'),
      at('data-layer="group-label"'),
      at('data-layer="edge-path"'),
      at('data-layer="node-box"'),
      at('data-layer="node-content"'),
      at('data-layer="hover"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('data-hover-ring="customer"');
    expect(html.slice(html.indexOf('data-layer="hover"'))).toContain('pointer-events="none"');
  });

  it('emits no hover layer at all when nothing is hovered', () => {
    expect(markup()).not.toContain('data-layer="hover"');
    expect(markup({ hoveredId: null })).not.toContain('data-layer="hover"');
    // An unknown id is ignored rather than throwing.
    expect(markup({ hoveredId: 'nope' })).not.toContain('data-layer="hover"');
  });

  it('renders the parent-supplied hover overlay inside the hover layer', () => {
    const html = markup({
      hoveredId: 'customer',
      hoverOverlay: createElement('circle', { 'data-probe': 'true', r: 3 }),
    });
    expect(html.indexOf('data-probe')).toBeGreaterThan(html.indexOf('data-layer="hover"'));
  });

  it('adds no markup when hover handlers are supplied (events do not serialise)', () => {
    expect(markup({ onHoverNode: () => undefined })).toBe(markup());
  });
});
