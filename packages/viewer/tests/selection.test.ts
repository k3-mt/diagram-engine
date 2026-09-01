// tests/selection.test.ts — §8.7: click a node, see everything about it, and
// watch its connections light up. Plus §3.9's other half of the fix for the
// hover card, which used to clip every value it could not fit.
//
// Rendered with react-dom/server like tests/sidebar.test.ts — no DOM and no
// click simulation: the model is a pure function and the panel is pure
// markup, so both are driven directly.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GNode, GraphDoc } from '@diagram-engine/core';
import { DetailPanel, connectionVerb } from '../src/render/DetailPanel.js';
import { HoverCard, CARD_W, cardHeight, wrappedLines } from '../src/render/HoverCard.js';
import { SelectionOverlay, DIMMED, litEdges } from '../src/render/SelectionOverlay.js';
import { theme } from '../src/render/theme.js';
import { FrameLayers } from '../src/render/Canvas.js';
import { selectionView } from '../src/view/selection.js';
import { deriveViewDetail } from '../../core/src/view/derive.js';
import type { LaidOut } from '../src/layout/fromElk.js';

const doc: GraphDoc = {
  schemaVersion: 1,
  title: 'Checkout',
  direction: 'DOWN',
  nodes: [
    { id: 'web', label: 'Web', type: 'client', parent: null },
    { id: 'orders', label: 'Orders', type: 'service', parent: null },
    { id: 'postgres', label: 'Postgres', type: 'database', parent: null },
    { id: 'events', label: 'Events', type: 'queue', parent: null },
    { id: 'lonely', label: 'Lonely', type: 'service', parent: null },
  ],
  groups: [{ id: 'vpc', label: 'Private VPC', kind: 'vpc', parent: null }],
  edges: [
    { id: 'e1', from: 'web', to: 'orders', kind: 'call', returns: '200 OK', seq: 1 },
    { id: 'e2', from: 'orders', to: 'postgres', kind: 'read', returns: 'order[]', seq: 2 },
    { id: 'e3', from: 'orders', to: 'events', kind: 'publish', seq: 3 },
    { id: 'e4', from: 'orders', to: 'vpc', label: 'egress' },
  ],
  collapsed: [],
};

const rect = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

const laidOut: LaidOut = {
  width: 600,
  height: 600,
  nodes: new Map([
    ['web', rect(0, 0)],
    ['orders', rect(0, 100)],
    ['postgres', rect(0, 200)],
    ['events', rect(200, 200)],
    ['lonely', rect(400, 400)],
    ['vpc', rect(300, 300)],
  ]),
  edges: [
    { id: 'e1', points: [{ x: 50, y: 40 }, { x: 50, y: 100 }] },
    { id: 'e2', points: [{ x: 50, y: 140 }, { x: 50, y: 200 }] },
    { id: 'e3', points: [{ x: 50, y: 140 }, { x: 250, y: 200 }] },
    { id: 'e4', points: [{ x: 50, y: 140 }, { x: 350, y: 300 }] },
  ],
};

const paths = ['M 50 40 L 50 100', 'M 50 140 L 50 200', 'M 50 140 L 250 200', 'M 50 140 L 350 300'];

describe('selectionView — the model both surfaces read', () => {
  it('splits the edges by which way they run', () => {
    const s = selectionView(doc, 'orders')!;
    expect(s.outgoing.map((c) => c.edge.id)).toEqual(['e2', 'e3', 'e4']);
    expect(s.incoming.map((c) => c.edge.id)).toEqual(['e1']);
  });

  it('names the far end, and says when it is a group', () => {
    const s = selectionView(doc, 'orders')!;
    expect(s.outgoing.map((c) => c.otherLabel)).toEqual([
      'Postgres',
      'Events',
      'Private VPC',
    ]);
    // §3.1 lets an edge point at a group, so the panel has to be able to say
    // so rather than reporting a group as though it were a component.
    expect(s.outgoing.find((c) => c.otherId === 'vpc')?.otherIsGroup).toBe(true);
    expect(s.outgoing.find((c) => c.otherId === 'postgres')?.otherIsGroup).toBe(false);
  });

  it('collects exactly the ids the overlay lights up', () => {
    const s = selectionView(doc, 'orders')!;
    expect([...s.edgeIds].sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    // The node itself is in the set: it must not be dimmed alongside the
    // boxes it is not connected to.
    expect(s.nodeIds.has('orders')).toBe(true);
    expect([...s.nodeIds].sort()).toEqual(['events', 'orders', 'postgres', 'vpc', 'web']);
    expect(s.nodeIds.has('lonely')).toBe(false);
  });

  it('answers a node with no edges at all', () => {
    const s = selectionView(doc, 'lonely')!;
    expect(s.outgoing).toEqual([]);
    expect(s.incoming).toEqual([]);
    expect([...s.nodeIds]).toEqual(['lonely']);
  });

  it('answers NULL for an id the document no longer has', () => {
    // This is what closes the panel by itself when an agent removes the
    // selected node: there is no stale id left to clean up.
    expect(selectionView(doc, 'gone')).toBe(null);
    // And for a GROUP id — a group is not a node and has no detail panel.
    expect(selectionView(doc, 'vpc')).toBe(null);
  });

  it('falls back to the bare id when nothing carries the label', () => {
    const orphan: GraphDoc = {
      ...doc,
      edges: [{ id: 'x', from: 'orders', to: 'hidden-thing' }],
    };
    expect(selectionView(orphan, 'orders')!.outgoing[0]!.otherLabel).toBe('hidden-thing');
  });
});

describe('connectionVerb — always the ACTIVE voice', () => {
  it('gives one verb per kind, with the edge\'s `from` end as the subject', () => {
    const s = selectionView(doc, 'orders')!;
    expect(connectionVerb(s.outgoing.find((c) => c.otherId === 'postgres')!)).toBe(
      'reads from',
    );
    // The SAME verb from the other end. The row puts the words in document
    // order instead of conjugating — see the ordering tests below.
    expect(connectionVerb(s.incoming[0]!)).toBe('calls');
  });

  it('uses the author label verbatim, in either direction', () => {
    // The bug this replaced: an incoming edge with no kind fell back to a
    // PASSIVE lookup that did not exist, so the row rendered the raw label as
    // though the selected node were the actor.
    const s = selectionView(doc, 'orders')!;
    expect(connectionVerb(s.outgoing.find((c) => c.otherId === 'vpc')!)).toBe('egress');
  });

  it('has something to say for a bare edge', () => {
    const bare: GraphDoc = { ...doc, edges: [{ id: 'x', from: 'orders', to: 'postgres' }] };
    expect(connectionVerb(selectionView(bare, 'orders')!.outgoing[0]!)).toBe('connects to');
    expect(connectionVerb(selectionView(bare, 'postgres')!.incoming[0]!)).toBe('connects to');
  });
});

// The regression that prompted all of this. `OpenTofu --creates--> Backup
// bucket` is a correct document; the bucket's panel rendered it as "creates
// OpenTofu", a sentence asserting the exact opposite. Word order is what
// fixes it, so word order is what is pinned.
describe('a row reads in document order', () => {
  const provisioned: GraphDoc = {
    ...doc,
    nodes: [
      { id: 'opentofu', label: 'OpenTofu', type: 'service', parent: null },
      { id: 'bucket', label: 'Backup bucket', type: 'storage', parent: null },
    ],
    groups: [],
    edges: [{ id: 'mk', from: 'opentofu', to: 'bucket', label: 'creates' }],
  };
  const panel = (id: string): string =>
    renderToStaticMarkup(
      createElement(DetailPanel, {
        selection: selectionView(provisioned, id)!,
        onSelect: () => {},
        onClose: () => {},
      }),
    );

  /**
   * Position of a piece of RENDERED TEXT, not of an attribute value. The
   * button carries `title="Go to Backup bucket"`, so a naive indexOf finds
   * the node name before the row has even begun.
   */
  const textAt = (html: string, text: string): number => {
    const row = html.slice(html.indexOf('data-connection="mk"'));
    const i = row.indexOf(`>${text}<`);
    expect(i, `rendered text ${text}`).toBeGreaterThan(-1);
    return i;
  };

  it('puts the OTHER node before the verb on an incoming row', () => {
    // Reads "OpenTofu creates", never "creates OpenTofu".
    const row = panel('bucket');
    expect(textAt(row, 'OpenTofu')).toBeLessThan(textAt(row, 'creates'));
  });

  it('puts the verb before the other node on an outgoing row', () => {
    // Reads "creates Backup bucket".
    const row = panel('opentofu');
    expect(textAt(row, 'creates')).toBeLessThan(textAt(row, 'Backup bucket'));
  });

  it('states the direction with an arrow, not only with a colour', () => {
    // A 3px colour bar is not something a reader should have to decode, and
    // a colour-blind one cannot.
    expect(panel('bucket')).toContain('\u2190');
    expect(panel('opentofu')).toContain('\u2192');
  });
});

describe('DetailPanel', () => {
  const html = (id: string): string =>
    renderToStaticMarkup(
      createElement(DetailPanel, {
        selection: selectionView(doc, id)!,
        onSelect: () => {},
        onClose: () => {},
      }),
    );

  it('shows the node and both directions, counted', () => {
    const out = html('orders');
    expect(out).toContain('Orders');
    expect(out).toContain('Depends on');
    expect(out).toContain('Depended on by');
    expect(out).toContain('data-testid="detail-outgoing"');
    expect(out).toContain('data-testid="detail-incoming"');
  });

  it('makes every connection a way to walk to the other end', () => {
    const out = html('orders');
    for (const id of ['e1', 'e2', 'e3', 'e4']) expect(out).toContain(`data-connection="${id}"`);
    expect(out).toContain('data-direction="out"');
    expect(out).toContain('data-direction="in"');
  });

  it('spells out the return leg the canvas can only draw', () => {
    // "…and something comes back" is the fact the old single-arrow picture
    // could not state at all, so the panel states it in words.
    const out = html('orders');
    expect(out).toContain('data-connection-return="e2"');
    expect(out).toContain('order[]');
    // The publish edge has no return: nothing comes back off a fire-and-forget.
    expect(out).not.toContain('data-connection-return="e3"');
  });

  it('marks the asynchronous edge as async', () => {
    expect(html('orders')).toContain('async');
  });

  it('carries the step numbers', () => {
    const out = html('orders');
    expect(out).toContain('data-connection-seq="2"');
    expect(out).toContain('data-connection-seq="3"');
  });

  it('says so plainly when a node is connected to nothing', () => {
    const out = html('lonely');
    expect(out).toContain('No edge leaves this component.');
    expect(out).toContain('No edge arrives here.');
  });

  it('never clips a long value', () => {
    // The whole point of the panel. A node whose meta or fields are long must
    // show them in full — an ellipsis here answers "tell me everything about
    // this box" with a lie of omission.
    const long: GraphDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === 'orders'
          ? {
              ...n,
              meta: {
                image: 'registry.example.com/platform/orders-api:sha-9f2c1ab4e7d0',
              },
            }
          : n,
      ),
    };
    const out = renderToStaticMarkup(
      createElement(DetailPanel, {
        selection: selectionView(long, 'orders')!,
        onSelect: () => {},
        onClose: () => {},
      }),
    );
    expect(out).toContain('registry.example.com/platform/orders-api:sha-9f2c1ab4e7d0');
    expect(out).not.toContain('text-overflow:ellipsis');
  });
});

describe('SelectionOverlay — rings only', () => {
  const html = (id: string): string =>
    renderToStaticMarkup(
      createElement(SelectionOverlay, {
        selection: selectionView(doc, id)!,
        laidOut,
      }),
    );

  it('rings the selected box and every far end', () => {
    const out = html('orders');
    expect(out).toContain('data-selection="selected"');
    expect(out).toContain('data-selection-ring="orders"');
    expect(out).toContain('data-selection-ring="postgres"');
    expect(out).toContain('data-selection="neighbour"');
    // The unconnected box gets no ring: it is context, not a connection.
    expect(out).not.toContain('data-selection-ring="lonely"');
  });

  it('draws no edge strokes and needs no mask', () => {
    // The correction that matters. The first version painted a heavy stroke
    // per connection HERE, in layer 7 — above the edge labels and above each
    // edge's own step badge, so the highlight was drawn straight through the
    // number and the words on the line it was highlighting. The edges now
    // light themselves in layer 3, which gets the z-order right by
    // construction; nothing here draws a path, and the mask is gone.
    const out = html('orders');
    expect(out).not.toContain('<path');
    expect(out).not.toContain('<mask');
    expect(out).not.toContain('data-selection-edge');
  });

  it('still rings a node connected to nothing', () => {
    const out = html('lonely');
    expect(out).toContain('data-selection="selected"');
    expect(out).not.toContain('data-selection="neighbour"');
  });
});

describe('litEdges — the colour map both surfaces read', () => {
  it('gives outgoing the node accent and incoming ink', () => {
    const s = selectionView(doc, 'orders')!;
    const lit = litEdges(s, theme.accent.service);
    expect(lit.get('e2')).toBe(theme.accent.service); // orders -> postgres
    expect(lit.get('e1')).toBe(theme.text.primary); // web -> orders
  });

  it('covers exactly the selected node\'s edges', () => {
    const s = selectionView(doc, 'orders')!;
    expect(new Set(litEdges(s, '#000').keys())).toEqual(s.edgeIds);
  });

  it('is empty for a node with no edges', () => {
    expect(litEdges(selectionView(doc, 'lonely')!, '#000').size).toBe(0);
  });
});

describe('emphasis — the dimming that makes the lit lines findable', () => {
  const frame = (emphasis: Parameters<typeof FrameLayers>[0]['emphasis']): string =>
    renderToStaticMarkup(
      createElement(FrameLayers, { doc, laidOut, paths, emphasis }),
    );

  it('draws the lit edges IN the edges layer, under the labels', () => {
    // The fix for the strike-through: a lit connection is the edge itself
    // drawn heavy, in layer 3, so the edge label and the step badge paint
    // over it exactly as they always do.
    const s = selectionView(doc, 'orders')!;
    const out = frame({
      nodes: s.nodeIds,
      edges: litEdges(s, theme.accent.service),
      dim: DIMMED,
    });
    const layer = out.slice(out.indexOf('data-layer="edges"'), out.indexOf('data-layer="edge-labels"'));
    expect(layer).toContain('data-lit="true"');
    expect(layer).toContain(theme.accent.service);
  });

  it('changes NOTHING when no emphasis is set', () => {
    // The compatibility guarantee: the un-emphasised frame is what every
    // exported SVG and every existing render test looks at.
    expect(frame(null)).toBe(frame(undefined));
    expect(frame(null)).not.toContain('opacity="0.16"');
  });

  it('fades what is outside the sets and leaves what is inside alone', () => {
    const s = selectionView(doc, 'orders')!;
    const out = frame({
      nodes: s.nodeIds,
      edges: litEdges(s, theme.accent.service),
      dim: DIMMED,
    });
    // 'lonely' is connected to nothing selected, so it recedes...
    expect(out).toContain(`opacity="${DIMMED}"`);
    // ...and the lit set is not wrapped in a fading group at all.
    const lit = out.slice(out.indexOf('data-node="orders"') - 200, out.indexOf('data-node="orders"'));
    expect(lit).not.toContain(`opacity="${DIMMED}"`);
  });

  it('never dims a container', () => {
    // A boundary answers "where does this live", which is exactly what the
    // reader is asking when they click a box.
    const s = selectionView(doc, 'lonely')!;
    const out = frame({
      nodes: s.nodeIds,
      edges: litEdges(s, theme.accent.service),
      dim: DIMMED,
    });
    const groups = out.slice(out.indexOf('data-layer="groups"'), out.indexOf('data-layer="group-labels"'));
    expect(groups).not.toContain('opacity');
  });
});

describe('the hover card no longer clips', () => {
  const node = (over: Partial<GNode> = {}): GNode => ({
    id: 'orders',
    label: 'Orders',
    type: 'service',
    parent: null,
    ...over,
  });

  const card = (n: GNode): string =>
    renderToStaticMarkup(
      createElement(HoverCard, { node: n, x: 10, y: 10, vw: 1200, vh: 800 }),
    );

  it('drops every ellipsis and every nowrap', () => {
    // The bug: a meta value, a field annotation or a repo path longer than
    // the card was cut off at `overflow: hidden`, and the reader could not
    // tell a whole value from a prefix.
    const out = card(
      node({
        meta: { image: 'registry.example.com/platform/orders-api:sha-9f2c1ab4e7d0' },
        bindings: [{ source: 'repo', ref: 'services/orders/internal/handler/checkout.go', line: 412 }],
      }),
    );
    expect(out).not.toContain('text-overflow:ellipsis');
    expect(out).not.toContain('white-space:nowrap');
    expect(out).toContain('overflow-wrap:anywhere');
    // In full, both of them.
    expect(out).toContain('registry.example.com/platform/orders-api:sha-9f2c1ab4e7d0');
    expect(out).toContain('services/orders/internal/handler/checkout.go:412');
  });

  it('counts a wrapped row at the height it actually takes', () => {
    // The flip math is a pure function with no measurement, so it estimates —
    // but an estimate of one line for a value that wraps to five puts the
    // card off the bottom of the container.
    const short = cardHeight(node({ meta: { owner: 'payments' } }));
    const long = cardHeight(
      node({ meta: { owner: 'the payments platform team, on call via #pay-oncall, escalating to the on-call lead' } }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it('estimates lines from the width it has', () => {
    expect(wrappedLines('short', 200)).toBe(1);
    expect(wrappedLines('x'.repeat(200), 200)).toBeGreaterThan(4);
    // Never zero, whatever it is handed — a zero-line row would collapse the
    // height estimate for a row that is on the screen.
    expect(wrappedLines('', 200)).toBe(1);
    expect(wrappedLines('abc', 0)).toBeGreaterThanOrEqual(1);
  });

  it('is wide enough to be worth wrapping into', () => {
    expect(CARD_W).toBeGreaterThanOrEqual(300);
  });
});


// The subtle half of §8.7. deriveView merges every edge sharing a (from, to)
// pair into ONE drawn line — with nothing collapsed at all — so the canvas
// shows one grey `×2` line where the document holds a read AND a write. The
// canvas is right; a panel that showed one row would not be, because the
// reader clicked to be told everything about the node.
describe('a merged edge, expanded back into what it stands for', () => {
  const both: GraphDoc = {
    ...doc,
    edges: [
      { id: 'r', from: 'orders', to: 'postgres', kind: 'read', returns: 'order[]' },
      { id: 'w', from: 'orders', to: 'postgres', kind: 'write', label: 'writes' },
    ],
  };
  const detail = deriveViewDetail(both, []);

  it('is ONE line on the canvas', () => {
    // Not the thing under test — the premise. If deriveView ever stopped
    // merging, the expansion below would be pointless rather than wrong.
    expect(detail.doc.edges).toHaveLength(1);
    expect(detail.doc.edges[0]!.label).toBe('×2');
    // And the merged line carries no kind, because the two disagree.
    expect(detail.doc.edges[0]!.kind).toBeUndefined();
  });

  it('reports ONE row per authored edge, with its kind intact', () => {
    const s = selectionView(detail.doc, 'orders', {
      source: both,
      merges: detail.edges,
    })!;
    expect(s.outgoing).toHaveLength(2);
    expect(s.outgoing.map((c) => c.edge.kind)).toEqual(['read', 'write']);
    // The payload survives on the row it belongs to, and only that row.
    expect(s.outgoing[0]!.edge.returns).toBe('order[]');
    expect(s.outgoing[1]!.edge.returns).toBeUndefined();
  });

  it('points both rows at the ONE line the overlay lights up', () => {
    const s = selectionView(detail.doc, 'orders', {
      source: both,
      merges: detail.edges,
    })!;
    expect(new Set(s.outgoing.map((c) => c.drawnId)).size).toBe(1);
    // So the overlay still lights one line, not two, and the panel and the
    // canvas cannot disagree about what is selected.
    expect(s.edgeIds.size).toBe(1);
  });

  it('falls back to the drawn document when given no source', () => {
    // The pre-§8.7 behaviour, intact: one drawn edge, one row.
    const s = selectionView(detail.doc, 'orders')!;
    expect(s.outgoing).toHaveLength(1);
    expect(s.outgoing[0]!.drawnId).toBe(s.outgoing[0]!.edge.id);
  });

  it('names where an edge really lands when a collapse has moved it', () => {
    const nested: GraphDoc = {
      schemaVersion: 1,
      title: 'T',
      direction: 'DOWN',
      nodes: [
        { id: 'web', label: 'Web', type: 'client', parent: null },
        { id: 'orders', label: 'Orders', type: 'service', parent: 'vpc' },
        { id: 'billing', label: 'Billing', type: 'service', parent: 'vpc' },
      ],
      groups: [{ id: 'vpc', label: 'Private VPC', kind: 'vpc', parent: null }],
      edges: [
        { id: 'a', from: 'web', to: 'orders', kind: 'call' },
        { id: 'b', from: 'web', to: 'billing', kind: 'call' },
      ],
      collapsed: [],
    };
    const d = deriveViewDetail(nested, ['vpc']);
    const s = selectionView(d.doc, 'web', { source: nested, merges: d.edges })!;
    // Two rows, both drawn as the one line into the collapsed boundary...
    expect(s.outgoing).toHaveLength(2);
    expect(s.outgoing.every((c) => c.otherLabel === 'Private VPC')).toBe(true);
    // ...distinguishable only because each says what is really at its far
    // end. Without that they are two identical "calls Private VPC" rows.
    expect(s.outgoing.map((c) => c.insideLabel)).toEqual(['Orders', 'Billing']);
    // Clicking selects the DRAWN box: the authored one is not on the canvas.
    expect(s.outgoing.every((c) => c.otherId === 'vpc')).toBe(true);
  });

  it('sets no insideLabel when nothing moved', () => {
    const s = selectionView(detail.doc, 'orders', {
      source: both,
      merges: detail.edges,
    })!;
    expect(s.outgoing.every((c) => c.insideLabel === undefined)).toBe(true);
  });

  it('shows both rows in the panel', () => {
    const s = selectionView(detail.doc, 'orders', {
      source: both,
      merges: detail.edges,
    })!;
    const out = renderToStaticMarkup(
      createElement(DetailPanel, { selection: s, onSelect: () => {}, onClose: () => {} }),
    );
    expect(out).toContain('reads from');
    expect(out).toContain('writes to');
    expect(out).toContain('order[]');
  });
});
