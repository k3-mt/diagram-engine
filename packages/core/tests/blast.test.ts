// tests/blast.test.ts — predicted blast radius and the experiment backlog
// (spec §18.3, §18.4, rules C1–C3).
//
// The three details §18.3 says carry the weight get a test each, and each one
// is a claim that would be silently wrong rather than loudly broken:
//
//   * direction — the traversal runs BACKWARDS, so a dependency is never
//     reported as a dependent. Reverse the arrows and this file fails.
//   * dashed edges stop propagation, and the far side is named as CONTAINED.
//   * a group experiment takes its descendants with it.
//
// Plus the line C3 draws: nothing here ever says "will fail", and the
// assumptions block that says so travels on every result.

import { describe, expect, it } from 'vitest';
import {
  ASSUMPTION_AT_RISK,
  ASSUMPTION_NO_REDUNDANCY,
  ASSUMPTION_SYNC_ONLY,
  backlog,
  blastRadius,
  blastRadiusMulti,
  runtimeGraph,
} from '../src/analysis/index.js';
import { GraphDocSchema, type GraphDoc } from '../src/schema/graph.js';
import { doc, edge, fixtureJson, group, node } from './helpers.js';

function fixture(name: string): GraphDoc {
  return GraphDocSchema.parse(fixtureJson(name));
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// direction — the gate M8 had to clear before any of this was allowed
// ---------------------------------------------------------------------------

describe('blast radius follows edges backwards', () => {
  const cross = () => fixture('cross-boundary-edges.json');

  it('names everything that depends on the target, nearest first', () => {
    const r = blastRadius(cross(), 'postgres');
    expect(r.targetKind).toBe('node');
    expect(r.killed).toEqual(['postgres']);
    expect(r.atRisk.map((a) => [a.id, a.depth])).toEqual([
      ['auth-service', 1],
      ['orders-service', 1],
      ['api-gateway', 2],
      ['web-client', 3],
      ['ios-app', 3],
    ]);
  });

  it('reports nothing at risk for a leaf dependency of nobody', () => {
    // Reversing the arrows would make this the biggest blast radius in the
    // document instead of the smallest, which is exactly §18.10 gate 2.
    const r = blastRadius(cross(), 'web-client');
    expect(r.atRisk).toEqual([]);
    expect(r.contained).toEqual([]);
    expect(r.note).toBeNull();
  });

  it('records the edge each at-risk node was reached by', () => {
    const r = blastRadius(cross(), 'postgres');
    expect(r.atRisk.find((a) => a.id === 'auth-service')?.via).toBe('e5');
    expect(r.atRisk.find((a) => a.id === 'api-gateway')?.via).toBe('e3');
  });
});

// ---------------------------------------------------------------------------
// detail 1 — dashed edges stop propagation, and containment is stated
// ---------------------------------------------------------------------------

describe('dashed edges contain the blast', () => {
  it('halts at the dashed edge and names the far side, with the edge', () => {
    const r = blastRadius(fixture('cross-boundary-edges.json'), 'kafka');
    expect(r.atRisk).toEqual([]);
    expect(r.contained).toEqual([
      {
        id: 'auth-service',
        label: 'Auth Service',
        edge: 'e10',
        from: 'kafka',
        edgeLabel: 'audit events',
      },
      {
        id: 'orders-service',
        label: 'Orders Service',
        edge: 'e7',
        from: 'kafka',
        edgeLabel: 'publishes',
      },
    ]);
  });

  it('stops a chain part way and reports both halves', () => {
    // s3 <- worker <⇠ kafka : the worker is at risk, kafka is contained.
    const r = blastRadius(fixture('cross-boundary-edges.json'), 's3-archive');
    expect(ids(r.atRisk)).toEqual(['fulfilment-worker']);
    expect(ids(r.contained)).toEqual(['kafka']);
    expect(r.contained[0]?.edge).toBe('e8');
  });

  it('prefers at risk over contained when a node has both paths', () => {
    // b publishes to c asynchronously AND calls it synchronously. The queue
    // does not protect b, so b is at risk, not contained.
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        edge('e1', 'b', 'c', { style: 'dashed' }),
        edge('e2', 'b', 'c'),
        edge('e3', 'a', 'b'),
      ],
    });
    const r = blastRadius(d, 'c');
    expect(ids(r.atRisk)).toEqual(['b', 'a']);
    expect(r.contained).toEqual([]);
  });

  it('contains the whole tail: nothing behind a dashed edge is reached', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [
        edge('e1', 'a', 'b'),
        edge('e2', 'b', 'c', { style: 'dashed' }),
        edge('e3', 'c', 'd'),
      ],
    });
    // d dies: c depends on it synchronously; b is contained by the queue; a
    // is behind b and is never reached at all.
    const r = blastRadius(d, 'd');
    expect(ids(r.atRisk)).toEqual(['c']);
    expect(ids(r.contained)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// detail 2 — killing a group kills its descendants
// ---------------------------------------------------------------------------

describe('a group is one experiment', () => {
  it('kills every descendant and propagates from all of them', () => {
    const r = blastRadius(fixture('nested-two-deep.json'), 'vpc-private');
    expect(r.targetKind).toBe('group');
    expect(r.killed).toEqual([
      'vpc-private',
      'auth-service',
      'orders-service',
      'postgres',
    ]);
    expect(r.atRisk.map((a) => [a.id, a.depth])).toEqual([
      ['api-gateway', 1],
      ['web-client', 2],
    ]);
  });

  it('kills nested groups too', () => {
    const r = blastRadius(fixture('nested-two-deep.json'), 'region-eu');
    expect(r.killed).toContain('api-gateway');
    expect(r.killed).toContain('postgres');
    expect(ids(r.atRisk)).toEqual(['web-client']);
  });

  it('never claims a group is an articulation point', () => {
    // Articulation points are a property of the runtime nodes (§15.2); a
    // boundary is not one, and must not be reported as one (detail 3).
    expect(blastRadius(fixture('nested-two-deep.json'), 'vpc-private').articulation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detail 3 — articulation point and blast radius are different metrics
// ---------------------------------------------------------------------------

describe('blast radius is not an articulation point', () => {
  it('reports both, side by side, without merging them', () => {
    const r = blastRadius(fixture('cross-boundary-edges.json'), 'api-gateway');
    expect(ids(r.atRisk)).toEqual(['web-client', 'ios-app']);
    expect(r.articulation?.isolates).toBe(2);
  });

  it('shows them disagreeing: an articulation point with nothing at risk', () => {
    // kafka splits the diagram in two (undirected connectivity) and yet
    // nothing depends on it synchronously. Conflating the two would report
    // four services at risk from a queue outage that the design contains.
    const r = blastRadius(fixture('cross-boundary-edges.json'), 'kafka');
    expect(r.articulation?.isolates).toBe(2);
    expect(r.atRisk).toEqual([]);
  });

  it('shows them disagreeing the other way: at risk without being a cut', () => {
    const r = blastRadius(fixture('cross-boundary-edges.json'), 'postgres');
    expect(r.atRisk).toHaveLength(5);
    expect(r.articulation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C3, A4, A5 — what the result refuses to claim
// ---------------------------------------------------------------------------

describe('C3: at risk, never will fail', () => {
  it('carries the assumptions on every result, including an empty one', () => {
    for (const target of ['postgres', 'web-client', 'no-such-node']) {
      const r = blastRadius(fixture('cross-boundary-edges.json'), target);
      expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
      expect(r.assumptions).toContain(ASSUMPTION_SYNC_ONLY);
      expect(r.assumptions[0]).toBe('9 of 9 nodes carry no operational meta');
    }
  });

  it('says "will fail" only to disown it', () => {
    const r = blastRadius(fixture('cross-boundary-edges.json'), 'postgres');
    // The phrase appears exactly once in the whole result: in the sentence
    // that refuses it. No field is named for it and no list implies it.
    const hits = JSON.stringify(r).match(/will fail/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
    expect(JSON.stringify({ atRisk: r.atRisk, contained: r.contained })).not.toContain('fail');
  });
});

describe('A4/A5 travel with the prediction', () => {
  it('refuses an entity target and says why, rather than answering zero', () => {
    const r = blastRadius(fixture('mixed-erd-architecture.json'), 'invoices');
    expect(r.targetKind).toBe('entity');
    expect(r.atRisk).toEqual([]);
    expect(r.note).toBe(
      '"invoices" is an entity node: a data model, not a runtime component — there is nothing to predict',
    );
    expect(r.excluded.entityNodes).toEqual(['invoices', 'invoice-lines']);
  });

  it('answers an unknown id with a note, not a throw', () => {
    const r = blastRadius(doc(), 'ghost');
    expect(r.targetKind).toBe('unknown');
    expect(r.note).toBe('no node or group with id "ghost"');
  });

  it('ignores an ERD edge when predicting on a mixed document', () => {
    // billing-db ⇢ invoices exists in the document and is not a call.
    const r = blastRadius(fixture('mixed-erd-architecture.json'), 'billing-db');
    expect(ids(r.atRisk)).toEqual(['billing-api', 'invoice-jobs']);
    expect(r.contained).toEqual([]);
  });
});

describe('C1/A1: the engine is the map, never the hand on the switch', () => {
  it('predicts over a deeply frozen document', () => {
    const d = deepFreeze(fixture('cross-boundary-edges.json'));
    const before = JSON.stringify(d);
    expect(blastRadius(d, 'postgres').atRisk).toHaveLength(5);
    expect(backlog(d)).toHaveLength(7);
    expect(JSON.stringify(d)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// §18.4 — the experiment backlog
// ---------------------------------------------------------------------------

describe('experiment backlog', () => {
  it('ranks by at-risk count, then articulation point, then sync fan-in', () => {
    const rows = backlog(fixture('cross-boundary-edges.json'));
    expect(rows.map((r) => [r.id, r.atRisk, r.articulationPoint])).toEqual([
      ['postgres', 5, false],
      ['auth-service', 3, false],
      ['orders-service', 3, false],
      ['api-gateway', 2, true],
      ['s3-archive', 1, false],
      ['kafka', 0, true],
      ['fulfilment-worker', 0, true],
    ]);
  });

  it('excludes entry points — killing the browser is not an experiment', () => {
    const rows = backlog(fixture('cross-boundary-edges.json'));
    expect(ids(rows)).not.toContain('web-client');
    expect(ids(rows)).not.toContain('ios-app');
  });

  it('does NOT exclude external nodes — a third-party outage is an experiment', () => {
    const d = doc({
      nodes: [
        node('web', { type: 'client' }),
        node('api'),
        node('stripe', { type: 'external' }),
      ],
      edges: [edge('e1', 'web', 'api'), edge('e2', 'api', 'stripe')],
    });
    const rows = backlog(d);
    expect(rows[0]?.id).toBe('stripe');
    expect(rows[0]?.type).toBe('external');
    expect(rows[0]?.atRisk).toBe(2);
  });

  it('excludes entity nodes, which are not runtime components', () => {
    expect(ids(backlog(fixture('mixed-erd-architecture.json')))).toEqual([
      'billing-db',
      'billing-api',
    ]);
  });

  it('counts the containments a candidate relies on', () => {
    const rows = backlog(fixture('cross-boundary-edges.json'));
    expect(rows.find((r) => r.id === 'kafka')?.contained).toBe(2);
    expect(rows.find((r) => r.id === 's3-archive')?.contained).toBe(1);
  });

  it('adds boundary experiments only when asked', () => {
    const nodesOnly = backlog(fixture('nested-two-deep.json'));
    expect(ids(nodesOnly)).not.toContain('vpc-private');
    const withGroups = backlog(fixture('nested-two-deep.json'), { includeGroups: true });
    // Killing the whole region leaves only the browser at risk; killing
    // postgres alone puts four services at risk. The bigger box is not
    // automatically the bigger experiment, and the ranking says so.
    expect(withGroups[0]).toMatchObject({ id: 'postgres', kind: 'node', atRisk: 4 });
    expect(withGroups.find((r) => r.id === 'region-eu')).toMatchObject({
      kind: 'group',
      atRisk: 1,
      articulationPoint: false,
    });
    expect(ids(withGroups)).toContain('vpc-private');
  });

  it('is empty for a document with nothing to break', () => {
    expect(backlog(doc())).toEqual([]);
    expect(
      backlog(doc({ groups: [group('vpc', { kind: 'vpc' })], nodes: [node('a')] })),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// An edge that terminates on a BOUNDARY is a dependency on what the boundary
// holds. Without this, killing a component inside a depended-on VPC reported
// nothing at risk — a silent zero on the one command whose refusal path exists
// because "nothing is at risk" is the most dangerous thing it can say by
// accident.
// ---------------------------------------------------------------------------

describe('an edge into a boundary reaches the components inside it', () => {
  const d = doc({
    nodes: [node('client'), node('api', { parent: 'vpc' })],
    groups: [group('vpc')],
    edges: [edge('e1', 'client', 'vpc')],
  });

  it('puts the boundary’s dependents at risk when a component inside dies', () => {
    const r = blastRadius(d, 'api');
    expect(ids(r.atRisk)).toEqual(['client']);
    expect(r.atRisk[0]?.depth).toBe(1);
    expect(r.atRisk[0]?.via).toBe('e1');
  });

  it('still answers the boundary experiment the same way', () => {
    const r = blastRadius(d, 'vpc');
    expect(r.killed).toEqual(['vpc', 'api']);
    expect(ids(r.atRisk)).toEqual(['client']);
  });

  it('names the far side of a dashed edge that lands on the boundary', () => {
    const async_ = doc({
      nodes: [node('client'), node('api', { parent: 'vpc' })],
      groups: [group('vpc')],
      edges: [edge('e1', 'client', 'vpc', { style: 'dashed' })],
    });
    const r = blastRadius(async_, 'api');
    expect(ids(r.atRisk)).toEqual([]);
    expect(r.contained).toEqual([
      { id: 'client', label: 'client', edge: 'e1', from: 'vpc', edgeLabel: null },
    ]);
  });

  it('changes nothing for a document whose edges never name a group', () => {
    const plain = doc({
      nodes: [node('client'), node('api', { parent: 'vpc' })],
      groups: [group('vpc')],
      edges: [edge('e1', 'client', 'api')],
    });
    expect(ids(blastRadius(plain, 'api').atRisk)).toEqual(['client']);
    expect(blastRadius(plain, 'vpc').killed).toEqual(['vpc', 'api']);
  });
});

describe('the killed list does not reorder for unrelated reasons', () => {
  it('is the target then its descendants, edge or no edge on the group', () => {
    const nodes = [node('web'), node('api', { parent: 'vpc' })];
    const groups = [group('vpc')];
    const untouched = doc({ nodes, groups, edges: [edge('e1', 'web', 'api')] });
    const touched = doc({ nodes, groups, edges: [edge('e1', 'web', 'vpc')] });
    expect(blastRadius(untouched, 'vpc').killed).toEqual(['vpc', 'api']);
    expect(blastRadius(touched, 'vpc').killed).toEqual(['vpc', 'api']);
  });
});

describe('a boundary experiment carries what it kills', () => {
  it('reports the kill count the at-risk number leaves out', () => {
    const d = doc({
      nodes: [node('web'), node('api', { parent: 'vpc' }), node('db', { parent: 'vpc' })],
      groups: [group('vpc')],
      edges: [edge('e1', 'web', 'api'), edge('e2', 'api', 'db')],
    });
    const rows = backlog(d, { includeGroups: true });
    const vpc = rows.find((r) => r.id === 'vpc');
    expect(vpc?.atRisk).toBe(1);
    expect(vpc?.kills).toBe(2);
    expect(rows.filter((r) => r.kind === 'node').every((r) => r.kills === 0)).toBe(true);
  });
});

describe('one articulation sweep, not one per candidate', () => {
  it('ranks a 150-node document well inside the §15.2 budget', () => {
    const n = 150;
    const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: n - 1 }, (_, i) =>
      edge(`e${i}`, `n${i}`, `n${i + 1}`),
    );
    const d = doc({ nodes, edges });
    const started = Date.now();
    expect(backlog(d)).toHaveLength(n - 1);
    // The naive sweep is O(n·(n+e)) and is meant to run ONCE. Running it per
    // candidate put this at ~2s against a sub-millisecond budget; the bound
    // here is loose enough not to be a flaky clock test and tight enough that
    // the quadratic sweep cannot come back unnoticed.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('shares that one sweep across a whole multi-target selection (§18.7)', () => {
    // The same regression, one level up: blastRadiusMultiOn maps
    // blastRadiusOn over the targets, and without an index each call rebuilt
    // the whole O(n·(n+e)) sweep and threw it away. The viewer re-pays it on
    // every shift-click, so eight targets cost eight sweeps for an answer
    // that does not even expose an articulation field.
    const n = 200;
    const nodes = Array.from({ length: n }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: n - 1 }, (_, i) =>
      edge(`e${i}`, `n${i}`, `n${i + 1}`),
    );
    const d = doc({ nodes, edges });
    const targets = Array.from({ length: 8 }, (_, i) => `n${i * 10 + 5}`);

    const t0 = Date.now();
    blastRadiusMulti(d, [targets[0] as string]);
    const one = Date.now() - t0;
    const t1 = Date.now();
    const many = blastRadiusMulti(d, targets);
    const eight = Date.now() - t1;

    expect(many.per).toHaveLength(8);
    // Same order of magnitude as one target, not eight times it. The slack is
    // generous — this is a clock — but a per-target sweep is ~8x and cannot
    // hide inside it.
    expect(eight).toBeLessThan(Math.max(one * 3, 40));
  });
});

describe('a component inside a depended-on boundary is not an entry point', () => {
  it('is ranked as an experiment rather than dismissed as a browser', () => {
    const d = doc({
      nodes: [node('client'), node('api', { parent: 'vpc' })],
      groups: [group('vpc')],
      edges: [edge('e1', 'client', 'vpc')],
    });
    expect(runtimeGraph(d).entryPoints).toEqual(['client']);
    expect(backlog(d).map((r) => [r.id, r.atRisk])).toEqual([['api', 1]]);
  });
});

// ---------------------------------------------------------------------------
// §18.7 multi-select — "can we survive losing an availability zone?"
//
// The at-risk set for several targets is the UNION of their individual sets.
// Two things make that harder than it sounds, and each gets a test:
//
//   * a target that is itself at risk from another target is a TARGET, once.
//   * a node contained from one target but reachable from another is AT RISK.
//     A naive union of the contained sets calls it safe, which is the design's
//     own safety claim applied to a path the design does not break.
//
// Plus §18.11: the union is arithmetically right over a model that cannot
// express redundancy, so the caveat travels on the result as data.
// ---------------------------------------------------------------------------

describe('multi-target blast radius is the union (§18.7)', () => {
  it('answers one id with exactly the single-target answer', () => {
    // One definition of the answer, not two that drift: the multi path runs
    // the same traversal over the same killed set.
    const d = fixture('cross-boundary-edges.json');
    const one = blastRadius(d, 'postgres');
    const multi = blastRadiusMulti(d, ['postgres']);
    expect(multi.per).toEqual([one]);
    expect(multi.killed).toEqual(one.killed);
    expect(multi.atRisk).toEqual(one.atRisk);
    expect(multi.contained).toEqual(one.contained);
    expect(multi.assumptions).toEqual(one.assumptions);
    expect(multi.coverage).toEqual(one.coverage);
    expect(multi.excluded).toEqual(one.excluded);
    expect(multi.note).toBeNull();
  });

  it('unions two independent targets rather than answering only the last', () => {
    const d = doc({
      nodes: [node('a'), node('b'), node('x'), node('y')],
      edges: [edge('e1', 'a', 'x'), edge('e2', 'b', 'y')],
    });
    expect(ids(blastRadius(d, 'x').atRisk)).toEqual(['a']);
    expect(ids(blastRadius(d, 'y').atRisk)).toEqual(['b']);
    const r = blastRadiusMulti(d, ['x', 'y']);
    expect(r.killed).toEqual(['x', 'y']);
    expect(ids(r.atRisk)).toEqual(['a', 'b']);
    expect(r.atRiskIds).toEqual(['a', 'b']);
  });

  it('measures depth from the nearest killed target, not from the first', () => {
    // c -> b -> a. Killing a alone puts b at 1 and c at 2; adding b as a
    // target makes c a direct dependent of something dead.
    const d = doc({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('e1', 'b', 'a'), edge('e2', 'c', 'b')],
    });
    expect(blastRadius(d, 'a').atRisk.map((x) => [x.id, x.depth])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
    const r = blastRadiusMulti(d, ['a', 'b']);
    expect(r.atRisk.map((x) => [x.id, x.depth, x.via])).toEqual([['c', 1, 'e2']]);
  });

  it('reports a target that is at risk from another target once, as a target', () => {
    const d = doc({
      nodes: [node('p'), node('q'), node('r')],
      edges: [edge('e1', 'q', 'p'), edge('e2', 'r', 'q')],
    });
    expect(ids(blastRadius(d, 'p').atRisk)).toEqual(['q', 'r']);
    const r = blastRadiusMulti(d, ['p', 'q']);
    expect(r.targets).toEqual(['p', 'q']);
    expect(r.killed).toEqual(['p', 'q']);
    expect(ids(r.atRisk)).toEqual(['r']);
    expect(r.atRiskIds).not.toContain('q');
  });

  it('de-duplicates a repeated target instead of killing it twice', () => {
    const d = doc({
      nodes: [node('a'), node('x')],
      edges: [edge('e1', 'a', 'x')],
    });
    const r = blastRadiusMulti(d, ['x', 'x']);
    expect(r.targets).toEqual(['x']);
    expect(r.killed).toEqual(['x']);
    expect(ids(r.atRisk)).toEqual(['a']);
  });

  it('composes a group experiment with the union — descendants and all', () => {
    const d = doc({
      nodes: [
        node('web'),
        node('api', { parent: 'vpc' }),
        node('db', { parent: 'vpc' }),
        node('jobs'),
        node('cache'),
      ],
      groups: [group('vpc', { kind: 'vpc' })],
      edges: [
        edge('e1', 'web', 'api'),
        edge('e2', 'api', 'db'),
        edge('e3', 'jobs', 'cache'),
      ],
    });
    const r = blastRadiusMulti(d, ['vpc', 'cache']);
    expect(r.per.map((p) => p.targetKind)).toEqual(['group', 'node']);
    // Target first, then its descendants, then the next target (detail 2).
    expect(r.killed).toEqual(['vpc', 'api', 'db', 'cache']);
    // api and db are dead, not at risk; web and jobs are the union.
    expect(ids(r.atRisk)).toEqual(['web', 'jobs']);
  });
});

describe('multi-target containment is a union MINUS whatever is at risk', () => {
  // a is behind a DASHED edge from x and a SOLID edge to y. Killing x alone
  // contains a; killing both must call it at risk. Merging the two contained
  // lists without subtracting the at-risk set claims the queue protects a
  // node that is also making a synchronous call — a false safety claim.
  const d = () =>
    doc({
      nodes: [node('a'), node('b'), node('c'), node('x'), node('y')],
      edges: [
        edge('e1', 'a', 'x', { style: 'dashed' }),
        edge('e2', 'a', 'y'),
        edge('e3', 'b', 'x', { style: 'dashed' }),
        edge('e4', 'c', 'a'),
      ],
    });

  it('shows the single-target answers a naive union would merge', () => {
    expect(ids(blastRadius(d(), 'x').contained)).toEqual(['a', 'b']);
    expect(ids(blastRadius(d(), 'x').atRisk)).toEqual([]);
    expect(ids(blastRadius(d(), 'y').atRisk)).toEqual(['a', 'c']);
  });

  it('moves the doubly-reachable node out of contained and into at risk', () => {
    const r = blastRadiusMulti(d(), ['x', 'y']);
    expect(ids(r.atRisk)).toEqual(['a', 'c']);
    expect(r.containedIds).toEqual(['b']);
    expect(r.containedIds).not.toContain('a');
    expect(r.contained[0]).toEqual({
      id: 'b',
      label: 'b',
      edge: 'e3',
      from: 'x',
      edgeLabel: null,
    });
  });

  it('keeps a genuinely contained node contained when both targets are async', () => {
    const only = doc({
      nodes: [node('a'), node('x'), node('y')],
      edges: [
        edge('e1', 'a', 'x', { style: 'dashed' }),
        edge('e2', 'a', 'y', { style: 'dashed' }),
      ],
    });
    const r = blastRadiusMulti(only, ['x', 'y']);
    expect(r.atRisk).toEqual([]);
    expect(r.containedIds).toEqual(['a']);
  });
});

describe('§18.11: a multi-target result says what it cannot know', () => {
  const d = () =>
    doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica')],
      edges: [edge('e1', 'app', 'pg-primary'), edge('e2', 'app', 'pg-replica')],
    });

  it('carries the redundancy caveat as data once two targets are selected', () => {
    // The two targets are replicas of each other. The document has no way to
    // say so, so the prediction is confident and slightly wrong, and the
    // result says which.
    const r = blastRadiusMulti(d(), ['pg-primary', 'pg-replica']);
    expect(ids(r.atRisk)).toEqual(['app']);
    expect(r.redundancyCaveat).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions.at(-1)).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
    expect(r.assumptions).toContain(ASSUMPTION_SYNC_ONLY);
  });

  it('does not add it to a one-target result, which is the single-target answer', () => {
    const r = blastRadiusMulti(d(), ['pg-primary']);
    expect(r.redundancyCaveat).toBeNull();
    expect(r.assumptions).toEqual(blastRadius(d(), 'pg-primary').assumptions);
  });

  it('still never says "will fail", in any field', () => {
    const r = blastRadiusMulti(d(), ['pg-primary', 'pg-replica']);
    const hits = JSON.stringify(r).match(/will fail/g) ?? [];
    // Once per per-target result plus once on the combined assumptions block:
    // every occurrence is the sentence that disowns the phrase (C3).
    expect(hits).toHaveLength(r.per.length + 1);
    expect(JSON.stringify({ atRisk: r.atRisk, contained: r.contained })).not.toContain('fail');
  });

  it('does not invent an alt field — §18.11 is specified, not built', () => {
    expect(JSON.stringify(blastRadiusMulti(d(), ['pg-primary']))).not.toContain('"alt"');
  });
});

describe('multi-target refusals are stated, never a confident zero', () => {
  it('answers an empty selection with an empty result and says so', () => {
    const d = fixture('cross-boundary-edges.json');
    const r = blastRadiusMulti(d, []);
    expect(r.targets).toEqual([]);
    expect(r.killed).toEqual([]);
    expect(r.atRisk).toEqual([]);
    expect(r.contained).toEqual([]);
    expect(r.per).toEqual([]);
    expect(r.note).toBe(
      'no targets selected — nothing to predict; name at least one runtime component or boundary',
    );
    // Empty is still an analysis: the blind spots and C2/C3 travel with it.
    expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
    expect(r.redundancyCaveat).toBeNull();
  });

  it('keeps an unknown id visible, with what to do and the ids that work', () => {
    const d = doc({
      nodes: [node('a'), node('api', { parent: 'vpc' })],
      groups: [group('vpc')],
      edges: [edge('e1', 'a', 'api')],
    });
    const r = blastRadiusMulti(d, ['api', 'ghost']);
    expect(r.resolved).toEqual(['api']);
    expect(r.unresolved).toEqual([
      { id: 'ghost', kind: 'unknown', note: 'no node or group with id "ghost"' },
    ]);
    expect(r.note).toContain('1 of 2 targets could not be killed');
    expect(r.note).toContain('no node or group with id "ghost"');
    expect(r.note).toContain('drop it from the selection');
    expect(r.validTargets).toEqual({ components: ['a', 'api'], boundaries: ['vpc'] });
    // The targets that DID resolve are still predicted for.
    expect(ids(r.atRisk)).toEqual(['a']);
  });

  it('names an entity target with the same wording the single-target path uses', () => {
    const d = fixture('mixed-erd-architecture.json');
    const r = blastRadiusMulti(d, ['invoices']);
    expect(r.resolved).toEqual([]);
    expect(r.unresolved[0]?.kind).toBe('entity');
    expect(r.unresolved[0]?.note).toBe(blastRadius(d, 'invoices').note);
    expect(r.note).toContain('no target could be killed');
    expect(r.atRisk).toEqual([]);
  });

  it('omits the roster when every target resolved', () => {
    expect(blastRadiusMulti(fixture('cross-boundary-edges.json'), ['postgres']).validTargets)
      .toBeNull();
  });
});

describe('C1/A1 hold for the multi path too', () => {
  it('predicts over a deeply frozen document without writing anything', () => {
    const d = deepFreeze(fixture('cross-boundary-edges.json'));
    const before = JSON.stringify(d);
    const r = blastRadiusMulti(d, ['postgres', 'kafka']);
    expect(r.atRisk.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).toBe(before);
  });
});
