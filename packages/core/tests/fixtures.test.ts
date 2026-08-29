// M1 Step 5 — the fixtures (spec §10, M1 Step 5), plus the three added for
// ERD mode and node metadata.
// The valid fixtures parse and pass validate(); the two invalid fixtures
// are intentionally parseable, schema-shaped JSON that only validate()
// (Step 3 invariants) rejects — not the JSON parser, not the zod shape check.

import { describe, expect, it } from 'vitest';
import { GraphDocSchema, parseDoc, validate } from '../src/index.js';
import { fixtureRaw } from './helpers.js';

const VALID_FIXTURES = [
  'empty.json',
  'flat-three-nodes.json',
  'nested-two-deep.json',
  'cross-boundary-edges.json',
  // ERD mode + node metadata (Part 13 item 2).
  'erd-ecommerce.json',
  'meta-rich.json',
  'mixed-erd-architecture.json',
];

describe('valid fixtures', () => {
  for (const name of VALID_FIXTURES) {
    it(`${name} parses and passes validate()`, () => {
      const result = parseDoc(fixtureRaw(name));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(validate(result.doc)).toEqual({ ok: true });
    });
  }
});

describe('invalid fixtures', () => {
  it('invalid-cyclic-groups.json is schema-shaped but fails V4', () => {
    const raw = fixtureRaw('invalid-cyclic-groups.json');
    // The JSON parser and the zod shape check must both accept it...
    expect(GraphDocSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // ...and validate() must be what rejects it.
    const v = validate(parsed.doc);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain('group cycle: vpc-a → vpc-b → vpc-a');
  });

  it('invalid-duplicate-id.json is schema-shaped but fails V2', () => {
    const raw = fixtureRaw('invalid-duplicate-id.json');
    expect(GraphDocSchema.safeParse(JSON.parse(raw)).success).toBe(true);
    const parsed = parseDoc(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const v = validate(parsed.doc);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toContain('duplicate id "postgres": already exists as a node');
  });
});
