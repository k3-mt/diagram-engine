// ERD invariants V11–V13 (spec §3.3 style, Part 13 item 2) plus the ERD
// additions to the §4.1 agent table. The exact error strings are the
// contract the agent self-corrects from, so they are asserted literally.

import { describe, expect, it } from 'vitest';
import type { GField } from '../src/index.js';
import { parseDoc, toTable, validate } from '../src/index.js';
import { doc, edge, fixtureRaw, group, node } from './helpers.js';

function entity(id: string, fields: GField[], overrides = {}) {
  return node(id, { type: 'entity', fields, ...overrides });
}

describe('V11 — duplicate field name within one entity', () => {
  it('rejects the duplicate with the exact message', () => {
    const d = doc({
      nodes: [
        entity('users', [
          { name: 'id', type: 'uuid', pk: true },
          { name: 'email', type: 'varchar(255)' },
          { name: 'email', type: 'text' },
        ]),
      ],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain(
      'entity "users" has duplicate field "email": field names must be unique within an entity; rename or remove one',
    );
  });

  it('accepts an entity whose field names are all distinct', () => {
    const d = doc({
      nodes: [
        entity('users', [
          { name: 'id', type: 'uuid', pk: true },
          { name: 'email', type: 'varchar(255)' },
          { name: 'created_at', type: 'timestamptz', nullable: true },
        ]),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('allows the same field name in two different entities', () => {
    const d = doc({
      nodes: [
        entity('users', [{ name: 'id', type: 'uuid', pk: true }]),
        entity('orders', [{ name: 'id', type: 'uuid', pk: true }]),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('allows a composite primary key (several pk fields)', () => {
    const d = doc({
      nodes: [
        entity('order-items', [
          { name: 'order_id', type: 'uuid', pk: true, fk: true },
          { name: 'product_id', type: 'uuid', pk: true, fk: true },
          { name: 'qty', type: 'int' },
        ]),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('allows an entity with no fields yet', () => {
    expect(validate(doc({ nodes: [node('users', { type: 'entity' })] }))).toEqual({
      ok: true,
    });
    expect(validate(doc({ nodes: [entity('users', [])] }))).toEqual({ ok: true });
  });
});

describe('V12 — fields only on type "entity"', () => {
  it('rejects fields on a service with the exact message', () => {
    const d = doc({
      nodes: [node('api-gateway', { type: 'service', fields: [{ name: 'id' }] })],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain(
      'node "api-gateway" has fields but type is "service": use type "entity" for tables with columns',
    );
  });

  it('names the offending type in the message', () => {
    const d = doc({
      nodes: [node('postgres', { type: 'database', fields: [{ name: 'id' }] })],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain(
      'node "postgres" has fields but type is "database": use type "entity" for tables with columns',
    );
  });

  it('allows meta on a service — meta is general-purpose detail', () => {
    const d = doc({
      nodes: [
        node('api-gateway', {
          type: 'service',
          meta: { region: 'us-east-1', runtime: 'node20' },
        }),
        node('postgres', { type: 'database', meta: { owner: 'payments' } }),
        entity('users', [{ name: 'id' }], { meta: { schema: 'public' } }),
      ],
    });
    expect(validate(d)).toEqual({ ok: true });
  });
});

describe('V13 — cardinality needs an entity endpoint', () => {
  it('rejects cardinality between two non-entities with the exact message', () => {
    const d = doc({
      nodes: [node('web-client', { type: 'client' }), node('api-gateway')],
      edges: [edge('e3', 'web-client', 'api-gateway', { cardinality: '1:N' })],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain(
      'edge "e3" has cardinality but neither "web-client" nor "api-gateway" is an entity: drop the cardinality or change an endpoint to type "entity"',
    );
  });

  it('accepts cardinality between two entities', () => {
    const d = doc({
      nodes: [
        entity('orders', [{ name: 'user_id', type: 'uuid', fk: true }]),
        entity('users', [{ name: 'id', type: 'uuid', pk: true }]),
      ],
      edges: [edge('e1', 'orders', 'users', { cardinality: 'N:1' })],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('accepts cardinality when only one endpoint is an entity', () => {
    const d = doc({
      nodes: [node('postgres', { type: 'database' }), entity('users', [{ name: 'id' }])],
      edges: [edge('e1', 'postgres', 'users', { cardinality: '1:N' })],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('accepts edges with no cardinality between non-entities', () => {
    const d = doc({
      nodes: [node('web-client', { type: 'client' }), node('api-gateway')],
      edges: [edge('e1', 'web-client', 'api-gateway')],
    });
    expect(validate(d)).toEqual({ ok: true });
  });

  it('does not pile on when the endpoint is unknown — V5 already reports it', () => {
    const d = doc({
      nodes: [entity('users', [{ name: 'id' }])],
      edges: [edge('e1', 'users', 'nope', { cardinality: '1:N' })],
    });
    const v = validate(d);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toEqual([
      'edge "e1" references unknown node "nope".',
    ]);
  });
});

describe('backward compatibility', () => {
  const VALID_FIXTURES = [
    'empty.json',
    'flat-three-nodes.json',
    'nested-two-deep.json',
    'cross-boundary-edges.json',
  ];

  for (const name of VALID_FIXTURES) {
    it(`${name} still validates`, () => {
      const parsed = parseDoc(fixtureRaw(name));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(validate(parsed.doc)).toEqual({ ok: true });
    });
  }

  it('a document with no entities and no meta renders the unchanged table', () => {
    const parsed = parseDoc(fixtureRaw('flat-three-nodes.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const table = toTable(parsed.doc);
    expect(table).toContain('### Edges (id | from -> to | label | style)');
    expect(table).not.toContain('### Entities');
    expect(table).not.toContain('### Meta');
    expect(table).not.toContain('cardinality');
  });
});

describe('toTable — ERD sections', () => {
  const erd = doc({
    title: 'Shop schema',
    groups: [group('public-schema', { label: 'public' })],
    nodes: [
      entity(
        'users',
        [
          { name: 'id', type: 'uuid', pk: true },
          { name: 'email', type: 'varchar(255)' },
          { name: 'deleted_at', type: 'timestamptz', nullable: true },
        ],
        { label: 'users', parent: 'public-schema' },
      ),
      entity(
        'orders',
        [
          { name: 'id', type: 'uuid', pk: true },
          { name: 'user_id', type: 'uuid', fk: true, note: 'cascade' },
        ],
        { label: 'orders', parent: 'public-schema', meta: { rows: '2.1M' } },
      ),
    ],
    edges: [edge('e1', 'orders', 'users', { label: 'placed by', cardinality: 'N:1' })],
  });

  it('lists each entity as one compact line', () => {
    const table = toTable(erd);
    expect(table).toContain('### Entities (id | fields)');
    expect(table).toContain(
      'users  | id:uuid PK, email:varchar(255), deleted_at:timestamptz?',
    );
    expect(table).toContain('orders | id:uuid PK, user_id:uuid FK (cascade)');
  });

  it('adds a cardinality column to the edges section only when used', () => {
    const table = toTable(erd);
    expect(table).toContain('### Edges (id | from -> to | label | style | cardinality)');
    expect(table).toContain('e1 | orders -> users | placed by | solid | N:1');
  });

  it('shows "-" for edges without cardinality once the column exists', () => {
    const d = doc({
      nodes: [entity('users', [{ name: 'id' }]), entity('orders', [{ name: 'id' }])],
      edges: [
        edge('e1', 'orders', 'users', { cardinality: 'N:1' }),
        edge('e2', 'users', 'orders', { label: 'audit' }),
      ],
    });
    expect(toTable(d)).toContain('e2 | users -> orders | audit | solid | -');
  });

  it('renders a Meta section only for nodes that have meta', () => {
    const table = toTable(erd);
    expect(table).toContain('### Meta (id | key=value)');
    expect(table).toContain('orders | rows=2.1M');
    expect(table).not.toContain('users | rows');
  });

  it('renders meta for a non-entity node too', () => {
    const d = doc({
      nodes: [
        node('api-gateway', { meta: { region: 'us-east-1', runtime: 'node20' } }),
        node('postgres', { type: 'database' }),
      ],
    });
    const table = toTable(d);
    expect(table).toContain('### Meta (id | key=value)');
    expect(table).toContain('api-gateway | region=us-east-1, runtime=node20');
    expect(table).not.toContain('### Entities');
  });

  it('omits the Entities section for an entity with no fields', () => {
    const d = doc({ nodes: [node('users', { type: 'entity' })] });
    expect(toTable(d)).not.toContain('### Entities');
  });
});
