// Schema extensions beyond the PoC spec (spec Part 13 item 2 + node metadata):
//   - the 'entity' node type and its field list (ERD mode),
//   - free-form node metadata for the viewer's hover panel,
//   - edge cardinality for crow's-foot markers.
// Every new member is OPTIONAL, so all existing documents stay valid — the
// backward-compatibility block at the bottom is the guard on that promise.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CardinalitySchema,
  GEdgeSchema,
  GNodeSchema,
  GraphDocSchema,
  MAX_FIELDS,
  MAX_META_KEYS,
  NodeTypeSchema,
  graphDocJsonSchema,
  graphPatchJsonSchema,
  PatchOpSchema,
  parseDoc,
} from '../src/index.js';
import { FIXTURES_DIR, fixtureJson, node } from './helpers.js';

function field(i: number) {
  return { name: `col_${i}`, type: 'text' };
}

describe('entity node type', () => {
  it('keeps all seven original types and adds entity', () => {
    expect(NodeTypeSchema.options).toEqual([
      'service',
      'database',
      'queue',
      'cache',
      'storage',
      'client',
      'external',
      'entity',
    ]);
  });

  it('parses an entity node with a full field list', () => {
    const parsed = GNodeSchema.safeParse({
      id: 'users',
      label: 'users',
      type: 'entity',
      parent: null,
      fields: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'org_id', type: 'uuid', fk: true, note: 'owning organisation' },
        { name: 'email', type: 'varchar(255)' },
        { name: 'deleted_at', type: 'timestamptz', nullable: true },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.fields).toHaveLength(4);
    expect(parsed.data.fields?.[0]).toEqual({ name: 'id', type: 'uuid', pk: true });
  });

  it('accepts exactly 40 fields and rejects 41', () => {
    const at = Array.from({ length: MAX_FIELDS }, (_, i) => field(i));
    expect(GNodeSchema.safeParse(node('users', { type: 'entity', fields: at })).success).toBe(
      true,
    );
    const over = GNodeSchema.safeParse(
      node('users', { type: 'entity', fields: [...at, field(MAX_FIELDS)] }),
    );
    expect(over.success).toBe(false);
    if (over.success) return;
    expect(over.error.issues[0]?.message).toContain('too many fields');
  });

  it('rejects an empty or over-long field name', () => {
    expect(
      GNodeSchema.safeParse(node('t', { type: 'entity', fields: [{ name: '' }] })).success,
    ).toBe(false);
    expect(
      GNodeSchema.safeParse(node('t', { type: 'entity', fields: [{ name: 'x'.repeat(41) }] }))
        .success,
    ).toBe(false);
    expect(
      GNodeSchema.safeParse(
        node('t', { type: 'entity', fields: [{ name: 'x', type: 'y'.repeat(25) }] }),
      ).success,
    ).toBe(false);
  });

  it('stores no geometry: fields carry meaning only', () => {
    const parsed = GNodeSchema.parse(
      node('t', { type: 'entity', fields: [{ name: 'id', type: 'uuid' }] }),
    );
    const keys = Object.keys(parsed.fields?.[0] ?? {});
    for (const banned of ['x', 'y', 'width', 'height', 'waypoint']) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe('node meta', () => {
  it('parses meta on any node type, not just entity', () => {
    const parsed = GNodeSchema.safeParse(
      node('auth', { type: 'service', meta: { owner: 'platform', sla: '99.9%', 'on-call': 'core' } }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.meta).toEqual({ owner: 'platform', sla: '99.9%', 'on-call': 'core' });
  });

  it('rejects a bad meta key', () => {
    for (const key of ['Owner', '1st', '_x', 'has space', 'a'.repeat(25), '']) {
      const r = GNodeSchema.safeParse(node('n', { meta: { [key]: 'v' } }));
      expect(r.success, `key ${JSON.stringify(key)} should be rejected`).toBe(false);
    }
  });

  it('tells the agent HOW to write a meta key, not just that it is bad (§3.3)', () => {
    // zod reports an invalid RECORD KEY as a parent issue reading
    // "Invalid key in record" and hides the remediation in issue.issues[];
    // parseDoc flattens that, or the agent could never self-correct.
    const parsed = parseDoc(
      JSON.stringify({
        schemaVersion: 1,
        title: 'T',
        direction: 'DOWN',
        nodes: [node('n', { meta: { BAD: 'v' } })],
        groups: [],
        edges: [],
        collapsed: [],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toHaveLength(1);
    const [msg] = parsed.errors;
    expect(msg).toContain('nodes.0.meta.BAD:');
    expect(msg).not.toContain('Invalid key in record');
    expect(msg).toContain('lowercase key');
    expect(msg).toContain('"owner"'); // an example of a valid key
  });

  it('enforces meta value length bounds (1–200)', () => {
    expect(GNodeSchema.safeParse(node('n', { meta: { owner: '' } })).success).toBe(false);
    expect(GNodeSchema.safeParse(node('n', { meta: { owner: 'x'.repeat(200) } })).success).toBe(
      true,
    );
    expect(GNodeSchema.safeParse(node('n', { meta: { owner: 'x'.repeat(201) } })).success).toBe(
      false,
    );
  });

  it('caps meta at 16 keys', () => {
    const entries = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    expect(GNodeSchema.safeParse(node('n', { meta: entries(MAX_META_KEYS) })).success).toBe(true);
    const over = GNodeSchema.safeParse(node('n', { meta: entries(MAX_META_KEYS + 1) }));
    expect(over.success).toBe(false);
    if (over.success) return;
    expect(over.error.issues[0]?.message).toContain('too many meta keys');
  });
});

describe('edge cardinality', () => {
  it('parses all four values', () => {
    for (const c of ['1:1', '1:N', 'N:1', 'N:M'] as const) {
      const r = GEdgeSchema.safeParse({ id: 'e1', from: 'a', to: 'b', cardinality: c });
      expect(r.success, `cardinality ${c}`).toBe(true);
      if (r.success) expect(r.data.cardinality).toBe(c);
    }
    expect(CardinalitySchema.options).toEqual(['1:1', '1:N', 'N:1', 'N:M']);
  });

  it('rejects a bogus cardinality', () => {
    expect(
      GEdgeSchema.safeParse({ id: 'e1', from: 'a', to: 'b', cardinality: '1:M' }).success,
    ).toBe(false);
    expect(
      GEdgeSchema.safeParse({ id: 'e1', from: 'a', to: 'b', cardinality: 'many' }).success,
    ).toBe(false);
  });

  it('is optional — an edge without it still parses', () => {
    expect(GEdgeSchema.safeParse({ id: 'e1', from: 'a', to: 'b' }).success).toBe(true);
  });
});

describe('patch changes pick up the new members', () => {
  it('updateNode accepts fields and meta', () => {
    const r = PatchOpSchema.safeParse({
      op: 'updateNode',
      id: 'users',
      changes: { fields: [{ name: 'id', pk: true }], meta: { owner: 'core' } },
    });
    expect(r.success).toBe(true);
  });

  it('updateNode accepts the clearing forms (REPLACE semantics)', () => {
    expect(
      PatchOpSchema.safeParse({
        op: 'updateNode',
        id: 'users',
        changes: { fields: [], meta: {} },
      }).success,
    ).toBe(true);
  });

  it('updateNode still rejects an invalid new member', () => {
    expect(
      PatchOpSchema.safeParse({
        op: 'updateNode',
        id: 'users',
        changes: { meta: { BAD: 'v' } },
      }).success,
    ).toBe(false);
  });

  it('updateEdge accepts cardinality and rejects a bogus one', () => {
    expect(
      PatchOpSchema.safeParse({ op: 'updateEdge', id: 'e1', changes: { cardinality: 'N:M' } })
        .success,
    ).toBe(true);
    expect(
      PatchOpSchema.safeParse({ op: 'updateEdge', id: 'e1', changes: { cardinality: 'N:N' } })
        .success,
    ).toBe(false);
  });

  it('addNode accepts an entity with fields', () => {
    expect(
      PatchOpSchema.safeParse({
        op: 'addNode',
        node: node('users', { type: 'entity', fields: [{ name: 'id', type: 'uuid', pk: true }] }),
      }).success,
    ).toBe(true);
  });
});

describe('generated JSON Schema', () => {
  const doc = graphDocJsonSchema();
  const patch = graphPatchJsonSchema();

  it('is JSON-serializable', () => {
    expect(() => JSON.parse(JSON.stringify(doc))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(patch))).not.toThrow();
  });

  it('carries entity, fields, meta and cardinality', () => {
    for (const schema of [doc, patch]) {
      const text = JSON.stringify(schema);
      expect(text).toContain('"entity"');
      expect(text).toContain('"fields"');
      expect(text).toContain('"meta"');
      expect(text).toContain('"cardinality"');
      for (const c of ['1:1', '1:N', 'N:1', 'N:M']) expect(text).toContain(`"${c}"`);
    }
  });

  it('states the fields and meta caps declaratively', () => {
    const nodeItems = (doc as any).properties.nodes.items;
    expect(nodeItems.properties.fields.maxItems).toBe(MAX_FIELDS);
    expect(nodeItems.properties.meta.maxProperties).toBe(MAX_META_KEYS);
    expect(nodeItems.properties.meta.propertyNames.pattern).toBe('^[a-z][a-z0-9_-]{0,23}$');
    expect((doc as any).properties.edges.items.properties.cardinality.enum).toEqual([
      '1:1',
      '1:N',
      'N:1',
      'N:M',
    ]);
  });

  it('keeps the seven original node types', () => {
    const text = JSON.stringify(doc);
    for (const t of [
      'service',
      'database',
      'queue',
      'cache',
      'storage',
      'client',
      'external',
    ]) {
      expect(text).toContain(`"${t}"`);
    }
  });
});

describe('backward compatibility', () => {
  const names = fs
    .readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort();

  it('finds the fixtures', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`${name} still parses unchanged against the extended schema`, () => {
      const raw = fixtureJson(name);
      const parsed = GraphDocSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      // Round-trip: the extended schema adds nothing to an existing document.
      expect(parsed.data).toEqual(raw);
      expect(JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'))).toEqual(raw);
    });
  }
});
