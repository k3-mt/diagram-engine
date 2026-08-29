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
