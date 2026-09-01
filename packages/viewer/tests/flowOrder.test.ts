// tests/flowOrder.test.ts — §5.5: the diagram reads beginning-to-end.
//
// ELK ranks a node by the direction of the edges touching it, and an edge's
// document direction is its DEPENDENCY direction (rule 4). Those two agree
// for most of a system and disagree for a PULL — which is why a pipeline that
// fetches from external sources drew those sources at the BOTTOM, after
// everything they feed.
//
// Both halves of the fix are pinned here, and the second matters as much as
// the first: the rule must lift data entering from outside WITHOUT disturbing
// the single most common edge in any architecture diagram, a service reading
// its own database.

import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { GraphDoc } from '@diagram-engine/core';
import { flowReversedEdgeIds, OUTSIDE_TYPES } from '../src/layout/flow.js';
import { toElk } from '../src/layout/toElk.js';
import { flatten } from '../src/layout/fromElk.js';
import { layout } from '../src/layout/runLayout.js';

const doc = (over: Partial<GraphDoc> = {}): GraphDoc => ({
  schemaVersion: 1,
  title: 'T',
  direction: 'DOWN',
  nodes: [],
  groups: [],
  edges: [],
  collapsed: [],
  ...over,
});

/** A pipeline that PULLS from an external source, as rule 4 makes you write it. */
const PIPELINE = doc({
  nodes: [
    { id: 'portal', label: 'Data portal', type: 'external', parent: null },
    { id: 'fetcher', label: 'Fetcher', type: 'service', parent: null },
    { id: 'store', label: 'Store', type: 'database', parent: null },
  ],
  edges: [
    { id: 'pull', from: 'fetcher', to: 'portal', kind: 'read', returns: 'CSV' },
    { id: 'push', from: 'fetcher', to: 'store', kind: 'write' },
  ],
});

/** Rule 4's own example: a service that reads a database. */
const CANONICAL = doc({
  nodes: [
    { id: 'web', label: 'Web', type: 'client', parent: null },
    { id: 'orders', label: 'Orders', type: 'service', parent: null },
    { id: 'postgres', label: 'Postgres', type: 'database', parent: null },
  ],
  edges: [
    { id: 'e1', from: 'web', to: 'orders', kind: 'call' },
    { id: 'e2', from: 'orders', to: 'postgres', kind: 'read' },
  ],
});

const ys = async (d: GraphDoc): Promise<Record<string, number>> => {
  const laid = await layout(d, new ELK() as never);
  const out: Record<string, number> = {};
  for (const n of d.nodes) out[n.id] = laid.nodes.get(n.id)?.y ?? -1;
  return out;
};

describe('flowReversedEdgeIds', () => {
  it('reverses a pull from OUTSIDE the system', () => {
    expect([...flowReversedEdgeIds(PIPELINE)]).toEqual(['pull']);
  });

  it('leaves a pull from INSIDE the system alone', () => {
    // The load-bearing half. `orders reads postgres` is rule 4's own example
    // and the commonest edge there is; reversing it floats the database to
    // the top of the diagram, level with the client.
    expect([...flowReversedEdgeIds(CANONICAL)]).toEqual([]);
  });

  it('reverses a consume from outside, but not a write or a call to it', () => {
    const d = doc({
      nodes: [
        { id: 'ext', label: 'Partner', type: 'external', parent: null },
        { id: 'svc', label: 'Service', type: 'service', parent: null },
      ],
      edges: [
        { id: 'r', from: 'svc', to: 'ext', kind: 'read' },
        { id: 'c', from: 'svc', to: 'ext', kind: 'consume' },
        { id: 'w', from: 'svc', to: 'ext', kind: 'write' },
        { id: 'k', from: 'svc', to: 'ext', kind: 'call' },
        { id: 'p', from: 'svc', to: 'ext', kind: 'publish' },
      ],
    });
    // Only the two that PULL. Data pushed to a partner, or a call made to
    // one, still leaves the system — the partner belongs after, as before.
    expect([...flowReversedEdgeIds(d)].sort()).toEqual(['c', 'r']);
  });

  it('is empty for a document that uses no kind at all', () => {
    // Every document written before §3.9 lays out exactly as it did.
    const old = doc({
      nodes: [
        { id: 'a', label: 'A', type: 'external', parent: null },
        { id: 'b', label: 'B', type: 'service', parent: null },
      ],
      edges: [{ id: 'e', from: 'b', to: 'a', label: 'reads' }],
    });
    expect([...flowReversedEdgeIds(old)]).toEqual([]);
  });

  it('leaves a pull that targets a GROUP alone', () => {
    // A group has no ownership type, so nothing says the data comes from
    // outside; ranking it first would be a guess.
    const d = doc({
      nodes: [{ id: 'svc', label: 'S', type: 'service', parent: null }],
      groups: [{ id: 'vpc', label: 'VPC', kind: 'vpc', parent: null }],
      edges: [{ id: 'e', from: 'svc', to: 'vpc', kind: 'read' }],
    });
    expect([...flowReversedEdgeIds(d)]).toEqual([]);
  });

  it('names the two types the system does not deploy', () => {
    expect([...OUTSIDE_TYPES].sort()).toEqual(['client', 'external']);
  });
});

describe('the picture that results', () => {
  it('puts an external SOURCE first and the store last', async () => {
    // The whole point: the reader follows portal -> fetcher -> store down the
    // page. Before §5.5 the portal was drawn BELOW the fetcher that reads it.
    const y = await ys(PIPELINE);
    expect(y.portal).toBeLessThan(y.fetcher!);
    expect(y.fetcher).toBeLessThan(y.store!);
  }, 30000);

  it('does NOT move the canonical service-reads-database layout', async () => {
    const y = await ys(CANONICAL);
    expect(y.web).toBeLessThan(y.orders!);
    expect(y.orders).toBeLessThan(y.postgres!);
  }, 30000);
});

describe('the swap is invisible past the layout', () => {
  it('hands back a polyline in DOCUMENT order, not ELK order', async () => {
    // The renderer reads points[0] as the edge's SOURCE — that is where the
    // return head goes and where the step badge is anchored. If a reversed
    // edge came back target-first, every arrowhead on it would be at the
    // wrong end.
    const graph = toElk(PIPELINE);
    const raw = flatten(await (new ELK() as never as { layout: (g: unknown) => Promise<never> }).layout(graph));
    const fixed = flatten(
      await (new ELK() as never as { layout: (g: unknown) => Promise<never> }).layout(toElk(PIPELINE)),
      flowReversedEdgeIds(PIPELINE),
    );
    const rawPull = raw.edges.find((e) => e.id === 'pull')!;
    const fixedPull = fixed.edges.find((e) => e.id === 'pull')!;
    // Same polyline, opposite ends.
    expect(fixedPull.points[0]).toEqual(rawPull.points[rawPull.points.length - 1]);
    expect(fixedPull.points[fixedPull.points.length - 1]).toEqual(rawPull.points[0]);
    // And the un-reversed edge is identical either way.
    const rawPush = raw.edges.find((e) => e.id === 'push')!;
    const fixedPush = fixed.edges.find((e) => e.id === 'push')!;
    expect(fixedPush.points).toEqual(rawPush.points);
  }, 30000);

  it('starts the pull at the FETCHER, which is what the document says', async () => {
    const laid = await layout(PIPELINE, new ELK() as never);
    const pull = laid.edges.find((e) => e.id === 'pull')!;
    const fetcher = laid.nodes.get('fetcher')!;
    const portal = laid.nodes.get('portal')!;
    const first = pull.points[0]!;
    const last = pull.points[pull.points.length - 1]!;
    // The polyline leaves the fetcher (lower on the page) and ends at the
    // portal (higher), because the DOCUMENT edge runs fetcher -> portal.
    expect(Math.abs(first.y - fetcher.y)).toBeLessThan(fetcher.height + 40);
    expect(Math.abs(last.y - (portal.y + portal.height))).toBeLessThan(40);
  }, 30000);
});
