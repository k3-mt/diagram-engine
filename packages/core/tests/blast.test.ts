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
  ASSUMPTION_PARTIAL_REDUNDANCY,
  ASSUMPTION_SYNC_ONLY,
  articulationIndexOf,
  backlog,
  blastRadius,
  blastRadiusMulti,
  blastRadiusOn,
  hasAlternatives,
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

  it('adds it to a one-target result too, which is still the single-target answer', () => {
    // It USED to be multi-only, on the reading that the union is the shape
    // §18.7 warns about. But the over-report belongs to the document's
    // untagged edges, not to the combination, so it is as true of one target
    // as of five — and multi-only left the viewer silent on a single click
    // while the CLI caveated every prediction: two surfaces, two honesty
    // claims, one document. It comes from core either way, so a one-id
    // combined result is still exactly the single-target answer.
    const r = blastRadiusMulti(d(), ['pg-primary']);
    expect(r.redundancyCaveat).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions).toEqual(blastRadius(d(), 'pg-primary').assumptions);
    expect(r.assumptions).toContain(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions.filter((a) => a === ASSUMPTION_NO_REDUNDANCY)).toHaveLength(1);
  });

  it('still never says "will fail", in any field', () => {
    const r = blastRadiusMulti(d(), ['pg-primary', 'pg-replica']);
    const hits = JSON.stringify(r).match(/will fail/g) ?? [];
    // Once per per-target result plus once on the combined assumptions block:
    // every occurrence is the sentence that disowns the phrase (C3).
    expect(hits).toHaveLength(r.per.length + 1);
    expect(JSON.stringify({ atRisk: r.atRisk, contained: r.contained })).not.toContain('fail');
  });

  it('reports nodes and edge ids, never an edge tag (M18f kept it that way)', () => {
    // §18.11 is built now, and the RESULT surface still carries no `alt`
    // field: an alt set is an input to propagation, and a caller that could
    // read a tag off a result would start re-deriving redundancy from it.
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

// ---------------------------------------------------------------------------
// M18f — redundancy (§18.11). Edges from ONE source sharing an `alt` tag are
// ALTERNATIVES: failure reaches the source only when every one of them is
// unavailable, where unavailable means killed OR at risk.
//
// Every expectation below is hand-computed, because the interesting cases are
// exactly the ones a plausible implementation gets wrong quietly.
// ---------------------------------------------------------------------------

describe('§18.11: an alt set is one dependency, not several', () => {
  /**
   *   x → a  (alt "db")     a → c
   *   x → b  (alt "db")     b → c
   */
  const fixpointDoc = () =>
    doc({
      nodes: [node('x'), node('a'), node('b'), node('c')],
      edges: [
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e2', 'x', 'b', { alt: 'db' }),
        edge('e3', 'a', 'c'),
        edge('e4', 'b', 'c'),
      ],
    });

  it('THE FIXPOINT CASE: both alternatives fail through a shared dependency', () => {
    // Kill c. a is at risk (hard, depth 1); b is at risk (hard, depth 1);
    // so EVERY edge in x's "db" set is unavailable and x is at risk too
    // (depth 2). A single reverse-BFS reaches a, tries x, finds b not yet
    // marked and spares x — the answer would depend on visit order.
    const r = blastRadius(fixpointDoc(), 'c');
    expect(r.atRisk.map((n) => [n.id, n.depth, n.via])).toEqual([
      ['a', 1, 'e3'],
      ['b', 1, 'e4'],
      ['x', 2, 'e1'],
    ]);
  });

  it('gives the same answer whichever alternative the walk happens to meet first', () => {
    // The same document with the two alt edges written in the other order.
    // A visit-order-dependent implementation flips its answer here.
    const flipped = doc({
      nodes: [node('x'), node('a'), node('b'), node('c')],
      edges: [
        edge('e2', 'x', 'b', { alt: 'db' }),
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e4', 'b', 'c'),
        edge('e3', 'a', 'c'),
      ],
    });
    expect(ids(blastRadius(flipped, 'c').atRisk)).toEqual(['a', 'b', 'x']);
  });

  it('ONE LIVE ALTERNATIVE SPARES THE SOURCE: killing a leaves x alone', () => {
    const r = blastRadius(fixpointDoc(), 'a');
    expect(r.killed).toEqual(['a']);
    expect(r.atRisk).toEqual([]);
    // ...and b is not reported as anything odd: it is neither at risk nor
    // contained. It is simply the alternative that is still up.
    expect(r.contained).toEqual([]);
    expect(r.atRisk.concat(r.contained as never[]).map((n) => n.id)).not.toContain('b');
  });

  it('propagates onward once the set IS exhausted', () => {
    // y depends on x hard, so y follows x into the radius at depth 3.
    const d = doc({
      nodes: [node('y'), node('x'), node('a'), node('b'), node('c')],
      edges: [
        edge('e0', 'y', 'x'),
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e2', 'x', 'b', { alt: 'db' }),
        edge('e3', 'a', 'c'),
        edge('e4', 'b', 'c'),
      ],
    });
    expect(blastRadius(d, 'c').atRisk.map((n) => [n.id, n.depth])).toEqual([
      ['a', 1],
      ['b', 1],
      ['x', 2],
      ['y', 3],
    ]);
  });

  it('a hard dependency still kills the source whatever the alt set is doing', () => {
    // x has BOTH an alt set (a, b — untouched, both up) and an ordinary hard
    // dependency on h. Redundancy elsewhere is not a licence to survive h.
    const d = doc({
      nodes: [node('x'), node('h'), node('a'), node('b')],
      edges: [
        edge('e1', 'x', 'h'),
        edge('e2', 'x', 'a', { alt: 'db' }),
        edge('e3', 'x', 'b', { alt: 'db' }),
      ],
    });
    const r = blastRadius(d, 'h');
    expect(r.atRisk.map((n) => [n.id, n.depth, n.via])).toEqual([['x', 1, 'e1']]);
    // and the alt set is genuinely independent of that: losing one of the two
    // alternatives still spares x.
    expect(blastRadius(d, 'a').atRisk).toEqual([]);
  });

  it('satisfies two independent alt tags on one source separately', () => {
    const d = doc({
      nodes: [node('src'), node('a1'), node('a2'), node('b1'), node('b2')],
      edges: [
        edge('e1', 'src', 'a1', { alt: 'p' }),
        edge('e2', 'src', 'a2', { alt: 'p' }),
        edge('e3', 'src', 'b1', { alt: 'q' }),
        edge('e4', 'src', 'b2', { alt: 'q' }),
      ],
    });
    // One from each set: both sets still have a live member. src survives.
    expect(blastRadiusMulti(d, ['a1', 'b1']).atRisk).toEqual([]);
    // Both of one set: THAT set is exhausted, and one exhausted set is enough.
    expect(ids(blastRadiusMulti(d, ['a1', 'a2']).atRisk)).toEqual(['src']);
    expect(ids(blastRadiusMulti(d, ['b1', 'b2']).atRisk)).toEqual(['src']);
    // Three alternatives, one alt tag: two deaths are survivable.
    const three = doc({
      nodes: [node('src'), node('k1'), node('k2'), node('k3')],
      edges: [
        edge('e1', 'src', 'k1', { alt: 'kafka' }),
        edge('e2', 'src', 'k2', { alt: 'kafka' }),
        edge('e3', 'src', 'k3', { alt: 'kafka' }),
      ],
    });
    expect(blastRadiusMulti(three, ['k1', 'k2']).atRisk).toEqual([]);
    expect(ids(blastRadiusMulti(three, ['k1', 'k2', 'k3']).atRisk)).toEqual(['src']);
  });

  it('names the LAST alternative to fall as `via`, at the depth it fell', () => {
    // x's "db" set is {a, b}. a is already gone at depth 1 (killed target's
    // direct dependent), b only at depth 2 — so x is endangered at depth 3,
    // and the edge to blame is the one that was still holding it up.
    //
    //   x → a (alt db)   x → b (alt db)   a → dead   b → mid   mid → dead
    const d = doc({
      nodes: [node('x'), node('a'), node('b'), node('mid'), node('dead')],
      edges: [
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e2', 'x', 'b', { alt: 'db' }),
        edge('e3', 'a', 'dead'),
        edge('e4', 'b', 'mid'),
        edge('e5', 'mid', 'dead'),
      ],
    });
    const r = blastRadius(d, 'dead');
    expect(r.atRisk.map((n) => [n.id, n.depth, n.via])).toEqual([
      ['a', 1, 'e3'],
      ['mid', 1, 'e5'],
      ['b', 2, 'e4'],
      ['x', 3, 'e2'],
    ]);
  });

  it('counts an alternative that is a BOUNDARY once, however much it contains', () => {
    // x depends on either availability zone. Each zone holds two components,
    // and an edge into a boundary reaches everything inside it — so killing
    // one zone marks that ONE edge down, not one per component. Counting per
    // component would exhaust a two-member set on a single zone outage: the
    // exact false-negative-turned-false-positive this test exists to catch.
    const d = doc({
      nodes: [
        node('x'),
        node('a1', { parent: 'az-a' }),
        node('a2', { parent: 'az-a' }),
        node('b1', { parent: 'az-b' }),
        node('b2', { parent: 'az-b' }),
      ],
      groups: [group('az-a'), group('az-b')],
      edges: [
        edge('e1', 'x', 'az-a', { alt: 'az' }),
        edge('e2', 'x', 'az-b', { alt: 'az' }),
      ],
    });
    const one = blastRadius(d, 'az-a');
    expect(one.killed).toEqual(['az-a', 'a1', 'a2']);
    expect(one.atRisk).toEqual([]); // the other zone is up
    const both = blastRadiusMulti(d, ['az-a', 'az-b']);
    expect(ids(both.atRisk)).toEqual(['x']);
  });

  it('ignores a DASHED alt edge: it neither joins a set nor keeps one alive', () => {
    // V19 forbids this document, and analysis never assumes validation ran.
    // An async path already stops propagation (§18.3), so the surviving
    // synchronous alternative is the whole set — and losing it is a loss.
    const d = doc({
      nodes: [node('x'), node('a'), node('b')],
      edges: [
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e2', 'x', 'b', { alt: 'db', style: 'dashed' }),
      ],
    });
    expect(blastRadius(d, 'a').atRisk.map((n) => [n.id, n.via])).toEqual([['x', 'e1']]);
  });

  it('leaves a document with no alt tag bit-identical to the pre-§18.11 answer', () => {
    // The additive claim, asserted rather than assumed: two untagged edges to
    // two replicas are still two hard dependencies, and either one kills.
    const d = doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica')],
      edges: [edge('e1', 'app', 'pg-primary'), edge('e2', 'app', 'pg-replica')],
    });
    expect(blastRadius(d, 'pg-primary').atRisk.map((n) => [n.id, n.depth, n.via])).toEqual([
      ['app', 1, 'e1'],
    ]);
  });
});

describe('§18.11: multi-select honours alternatives identically', () => {
  const d = () =>
    doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica')],
      edges: [
        edge('e1', 'app', 'pg-primary', { alt: 'pg' }),
        edge('e2', 'app', 'pg-replica', { alt: 'pg' }),
      ],
    });

  it('reports nothing at risk for one replica and the app for both', () => {
    // This is the §18.7 scenario the caveat was written for, now answered:
    // "you toggle off two replicas, see a large at-risk set, and get no
    // signal that losing the first one alone was survivable."
    expect(blastRadiusMulti(d(), ['pg-primary']).atRisk).toEqual([]);
    const both = blastRadiusMulti(d(), ['pg-primary', 'pg-replica']);
    expect(both.atRisk.map((n) => [n.id, n.depth, n.via])).toEqual([['app', 1, 'e1']]);
    // Each PER-TARGET result is the single-target answer, unchanged: neither
    // replica alone endangers the app.
    expect(both.per.map((r) => r.atRisk)).toEqual([[], []]);
  });

  it('agrees with the single-target function on every target', () => {
    // blastRadiusMultiOn shares propagate(), so alternatives come free —
    // asserted rather than assumed.
    const one = blastRadiusMulti(d(), ['pg-primary']);
    expect(one.atRisk).toEqual(blastRadius(d(), 'pg-primary').atRisk);
    expect(one.contained).toEqual(blastRadius(d(), 'pg-primary').contained);
  });

  it('carries the exhausted set through the fixpoint under multi-select too', () => {
    const fix = doc({
      nodes: [node('x'), node('a'), node('b'), node('c1'), node('c2')],
      edges: [
        edge('e1', 'x', 'a', { alt: 'db' }),
        edge('e2', 'x', 'b', { alt: 'db' }),
        edge('e3', 'a', 'c1'),
        edge('e4', 'b', 'c2'),
      ],
    });
    // Killing c1 alone: a falls, b holds, x survives.
    expect(ids(blastRadius(fix, 'c1').atRisk)).toEqual(['a']);
    // Killing both: a and b fall at depth 1, so x falls at depth 2.
    const r = blastRadiusMulti(fix, ['c1', 'c2']);
    expect(r.atRisk.map((n) => [n.id, n.depth])).toEqual([
      ['a', 1],
      ['b', 1],
      ['x', 2],
    ]);
  });
});

describe('§18.11: the caveat narrows once the document states redundancy', () => {
  const bare = () =>
    doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica')],
      edges: [edge('e1', 'app', 'pg-primary'), edge('e2', 'app', 'pg-replica')],
    });
  const tagged = () =>
    doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica')],
      edges: [
        edge('e1', 'app', 'pg-primary', { alt: 'pg' }),
        edge('e2', 'app', 'pg-replica', { alt: 'pg' }),
      ],
    });

  it('says the model cannot express redundancy when no edge carries alt', () => {
    const r = blastRadiusMulti(bare(), ['pg-primary', 'pg-replica']);
    expect(r.redundancyCaveat).toBe(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions.at(-1)).toBe(ASSUMPTION_NO_REDUNDANCY);
  });

  it('says the untagged edges are the unknown once redundancy IS expressed', () => {
    // The old sentence would now be false for the edges carrying alt, and
    // still true for the ones that do not. It narrows rather than disappears:
    // rule 14 says redundancy is told, not deduced, so an untagged edge means
    // nobody said — not that nothing is redundant.
    const r = blastRadiusMulti(tagged(), ['pg-primary', 'pg-replica']);
    expect(r.redundancyCaveat).toBe(ASSUMPTION_PARTIAL_REDUNDANCY);
    expect(r.assumptions.at(-1)).toBe(ASSUMPTION_PARTIAL_REDUNDANCY);
    expect(r.assumptions).not.toContain(ASSUMPTION_NO_REDUNDANCY);
    expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
    expect(r.assumptions).toContain(ASSUMPTION_SYNC_ONLY);
  });

  it('is a property of the DOCUMENT, not of the selection', () => {
    // Selecting two nodes that carry no alt themselves, in a document that
    // expresses redundancy elsewhere, still gets the narrowed wording: the
    // claim is about which edges the traversal could and could not reason
    // about, and it traversed the whole graph.
    const mixed = doc({
      nodes: [node('app'), node('pg-primary'), node('pg-replica'), node('mail'), node('sms')],
      edges: [
        edge('e1', 'app', 'pg-primary', { alt: 'pg' }),
        edge('e2', 'app', 'pg-replica', { alt: 'pg' }),
        edge('e3', 'app', 'mail'),
        edge('e4', 'app', 'sms'),
      ],
    });
    expect(blastRadiusMulti(mixed, ['mail', 'sms']).redundancyCaveat).toBe(
      ASSUMPTION_PARTIAL_REDUNDANCY,
    );
    // hasAlternatives() is the one predicate behind that, so a surface never
    // has to re-derive it from the document.
    expect(hasAlternatives(runtimeGraph(mixed))).toBe(true);
    expect(hasAlternatives(runtimeGraph(bare()))).toBe(false);
  });

  it('caveats a one-target result too, with the wording that fits the document', () => {
    expect(blastRadiusMulti(tagged(), ['pg-primary']).redundancyCaveat).toBe(
      ASSUMPTION_PARTIAL_REDUNDANCY,
    );
    expect(blastRadiusMulti(bare(), ['pg-primary']).redundancyCaveat).toBe(
      ASSUMPTION_NO_REDUNDANCY,
    );
    // and the single-target entry point says the same thing, so no surface
    // has to decide which sentence is true of the document.
    expect(blastRadius(tagged(), 'pg-primary').assumptions).toContain(
      ASSUMPTION_PARTIAL_REDUNDANCY,
    );
    expect(blastRadius(bare(), 'pg-primary').assumptions).toContain(ASSUMPTION_NO_REDUNDANCY);
  });

  it('says nothing about redundancy when no target resolved — no prediction to caveat', () => {
    expect(blastRadiusMulti(bare(), []).redundancyCaveat).toBeNull();
    expect(blastRadiusMulti(bare(), []).assumptions).not.toContain(ASSUMPTION_NO_REDUNDANCY);
  });

  it('still never says "will fail" (C3 is untouched by any of this)', () => {
    const r = blastRadiusMulti(tagged(), ['pg-primary', 'pg-replica']);
    expect(JSON.stringify(r)).not.toContain('will fail: no');
    expect(r.assumptions).toContain(ASSUMPTION_AT_RISK);
  });
});

describe('§18.11: the fixpoint stays linear inside the backlog', () => {
  it('ranks a 200-element document full of alt sets inside the §15.2 budget', () => {
    // The fixpoint runs once per backlog candidate, so a re-scan-until-stable
    // implementation would be O(n) passes per candidate on top of the sweep
    // that already had to be optimised once. Counters keep it O(V+E): every
    // edge is marked down at most once per propagation.
    //
    // 66 sources, each with a 2-member alt set, chained so that killing the
    // deepest leaf cascades the whole way up — the worst case for the
    // fixpoint, since every set is exhausted in turn.
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 66; i += 1) {
      nodes.push(node(`s${i}`), node(`a${i}`), node(`b${i}`));
      edges.push(
        edge(`ea${i}`, `s${i}`, `a${i}`, { alt: 'r' }),
        edge(`eb${i}`, `s${i}`, `b${i}`, { alt: 'r' }),
      );
      if (i > 0) {
        edges.push(edge(`ca${i}`, `a${i - 1}`, `s${i}`), edge(`cb${i}`, `b${i - 1}`, `s${i}`));
      }
    }
    const d = doc({ nodes, edges });
    const started = Date.now();
    const ranked = backlog(d);
    const elapsed = Date.now() - started;
    expect(ranked).toHaveLength(nodes.length - runtimeGraph(d).entryPoints.length);
    // The whole cascade really does happen — this is not a fast answer to an
    // easy question: killing the deepest PAIR exhausts s65's set, which
    // exhausts s64's, all the way to the top (196 of the 198 nodes), while
    // killing one of the pair costs nothing at all.
    const cascade = blastRadiusMulti(d, ['a65', 'b65']);
    expect(cascade.atRisk).toHaveLength(196);
    expect(blastRadius(d, 'a65').atRisk).toEqual([]);
    // THE WAVES, not just the clock. The cascade is one alt set per wave all
    // the way up, so the deepest at-risk node sits ~3 waves per rung above the
    // kill; asserting the depth pins the propagation SHAPE, which a wall-clock
    // budget on a fast machine would not. A re-scan-until-stable fixpoint
    // would produce the same set and do |V| times the work — and would show up
    // here first as changed depths, not as a slower test.
    expect(Math.max(...cascade.atRisk.map((a) => a.depth))).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(500);
  });

  it('does not re-run the articulation sweep for every prediction on one projection', () => {
    // articulationPoints() is the deliberately naive O(n·(n+e)) sweep §15.2
    // asks for: the right trade once, the wrong one n+1 times. backlog() hands
    // its index down, but a caller making many single-target predictions over
    // one projection used to pay the whole sweep per call — ~10ms each at the
    // 200-element cap, against a sub-millisecond budget, on a prediction an
    // agent runs mid-turn. It is a pure function of the projection, so it is
    // memoised against it.
    const nodes = [];
    const edges = [];
    for (let i = 0; i < 200; i += 1) {
      nodes.push(node(`n${i}`));
      if (i > 0) edges.push(edge(`e${i}`, `n${i - 1}`, `n${i}`));
    }
    const g = runtimeGraph(doc({ nodes, edges }));
    const started = Date.now();
    for (const n of nodes) blastRadiusOn(g, n.id);
    expect(Date.now() - started).toBeLessThan(500);
    // and the answer is the same one the precomputed index gives
    const index = articulationIndexOf(g);
    expect(blastRadiusOn(g, 'n100')).toEqual(blastRadiusOn(g, 'n100', index));
  });
});

// ---------------------------------------------------------------------------
// `spared` — the absence §18.11 exists to name (analysis, not a surface).
//
// A spared node is the difference between this prediction and the one the same
// document produced before the redundancy was stated, and it is invisible
// unless it is named: it simply does not appear in `atRisk`, which is what a
// WRONG answer looks like too. It was briefly computed in the CLI, which is
// how the viewer came to have no spared row at all; it lives here now so both
// surfaces read one derivation.
// ---------------------------------------------------------------------------
describe('§18.11: what an alternative held up is named, not left as an absence', () => {
  const replicated = () =>
    doc({
      nodes: [
        node('web'),
        node('app'),
        node('pg-primary', { type: 'database' }),
        node('pg-replica', { type: 'database' }),
        node('redis', { type: 'cache' }),
      ],
      edges: [
        edge('e0', 'web', 'app'),
        edge('e1', 'app', 'pg-primary', { alt: 'db' }),
        edge('e2', 'app', 'pg-replica', { alt: 'db' }),
        edge('e3', 'app', 'redis'),
      ],
    });

  it('names the spared node, the tag, what fell and what still stands', () => {
    const r = blastRadius(replicated(), 'pg-primary');
    expect(r.atRisk).toEqual([]);
    expect(r.spared).toEqual([
      {
        id: 'app',
        label: 'app',
        tag: 'db',
        lost: [{ target: 'pg-primary', downInside: null }],
        live: ['pg-replica'],
      },
    ]);
  });

  it('says nothing was spared when the dependency was hard', () => {
    expect(blastRadius(replicated(), 'redis').spared).toEqual([]);
    expect(blastRadius(replicated(), 'redis').atRisk.map((a) => a.id)).toEqual(['app', 'web']);
  });

  it('says nothing was spared once every alternative has fallen', () => {
    // The source is at risk, and `via` already names the last one to fall.
    const r = blastRadiusMulti(replicated(), ['pg-primary', 'pg-replica']);
    expect(r.atRisk.map((a) => a.id)).toEqual(['app', 'web']);
    expect(r.spared).toEqual([]);
  });

  it('is computed over the WHOLE selection, not merged from the per-target answers', () => {
    // Each target on its own spares app; together they exhaust the set. A
    // merge of the per-target answers would report app as both at risk and
    // spared — the one contradiction this field could produce.
    const r = blastRadiusMulti(replicated(), ['pg-primary', 'pg-replica']);
    expect(r.per[0]!.spared.map((s) => s.id)).toEqual(['app']);
    expect(r.per[1]!.spared.map((s) => s.id)).toEqual(['app']);
    expect(r.spared).toEqual([]);
    expect(r.atRisk.map((a) => a.id)).toContain('app');
  });

  it('a one-id combined result is still exactly the single-target answer', () => {
    expect(blastRadiusMulti(replicated(), ['pg-primary']).spared).toEqual(
      blastRadius(replicated(), 'pg-primary').spared,
    );
  });

  it('names what actually went down inside an intact boundary', () => {
    // The edge names the GROUP (§3.1). Killing one service inside az-a takes
    // that path out, but az-a itself is untouched: "lost az-a" alone would
    // render the internal edge-is-down state as an AZ outage.
    const zones = doc({
      nodes: [
        node('app'),
        node('worker-a', { parent: 'az-a' }),
        node('worker-b', { parent: 'az-b' }),
      ],
      groups: [group('az-a'), group('az-b')],
      edges: [
        edge('e1', 'app', 'az-a', { alt: 'zone' }),
        edge('e2', 'app', 'az-b', { alt: 'zone' }),
      ],
    });
    expect(blastRadius(zones, 'worker-a').spared).toEqual([
      {
        id: 'app',
        label: 'app',
        tag: 'zone',
        lost: [{ target: 'az-a', downInside: 'worker-a' }],
        live: ['az-b'],
      },
    ]);
    // and when the boundary itself is the target, it is the boundary that fell
    expect(blastRadius(zones, 'az-a').spared[0]!.lost).toEqual([
      { target: 'az-a', downInside: null },
    ]);
  });

  it('is empty for every document that carries no alt', () => {
    const bare = doc({
      nodes: [node('app'), node('pg')],
      edges: [edge('e1', 'app', 'pg')],
    });
    expect(blastRadius(bare, 'pg').spared).toEqual([]);
  });
});
