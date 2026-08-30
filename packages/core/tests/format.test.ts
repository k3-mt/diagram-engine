// M1 Step 5 — format/: the §4.1 compact table and the summary one-liner.

import { describe, expect, it } from 'vitest';
import { parseDoc, summarise, toTable } from '../src/index.js';
import { doc, edge, fixtureRaw, group, node } from './helpers.js';

describe('toTable (spec §4.1)', () => {
  it('renders the flat-three-nodes fixture in the §4.1 shape', () => {
    const parsed = parseDoc(fixtureRaw('flat-three-nodes.json'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(toTable(parsed.doc)).toBe(
      [
        '## "Checkout platform"  (direction: DOWN)',
        '',
        '### Groups (id | kind | label | parent)',
        '',
        '### Nodes (id | type | label | parent)',
        'web-client  | client   | Web Client  | -',
        'api-gateway | service  | API Gateway | -',
        'postgres    | database | Postgres    | -',
        '',
        '### Edges (id | from -> to | label | style)',
        'e1 | web-client -> api-gateway | https | solid',
        'e2 | api-gateway -> postgres   | reads | solid',
      ].join('\n'),
    );
  });

  it('renders groups with their kind and parent, "-" for root', () => {
    const d = doc({
      title: 'Grouped',
      groups: [
        group('region-eu', { kind: 'region', label: 'eu-west-1' }),
        group('vpc-private', { kind: 'vpc', label: 'Private VPC', parent: 'region-eu' }),
      ],
      nodes: [node('postgres', { type: 'database', label: 'Postgres', parent: 'vpc-private' })],
    });
    const table = toTable(d);
    expect(table).toContain('## "Grouped"  (direction: DOWN)');
    expect(table).toContain('region-eu   | region | eu-west-1   | -');
    expect(table).toContain('vpc-private | vpc    | Private VPC | region-eu');
    expect(table).toContain('postgres | database | Postgres | vpc-private');
  });

  it('shows "-" for a missing edge label and defaults style to solid', () => {
    const d = doc({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
    });
    expect(toTable(d)).toContain('e1 | a -> b | - | solid');
  });
});

// ---------------------------------------------------------------------------
// §18.11 — the alt column
// ---------------------------------------------------------------------------

describe('toTable — alt (spec §18.11)', () => {
  /** app depends on EITHER replica; nothing else in the document says `alt`. */
  const replicated = doc({
    title: 'HA',
    nodes: [node('app'), node('pg-primary'), node('pg-replica'), node('redis')],
    edges: [
      edge('e1', 'app', 'pg-primary', { alt: 'db' }),
      edge('e2', 'app', 'pg-replica', { alt: 'db' }),
      edge('e3', 'app', 'redis'),
    ],
  });

  it('adds an alt column to the edges section only when used', () => {
    const table = toTable(replicated);
    expect(table).toContain('### Edges (id | from -> to | label | style | alt)');
    expect(table).toContain('e1 | app -> pg-primary | - | solid | db');
    expect(table).toContain('e2 | app -> pg-replica | - | solid | db');
  });

  it('shows "-" for an untagged edge once the column exists — a hard dependency', () => {
    // The whole point of the column: `-` is not decoration, it is the
    // statement that e3 is a HARD dependency while e1 and e2 are alternatives.
    expect(toTable(replicated)).toContain('e3 | app -> redis      | - | solid | -');
  });

  it('costs an architecture-only document nothing (§4.1)', () => {
    const bare = doc({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b')],
    });
    const table = toTable(bare);
    expect(table).toContain('### Edges (id | from -> to | label | style)');
    expect(table).not.toContain('alt');
  });

  it('sits after cardinality, so an ERD column order never depends on alt', () => {
    const both = doc({
      nodes: [node('a'), node('b')],
      edges: [edge('e1', 'a', 'b', { cardinality: '1:N', alt: 'db' })],
    });
    expect(toTable(both)).toContain(
      '### Edges (id | from -> to | label | style | cardinality | alt)',
    );
    expect(toTable(both)).toContain('e1 | a -> b | - | solid | 1:N | db');
  });
});

describe('summarise', () => {
  const base = doc({
    nodes: [node('a'), node('b')],
    groups: [group('g1')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')],
  });

  it('produces the compact signed-count one-liner', () => {
    const after = doc({
      nodes: [node('a'), node('b'), node('c'), node('d'), node('e')],
      groups: [group('g1'), group('g2')],
      edges: [],
    });
    expect(summarise(base, after)).toBe('+3 nodes, +1 group, -2 edges');
  });

  it('uses singular nouns for a count of one', () => {
    const after = doc({ ...structuredClone(base), nodes: [...base.nodes, node('c')] });
    expect(summarise(base, after)).toBe('+1 node');
  });

  it('says "updated" when only properties changed', () => {
    const after = structuredClone(base);
    after.nodes[0]!.label = 'renamed';
    expect(summarise(base, after)).toBe('updated');
  });

  it('says "no changes" for identical documents', () => {
    expect(summarise(base, structuredClone(base))).toBe('no changes');
  });
});
