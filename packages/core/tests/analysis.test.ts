// tests/analysis.test.ts — the six structural signals (spec §15.2) and the
// honesty contract that ships with them (§15.3 A1–A5).
//
// Every expectation here is hand-computed from a small graph, because a
// signal that is merely self-consistent is worthless: the whole value of
// "postgres is an articulation point isolating 4 nodes" is that the 4 is
// right. Where a fixture fits, the fixture is used — those are the documents
// the rest of the suite already reasons about.

import { describe, expect, it } from 'vitest';
import {
  analyse,
  analysisIsChainlessCycle,
  analysisNotes,
  articulationPoints,
  boundaryCrossings,
  fanIn,
  fanOut,
  isChokepoint,
  longestSyncChain,
  runtimeGraph,
  sharedDependency,
  syncCycles,
} from '../src/analysis/index.js';
import { GraphDocSchema, type GraphDoc } from '../src/schema/graph.js';
import { doc, edge, fixtureJson, group, node } from './helpers.js';

function fixture(name: string): GraphDoc {
  return GraphDocSchema.parse(fixtureJson(name));
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

/** Recursively freeze, so any write anywhere in analysis throws (A1). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A1 / A2 — the contract
// ---------------------------------------------------------------------------

describe('A1: analysis never mutates the document', () => {
  it('runs to completion over a deeply frozen document', () => {
    const d = deepFreeze(fixture('cross-boundary-edges.json'));
    const before = JSON.stringify(d);
    const a = analyse(d);
    expect(a.nodes).toHaveLength(9);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('A2: analysis runs on the full document', () => {
  it('ignores the stored collapsed list — a collapsed VPC still has insides', () => {
    const open = fixture('cross-boundary-edges.json');
    const collapsed = { ...open, collapsed: ['vpc-private'] };
    // Same numbers either way: analyse() must not route through deriveView,
    // or `exec` would hide the chokepoints it exists to find.
    expect(analyse(collapsed).nodes).toEqual(analyse(open).nodes);
    expect(analyse(collapsed).scope).toBe('document');
    expect(ids(analyse(collapsed).nodes)).toContain('postgres');
  });
});

// ---------------------------------------------------------------------------
// signal 1 — fan-in / fan-out, split sync vs async
// ---------------------------------------------------------------------------

describe('fan-in and fan-out', () => {
  const g = () => runtimeGraph(fixture('cross-boundary-edges.json'));

  it('splits synchronous from asynchronous', () => {
    // postgres is read by auth and orders, both solid.
    expect(fanIn(g(), 'postgres')).toEqual({ total: 2, sync: 2, async: 0 });
    // kafka is published to by orders and audited by auth, both dashed.
    expect(fanIn(g(), 'kafka')).toEqual({ total: 2, sync: 0, async: 2 });
    // orders reads postgres (solid) and publishes to kafka (dashed).
    expect(fanOut(g(), 'orders-service')).toEqual({ total: 2, sync: 1, async: 1 });
  });

  it('treats a missing style as solid, which is synchronous', () => {
    const d = doc({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')], // no style at all
    });
    expect(fanIn(runtimeGraph(d), 'b')).toEqual({ total: 1, sync: 1, async: 0 });
  });
});

// ---------------------------------------------------------------------------
// signal 2 — shared dependency, and entry points
// ---------------------------------------------------------------------------

describe('entry points and shared dependency', () => {
  it('entry points are nodes with no inbound edge, not nodes of type client', () => {
    const d = doc({
      nodes: [
        node('cron', { type: 'service' }),
        node('kiosk', { type: 'client' }),
        node('api'),
      ],
      edges: [edge('e1', 'cron', 'api'), edge('e2', 'api', 'kiosk')],
    });
    // cron is a service and IS an entry point; kiosk is a client and is NOT.
    expect(runtimeGraph(d).entryPoints).toEqual(['cron']);
  });

  it('counts the entry points that can reach a node, over sync and async alike', () => {
    const g = runtimeGraph(fixture('cross-boundary-edges.json'));
    const reached = sharedDependency(g);
    expect(reached.get('postgres')).toEqual(['web-client', 'ios-app']);
    // kafka is reachable only across dashed edges — still a dependency.
    expect(reached.get('kafka')).toEqual(['web-client', 'ios-app']);
    // reachability is strict: an entry point does not reach itself.
    expect(reached.get('web-client')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// signal 3 — articulation points
// ---------------------------------------------------------------------------

describe('articulation points', () => {
  it('names the cut vertex and how much it isolates', () => {
    // a - b - c : removing b splits the graph in two, isolating one side.
    // Both halves are size 1, and the tie resolves to the earlier half in
    // document order surviving — pinned so the report cannot drift.
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    });
    expect(articulationPoints(runtimeGraph(d))).toEqual([
      {
        id: 'b',
        label: 'b',
        components: 2,
        isolates: 1,
        isolated: ['c'],
        isolatedBoundaries: [],
      },
    ]);
  });

  it('finds none in a cycle — every vertex has an alternative route', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    });
    expect(articulationPoints(runtimeGraph(d))).toEqual([]);
  });

  it('is undirected: direction never affects connectivity', () => {
    const forward = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
    });
    const both = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'b', 'a'), edge('e2', 'b', 'c')],
    });
    expect(ids(articulationPoints(runtimeGraph(forward)))).toEqual(['b']);
    expect(ids(articulationPoints(runtimeGraph(both)))).toEqual(['b']);
  });

  it('finds all three in the cross-boundary fixture, in document order', () => {
    const found = articulationPoints(runtimeGraph(fixture('cross-boundary-edges.json')));
    expect(found.map((a) => [a.id, a.isolates])).toEqual([
      ['api-gateway', 2], // the two clients hang off it
      ['kafka', 2], // the worker and its archive hang off it
      ['fulfilment-worker', 1], // the archive hangs off it
    ]);
    expect(found[0]?.isolated).toEqual(['web-client', 'ios-app']);
  });
});

// ---------------------------------------------------------------------------
// signals 4 and 6 — the longest synchronous chain, and synchronous cycles
// ---------------------------------------------------------------------------

describe('longest synchronous chain', () => {
  it('follows solid edges only and stops at a dashed one', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [
        edge('e1', 'a', 'b'),
        edge('e2', 'b', 'c', { style: 'dashed' }),
        edge('e3', 'c', 'd'),
      ],
    });
    const chain = longestSyncChain(runtimeGraph(d));
    expect(chain?.depth).toBe(2);
    expect(chain?.throughCycle).toBe(false);
  });

  it('is null when nothing is synchronous', () => {
    const d = doc({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b', { style: 'dashed' })],
    });
    expect(longestSyncChain(runtimeGraph(d))).toBeNull();
  });

  it('finds the four-deep chain in the cross-boundary fixture', () => {
    const chain = longestSyncChain(runtimeGraph(fixture('cross-boundary-edges.json')));
    expect(chain?.depth).toBe(4);
    expect(chain?.path[0]).toBe('web-client');
    expect(chain?.path.at(-1)).toBe('postgres');
    expect(chain?.path[1]).toBe('api-gateway');
    expect(chain?.throughCycle).toBe(false);
  });

  it('condenses a cycle into one step rather than traversing it', () => {
    // client -> a <-> b -> sink, with a<->b a synchronous cycle.
    const d = doc({
      nodes: [node('client'), node('a'), node('b'), node('sink')],
      edges: [
        edge('e1', 'client', 'a'),
        edge('e2', 'a', 'b'),
        edge('e3', 'b', 'a'),
        edge('e4', 'b', 'sink'),
      ],
    });
    const chain = longestSyncChain(runtimeGraph(d));
    // client, {a,b}, sink — three steps, not four, and the cycle is declared.
    expect(chain?.depth).toBe(3);
    expect(chain?.throughCycle).toBe(true);
    expect(chain?.cycles[0]?.members).toEqual(['a', 'b']);
  });
});

describe('synchronous cycles', () => {
  it('reports an SCC of size > 1 over solid edges', () => {
    const d = doc({
      nodes: [node('orders'), node('inventory')],
      edges: [edge('e1', 'orders', 'inventory'), edge('e2', 'inventory', 'orders')],
    });
    expect(syncCycles(runtimeGraph(d))).toEqual([
      {
        members: ['orders', 'inventory'],
        loop: ['orders', 'inventory'],
        edges: ['e1', 'e2'],
      },
    ]);
  });

  it('does not report a cycle that is closed by a dashed edge', () => {
    // The dashed edge is exactly how a cycle is made safe (§4.4 rule 6).
    const d = doc({
      nodes: [node('orders'), node('inventory')],
      edges: [
        edge('e1', 'orders', 'inventory'),
        edge('e2', 'inventory', 'orders', { style: 'dashed' }),
      ],
    });
    expect(syncCycles(runtimeGraph(d))).toEqual([]);
  });

  it('does not report a single node as a cycle', () => {
    const d = doc({ nodes: [node('a'), node('b')], edges: [edge('e1', 'a', 'b')] });
    expect(syncCycles(runtimeGraph(d))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// signal 5 — boundary crossings
// ---------------------------------------------------------------------------

describe('boundary crossings', () => {
  it('counts edges per container pair, root last', () => {
    const crossings = boundaryCrossings(runtimeGraph(fixture('cross-boundary-edges.json')));
    // e5, e6, e7, e9, e10 cross the VPC wall; e8 (kafka -> worker) does not.
    expect(crossings).toEqual([
      {
        from: 'vpc-private',
        to: null,
        count: 5,
        edges: ['e5', 'e6', 'e7', 'e9', 'e10'],
      },
    ]);
  });

  it('counts a nested boundary as a crossing too', () => {
    // api-gateway sits in region-eu; auth and orders sit in the VPC inside it.
    // Those hops leave a boundary, so they are crossings.
    const crossings = boundaryCrossings(runtimeGraph(fixture('nested-two-deep.json')));
    expect(crossings).toEqual([
      { from: 'region-eu', to: 'vpc-private', count: 2, edges: ['e2', 'e3'] },
      { from: 'region-eu', to: null, count: 1, edges: ['e1'] },
    ]);
  });

  it('reports none when everything shares a parent', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('a', { parent: 'vpc' }), node('b', { parent: 'vpc' })],
      edges: [edge('e1', 'a', 'b')],
    });
    expect(boundaryCrossings(runtimeGraph(d))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A4 — entity nodes and cardinality edges, excluded and SAID SO
// ---------------------------------------------------------------------------

describe('A4: an ERD is a data model, not a runtime', () => {
  it('excludes every entity node and cardinality edge, and names them', () => {
    const a = analyse(fixture('erd-ecommerce.json'));
    expect(a.nodes).toEqual([]);
    expect(a.excluded.entityNodes.length).toBeGreaterThan(0);
    expect(a.excluded.cardinalityEdges.length).toBeGreaterThan(0);
    expect(a.excluded.erdOnly).toBe(true);
    expect(a.notes).toContain(
      'this document is a data model, not a runtime: there is nothing to analyse',
    );
    expect(a.notes.some((n) => n.includes('excluded (data model, not runtime)'))).toBe(true);
  });

  it('analyses the runtime half of a mixed document and excludes the rest', () => {
    const a = analyse(fixture('mixed-erd-architecture.json'));
    expect(ids(a.nodes)).toEqual(['billing-api', 'billing-db', 'invoice-jobs']);
    expect(a.excluded.entityNodes).toEqual(['invoices', 'invoice-lines']);
    expect(a.excluded.cardinalityEdges).toEqual(['x5']);
    // x3 and x4 carry no cardinality but point at entities: same exclusion.
    expect(a.excluded.entityEdges).toEqual(['x3', 'x4']);
    expect(a.excluded.erdOnly).toBe(false);
    expect(ids(a.articulationPoints)).toEqual(['billing-api']);
  });

  it('drops an edge whose endpoint names nothing, without throwing', () => {
    const d = doc({ nodes: [node('a')], edges: [edge('e1', 'a', 'ghost')] });
    const a = analyse(d);
    expect(a.excluded.danglingEdges).toEqual(['e1']);
    expect(a.notes.some((n) => n.includes('unknown endpoint'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A5 — coverage, always
// ---------------------------------------------------------------------------

describe('A5: coverage is always reported', () => {
  it('counts the nodes carrying no operational meta, and names them', () => {
    const a = analyse(fixture('cross-boundary-edges.json'));
    expect(a.coverage).toEqual({
      nodes: 9,
      withMeta: 0,
      withoutMeta: 9,
      missing: [
        'web-client',
        'ios-app',
        'api-gateway',
        'auth-service',
        'orders-service',
        'postgres',
        'kafka',
        'fulfilment-worker',
        's3-archive',
      ],
      keys: [],
      keyCounts: {},
    });
    expect(a.notes[0]).toBe('9 of 9 nodes carry no operational meta');
  });

  it('reports full coverage, and the keys available to attribute to (A3)', () => {
    const a = analyse(fixture('mixed-erd-architecture.json'));
    expect(a.coverage.withoutMeta).toBe(0);
    expect(a.coverage.keys).toContain('owner');
    expect(a.notes[0]).toBe('0 of 3 nodes carry no operational meta');
  });

  it('closes with the sentence that says what structure cannot know', () => {
    const a = analyse(doc());
    expect(a.notes.at(-1)).toBe(
      'structural facts only: no traffic, latency or capacity is known to the document',
    );
    expect(a.notes[0]).toBe('no runtime nodes to analyse');
    expect(analysisNotes(a.coverage, a.excluded)).toEqual(a.notes);
  });
});

// ---------------------------------------------------------------------------
// the assembled result
// ---------------------------------------------------------------------------

describe('analyse', () => {
  it('ranks chokepoints by convergent pressure, entry points never among them', () => {
    const a = analyse(fixture('cross-boundary-edges.json'));
    expect(ids(a.chokepoints)).toEqual([
      'api-gateway', // 2 synchronous callers AND an articulation point
      'postgres', // 2 synchronous callers
      'kafka', // articulation point, 2 asynchronous publishers
      'fulfilment-worker', // articulation point
    ]);
    expect(a.entryPoints).toEqual(['web-client', 'ios-app']);
    expect(a.chokepoints.every((c) => !c.isEntryPoint)).toBe(true);
    expect(a.nodes.filter(isChokepoint)).toHaveLength(4);
  });

  it('carries the articulation finding onto the node it belongs to', () => {
    const a = analyse(fixture('cross-boundary-edges.json'));
    const api = a.nodes.find((n) => n.id === 'api-gateway');
    expect(api?.articulation?.isolates).toBe(2);
    expect(a.nodes.find((n) => n.id === 'postgres')?.articulation).toBeNull();
  });

  it('survives an empty document', () => {
    const a = analyse(doc());
    expect(a.nodes).toEqual([]);
    expect(a.chokepoints).toEqual([]);
    expect(a.longestSyncChain).toBeNull();
    expect(a.syncCycles).toEqual([]);
    expect(a.boundaryCrossings).toEqual([]);
  });

  it('is deterministic — same document, identical result', () => {
    const d = fixture('meta-rich.json');
    expect(analyse(d)).toEqual(analyse(structuredClone(d)));
  });
});

// ---------------------------------------------------------------------------
// Direction, which is the one thing this whole phase is not allowed to invent
// (§18.10 gate 2). Every case below is a strongly connected component whose
// DOCUMENT ORDER is not a valid traversal order, which is the shape the
// original renderer got exactly backwards.
// ---------------------------------------------------------------------------

describe('sync cycles: the ordered walk is made of real edges', () => {
  it('orders the loop by the edges, not by the document', () => {
    // Nodes in the order a, b, c; the real loop runs a → c → b → a. Joining
    // `members` with an arrow would print a → b → c → a: three arrows, none
    // of which exists, each the exact reverse of a real one.
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'c'), edge('e2', 'c', 'b'), edge('e3', 'b', 'a')],
    });
    const [cycle] = syncCycles(runtimeGraph(d));
    expect(cycle?.members).toEqual(['a', 'b', 'c']);
    expect(cycle?.loop).toEqual(['a', 'c', 'b']);
  });

  it('never claims a component that is not a simple ring is one', () => {
    // One SCC of five: a ⇄ b, and b → c → dd → e → b hanging off it. No
    // single simple cycle covers all five, so the loop must be a real one and
    // the surface must name the rest rather than close a ring that has no
    // e → a edge in it.
    const d = doc({
      nodes: [node('a'), node('b'), node('c'), node('dd'), node('e')],
      edges: [
        edge('e1', 'a', 'b'),
        edge('e2', 'b', 'a'),
        edge('e3', 'b', 'c'),
        edge('e4', 'c', 'dd'),
        edge('e5', 'dd', 'e'),
        edge('e6', 'e', 'b'),
      ],
    });
    const [cycle] = syncCycles(runtimeGraph(d));
    expect(cycle?.members).toEqual(['a', 'b', 'c', 'dd', 'e']);
    expect(cycle?.loop).toEqual(['a', 'b']);
    // every consecutive pair of `loop`, closed, is a real edge
    const real = new Set(d.edges.map((x) => `${x.from}->${x.to}`));
    const loop = cycle?.loop ?? [];
    for (let i = 0; i < loop.length; i += 1) {
      expect(real.has(`${loop[i]}->${loop[(i + 1) % loop.length]}`)).toBe(true);
    }
  });

  it('handles a ring with a chord without inventing the chord away', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('c'), node('dd')],
      edges: [
        edge('e1', 'a', 'b'),
        edge('e2', 'b', 'c'),
        edge('e3', 'c', 'dd'),
        edge('e4', 'dd', 'a'),
        edge('e5', 'b', 'dd'),
      ],
    });
    const [cycle] = syncCycles(runtimeGraph(d));
    // The shortest cycle through `a` takes the chord: a → b → dd → a.
    expect(cycle?.loop).toEqual(['a', 'b', 'dd']);
  });
});

describe('a wholly cyclic system still reports where latency accumulates', () => {
  it('says the chain is a single cycle rather than dropping the block', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'a')],
    });
    const a = analyse(d);
    expect(a.longestSyncChain).toBeNull();
    expect(a.syncCycles).toHaveLength(1);
    expect(analysisIsChainlessCycle(a)).toBe(true);
    // and the two documents are distinguishable: no sync edges at all is not
    // the same finding as "the whole synchronous subgraph is one loop".
    const quiet = analyse(
      doc({
        nodes: [node('a'), node('b')],
        edges: [edge('e1', 'a', 'b', { style: 'dashed' })],
      }),
    );
    expect(analysisIsChainlessCycle(quiet)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Containment is connectivity — an edge into a boundary is an edge into what
// the boundary holds.
// ---------------------------------------------------------------------------

describe('a boundary an edge names is part of the connectivity', () => {
  it('finds the cut vertex a containment-only link would have hidden', () => {
    // web → vpc, api inside vpc, api → db outside it. Undirected this is one
    // connected piece and api is the single point joining db to the rest.
    // Without a containment link the projection falls into two disconnected
    // pieces and api is not reported at all — an under-report of a single
    // point of failure, which is the dangerous direction.
    const d = doc({
      nodes: [node('web'), node('api', { parent: 'vpc' }), node('db')],
      groups: [group('vpc')],
      edges: [edge('e1', 'web', 'vpc'), edge('e2', 'api', 'db')],
    });
    const [a] = articulationPoints(runtimeGraph(d));
    expect(a?.id).toBe('api');
    expect(a?.isolated).toEqual(['db']);
  });

  it('counts an isolated boundary as a boundary, never as a node', () => {
    // Removing api cuts the group vertex off — that is zero NODES isolated.
    const d = doc({
      nodes: [node('web'), node('api')],
      groups: [group('vpc')],
      edges: [edge('e1', 'web', 'api'), edge('e2', 'api', 'vpc')],
    });
    const [a] = articulationPoints(runtimeGraph(d));
    expect(a?.id).toBe('api');
    expect(a?.isolates).toBe(0);
    expect(a?.isolated).toEqual([]);
    expect(a?.isolatedBoundaries).toEqual(['vpc']);
  });
});

describe('one definition of operational metadata', () => {
  it('per-node metaKeys and coverage agree', () => {
    const d = doc({
      nodes: [
        node('a', { meta: { rps: '10' } }),
        node('b', { meta: { rps: '2', p99: '3ms' } }),
        node('c'),
      ],
    });
    const a = analyse(d);
    expect(a.coverage.keyCounts).toEqual({ rps: 2, p99: 1 });
    expect(a.nodes.map((n) => n.metaKeys)).toEqual([['rps'], ['p99', 'rps'], []]);
  });
});
