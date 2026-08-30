// M1 Step 5 — invariants V1–V10 individually (spec §3.3).
// The exact error strings are part of the contract: the agent reads them
// and self-corrects, so these assertions are string-exact.

import { describe, expect, it } from 'vitest';
import { nearestId, validate } from '../src/index.js';
import { doc, edge, group, node } from './helpers.js';

function errorsOf(d: Parameters<typeof validate>[0]): string[] {
  const v = validate(d);
  expect(v.ok).toBe(false);
  return v.ok ? [] : v.errors;
}

describe('V1 — ids match the slug regex', () => {
  it('rejects an uppercase, spaced id with a slug suggestion', () => {
    const d = doc({ nodes: [node('web'), { ...node('web2'), id: 'Auth Service' }] });
    expect(errorsOf(d)).toContain(
      'invalid id "Auth Service": use lowercase-hyphenated, e.g. "auth-service"',
    );
  });

  it('accepts valid slugs', () => {
    const d = doc({ nodes: [node('auth-service'), node('e2e-tests'), node('a')] });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V2 — no duplicate id across nodes and groups', () => {
  it('flags a group reusing a node id', () => {
    const d = doc({
      nodes: [node('postgres')],
      groups: [group('postgres')],
    });
    expect(errorsOf(d)).toContain('duplicate id "postgres": already exists as a node');
  });

  it('flags a duplicate id across both namespaces regardless of array order', () => {
    // Nodes are scanned before groups, so the collision is always reported
    // on the group side as "already exists as a node" (the spec's example).
    const d = doc({
      groups: [group('vpc-private')],
      nodes: [node('vpc-private')],
    });
    expect(errorsOf(d)).toContain(
      'duplicate id "vpc-private": already exists as a node',
    );
  });

  it('flags a duplicate id within nodes', () => {
    const d = doc({ nodes: [node('auth'), node('auth')] });
    expect(errorsOf(d)).toContain('duplicate id "auth": already exists as a node');
  });

  it('flags a duplicate id within groups', () => {
    const d = doc({ groups: [group('vpc'), group('vpc')] });
    expect(errorsOf(d)).toContain('duplicate id "vpc": already exists as a group');
  });
});

describe('V3 — parent refers to an existing group', () => {
  it('appends the existing groups to the error', () => {
    const d = doc({
      groups: [group('vpc-private', { kind: 'vpc' }), group('region-eu', { kind: 'region' })],
      nodes: [node('cache', { parent: 'vpc' })],
    });
    expect(errorsOf(d)).toContain(
      'node "cache" has unknown parent "vpc". Existing groups: vpc-private, region-eu',
    );
  });

  it('covers group parents too', () => {
    const d = doc({
      groups: [group('vpc-private', { parent: 'region' }), group('region-eu')],
    });
    expect(errorsOf(d)).toContain(
      'group "vpc-private" has unknown parent "region". Existing groups: vpc-private, region-eu',
    );
  });

  it('renders an empty list when the doc has no groups', () => {
    // Spec gives no zero-groups variant; the suffix renders as an empty list.
    const d = doc({ nodes: [node('cache', { parent: 'vpc' })] });
    expect(errorsOf(d)).toContain('node "cache" has unknown parent "vpc". Existing groups: ');
  });
});

describe('V4 — no cycle in the group parent chain', () => {
  it('reports the cycle path', () => {
    const d = doc({
      groups: [
        group('vpc-a', { parent: 'vpc-b' }),
        group('vpc-b', { parent: 'vpc-a' }),
      ],
    });
    expect(errorsOf(d)).toContain('group cycle: vpc-a → vpc-b → vpc-a');
  });

  it('allows a legal two-deep chain', () => {
    const d = doc({
      groups: [group('region-eu'), group('vpc-private', { parent: 'region-eu' })],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V5 — edge endpoints exist', () => {
  it('suggests the nearest existing id', () => {
    const d = doc({
      nodes: [node('auth'), node('redis-cache')],
      edges: [edge('e12', 'auth', 'redis')],
    });
    expect(errorsOf(d)).toContain(
      'edge "e12" references unknown node "redis". Did you mean "redis-cache"?',
    );
  });

  it('omits the suggestion when nothing is close', () => {
    const d = doc({
      nodes: [node('auth')],
      edges: [edge('e1', 'auth', 'zzzzzzzzzzzz')],
    });
    expect(errorsOf(d)).toContain('edge "e1" references unknown node "zzzzzzzzzzzz".');
  });

  it('accepts a group id as an endpoint', () => {
    const d = doc({
      nodes: [node('auth')],
      groups: [group('vpc-private')],
      edges: [edge('e1', 'auth', 'vpc-private')],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V6 — no self-edges', () => {
  it('flags an edge connecting a node to itself', () => {
    const d = doc({ nodes: [node('auth')], edges: [edge('e12', 'auth', 'auth')] });
    expect(errorsOf(d)).toContain('edge "e12" connects "auth" to itself');
  });
});

describe('V7 — no duplicate edge (same from, to, label)', () => {
  it('flags identical from/to/label pairs', () => {
    const d = doc({
      nodes: [node('auth'), node('postgres')],
      edges: [
        edge('e1', 'auth', 'postgres', { label: 'reads' }),
        edge('e2', 'auth', 'postgres', { label: 'reads' }),
      ],
    });
    expect(errorsOf(d)).toContain('duplicate edge auth → postgres "reads"');
  });

  it('allows same endpoints with different labels', () => {
    const d = doc({
      nodes: [node('auth'), node('postgres')],
      edges: [
        edge('e1', 'auth', 'postgres', { label: 'reads' }),
        edge('e2', 'auth', 'postgres', { label: 'writes' }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V8 — at most 200 elements', () => {
  it('flags 201 elements with the total count', () => {
    const nodes = Array.from({ length: 201 }, (_, i) => node(`n-${i}`));
    const d = doc({ nodes });
    expect(errorsOf(d)).toContain(
      'graph too large (201). Remove elements or split the diagram',
    );
  });

  it('allows exactly 200 elements', () => {
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n-${i}`));
    expect(validate(doc({ nodes }))).toEqual({ ok: true });
  });
});

describe('V9 — label lengths in bounds', () => {
  it('flags a node label over 40 chars', () => {
    const label = 'x'.repeat(54);
    const d = doc({ nodes: [node('auth', { label })] });
    expect(errorsOf(d)).toContain(
      `label too long (54 chars, max 40): "${'x'.repeat(37)}..."`,
    );
  });

  it('flags a note over 60 chars', () => {
    const note = 'y'.repeat(61);
    const d = doc({ nodes: [node('auth', { note })] });
    expect(errorsOf(d)).toContain(
      `label too long (61 chars, max 60): "${'y'.repeat(37)}..."`,
    );
  });

  it('flags an edge label over 24 chars', () => {
    const label = 'z'.repeat(30);
    const d = doc({
      nodes: [node('auth'), node('postgres')],
      edges: [edge('e1', 'auth', 'postgres', { label })],
    });
    expect(errorsOf(d)).toContain(`label too long (30 chars, max 24): "${label}"`);
  });
});

describe('V10 — no edge from a group to its own descendant', () => {
  it('flags a direct child', () => {
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('postgres', { parent: 'vpc' })],
      edges: [edge('e1', 'vpc', 'postgres')],
    });
    expect(errorsOf(d)).toContain('edge from "vpc" to its child "postgres"');
  });

  it('flags a nested descendant', () => {
    const d = doc({
      groups: [group('region', { kind: 'region' }), group('vpc', { kind: 'vpc', parent: 'region' })],
      nodes: [node('postgres', { parent: 'vpc' })],
      edges: [edge('e1', 'region', 'postgres')],
    });
    expect(errorsOf(d)).toContain('edge from "region" to its child "postgres"');
  });

  it('allows the reverse direction (descendant to ancestor group)', () => {
    // Spec states V10 only for edges FROM a group TO its own descendant.
    const d = doc({
      groups: [group('vpc', { kind: 'vpc' })],
      nodes: [node('postgres', { parent: 'vpc' })],
      edges: [edge('e1', 'postgres', 'vpc')],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// M6 audit fix — the suggestion bound.
//
// Rule 11 tells the agent to trust the id in the error instead of calling
// diagram_get again, so a suggestion is not a harmless hint: a wrong one is a
// wrong edge drawn confidently. The old bound (max(3, ...)) allowed three of
// the five letters of "ghost" to differ and offered "ios".
// ---------------------------------------------------------------------------

describe('nearestId — a suggestion has to be plausible', () => {
  it('does not offer a short, unrelated id', () => {
    expect(nearestId('ghost', ['ios', 'web', 'api-gateway'])).toBeUndefined();
  });

  it('still offers a genuine typo', () => {
    expect(nearestId('redsi', ['redis', 'postgres'])).toBe('redis');
    expect(nearestId('postgress', ['postgres', 'kafka'])).toBe('postgres');
  });

  it('still offers a prefix relationship however long the tail', () => {
    expect(nearestId('redis', ['redis-cache-primary', 'postgres'])).toBe(
      'redis-cache-primary',
    );
  });
});

// ---------------------------------------------------------------------------
// M18f — the redundancy invariants (V18–V19, spec §18.11).
//
// `alt` says two edges FROM ONE SOURCE are alternatives, so both rules are
// about a set and not an edge. The error strings are the contract an agent
// self-corrects from, so these assertions are string-exact.
// ---------------------------------------------------------------------------

describe('V18 — an alt tag needs at least two alternatives', () => {
  it('flags a tag carried by only one edge from that source', () => {
    const d = doc({
      nodes: [node('orders'), node('pg-primary')],
      edges: [edge('e7', 'orders', 'pg-primary', { alt: 'db' })],
    });
    expect(errorsOf(d)).toContain(
      'edge "e7" has alt "db" but it is the only edge from "orders" with that tag: alternatives need at least two',
    );
  });

  it('accepts two edges from one source sharing a tag', () => {
    const d = doc({
      nodes: [node('orders'), node('pg-primary'), node('pg-replica')],
      edges: [
        edge('e1', 'orders', 'pg-primary', { alt: 'db' }),
        edge('e2', 'orders', 'pg-replica', { alt: 'db' }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('scopes the tag per source: the same word from another node is unrelated', () => {
    // orders has a real pair; billing has a lone "db" edge. Only billing is
    // wrong, and a global scope would have silently accepted it (§18.11).
    const d = doc({
      nodes: [node('orders'), node('billing'), node('pg-primary'), node('pg-replica')],
      edges: [
        edge('e1', 'orders', 'pg-primary', { alt: 'db' }),
        edge('e2', 'orders', 'pg-replica', { alt: 'db' }),
        edge('e3', 'billing', 'pg-primary', { alt: 'db' }),
      ],
    });
    expect(errorsOf(d)).toEqual([
      'edge "e3" has alt "db" but it is the only edge from "billing" with that tag: alternatives need at least two',
    ]);
  });

  it('flags a set whose edges all point at the SAME target', () => {
    // Two edges, one target: losing pg-primary takes both out, so the tag
    // claims a redundancy the document does not describe. Reported once, on
    // the first edge of the set, so a three-edge mistake is one correction.
    const d = doc({
      nodes: [node('orders'), node('pg-primary')],
      edges: [
        edge('e1', 'orders', 'pg-primary', { alt: 'db', label: 'reads' }),
        edge('e2', 'orders', 'pg-primary', { alt: 'db', label: 'writes' }),
      ],
    });
    expect(errorsOf(d)).toEqual([
      'edge "e1" has alt "db" but every edge from "orders" with that tag points at "pg-primary": alternatives need at least two distinct targets',
    ]);
  });

  it('accepts three alternatives, and two independent tags on one source', () => {
    const d = doc({
      nodes: [
        node('consumer'),
        node('broker-a'),
        node('broker-b'),
        node('broker-c'),
        node('cache-a'),
        node('cache-b'),
      ],
      edges: [
        edge('e1', 'consumer', 'broker-a', { alt: 'kafka' }),
        edge('e2', 'consumer', 'broker-b', { alt: 'kafka' }),
        edge('e3', 'consumer', 'broker-c', { alt: 'kafka' }),
        edge('e4', 'consumer', 'cache-a', { alt: 'redis' }),
        edge('e5', 'consumer', 'cache-b', { alt: 'redis' }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('stays quiet when an endpoint is unknown — V5 already said so', () => {
    // The V13 precedent: two errors for one mistake makes the agent fix the
    // wrong thing.
    const d = doc({
      nodes: [node('orders')],
      edges: [edge('e7', 'orders', 'ghost', { alt: 'db' })],
    });
    const errors = errorsOf(d);
    expect(errors).toEqual(['edge "e7" references unknown node "ghost".']);
  });
});

describe('V18 — a set whose members are not really alternatives', () => {
  it('rejects a boundary and something inside it as two alternatives', () => {
    // Two distinct ids, but not two alternatives: killing db-a takes out both
    // edges (an edge into a boundary is down when a participating descendant
    // is), and killing az-a takes db-a with it. The propagation is already
    // correct on this document — what was missing is the sentence saying the
    // tag bought nothing, which is V18's whole job.
    const d = doc({
      nodes: [node('app'), node('db-a', { parent: 'az-a' })],
      groups: [group('az-a')],
      edges: [
        edge('e1', 'app', 'az-a', { alt: 'db' }),
        edge('e2', 'app', 'db-a', { alt: 'db' }),
      ],
    });
    expect(errorsOf(d)).toEqual([
      'edge "e1" has alt "db" but "az-a" contains "db-a": one failure takes both out, so they are not alternatives',
    ]);
  });

  it('accepts two boundaries that do not contain each other', () => {
    const d = doc({
      nodes: [node('app'), node('db-a', { parent: 'az-a' }), node('db-b', { parent: 'az-b' })],
      groups: [group('az-a'), group('az-b')],
      edges: [
        edge('e1', 'app', 'az-a', { alt: 'zone' }),
        edge('e2', 'app', 'az-b', { alt: 'zone' }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('does not count a dashed edge towards "at least two"', () => {
    // The analysis builds its alt sets from synchronous edges only, so a
    // solid+dashed pair is a set of ONE there — the solid edge behaves as a
    // hard dependency. Counting the dashed edge here would let V18 and the
    // propagation disagree about what a set is, and would cost the agent a
    // second round trip: fix V19, re-validate, only then be told about V18.
    const d = doc({
      nodes: [node('app'), node('pg-primary'), node('kafka')],
      edges: [
        edge('e1', 'app', 'pg-primary', { alt: 'db' }),
        edge('e2', 'app', 'kafka', { alt: 'db', style: 'dashed' }),
      ],
    });
    expect(errorsOf(d)).toEqual([
      'edge "e1" has alt "db" but it is the only edge from "app" with that tag: alternatives need at least two',
      'edge "e2" is dashed and carries alt "db": asynchronous edges already contain failure; drop one',
    ]);
  });
});

describe('V19 — alt requires a synchronous edge', () => {
  it('flags a dashed edge carrying alt', () => {
    const d = doc({
      nodes: [node('orders'), node('kafka'), node('pg-primary')],
      edges: [
        edge('e9', 'orders', 'kafka', { alt: 'db', style: 'dashed' }),
        edge('e10', 'orders', 'pg-primary', { alt: 'db' }),
      ],
    });
    // BOTH corrections in one validate. A dashed edge is not a member of the
    // set the analysis builds (it filters on `sync`), so once V19 has said the
    // tag does not belong on e9, what remains is a lone alt on e10 — which is
    // exactly the meaningless tag V18 exists to catch. Reporting only V19 sent
    // the agent back for a second round trip to be told the rest.
    expect(errorsOf(d)).toEqual([
      'edge "e10" has alt "db" but it is the only edge from "orders" with that tag: alternatives need at least two',
      'edge "e9" is dashed and carries alt "db": asynchronous edges already contain failure; drop one',
    ]);
  });

  it('accepts an explicitly solid alt edge', () => {
    const d = doc({
      nodes: [node('orders'), node('pg-primary'), node('pg-replica')],
      edges: [
        edge('e1', 'orders', 'pg-primary', { alt: 'db', style: 'solid' }),
        edge('e2', 'orders', 'pg-replica', { alt: 'db', style: 'solid' }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('leaves a dashed edge with no alt alone', () => {
    const d = doc({
      nodes: [node('orders'), node('kafka')],
      edges: [edge('e9', 'orders', 'kafka', { style: 'dashed' })],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V18/V19 — additive: an untagged document is unaffected', () => {
  it('validates a document with no alt anywhere exactly as before', () => {
    const d = doc({
      nodes: [node('web'), node('api'), node('postgres')],
      edges: [edge('e1', 'web', 'api'), edge('e2', 'api', 'postgres')],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});
