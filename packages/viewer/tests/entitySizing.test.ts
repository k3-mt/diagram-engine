// entitySizing.test.ts — sizing of ERD `entity` nodes (spec §5.1 extended,
// Part 13 item 2).
//
// Two contracts are locked down here:
//  1. An `entity` WITH fields is sized as a table: header + one row per
//     field + bottom padding, width clamped into [NODE.minW, ENTITY.maxW].
//  2. Nothing else moved. Every one of the seven original node types is
//     asserted at an EXACT width and height, so any drift in the box
//     sizing (or in the deterministic Node text estimate behind it) fails
//     loudly here rather than quietly reflowing every diagram.
//
// The last test runs a real elkjs layout of an ERD document and checks
// the resulting rects do not overlap — proof that the taller boxes flow
// through toElk into ELK correctly.

import { describe, expect, it } from 'vitest';
import type { GNode, GraphDoc, NodeType } from '@diagram-engine/core';
import {
  ACCENT_W,
  ENTITY,
  ENTITY_FIELD_FONT,
  LABEL_FONT,
  NODE,
  badgeWidth,
  fieldRowWidth,
  measureText,
  sizeNode,
} from '../src/layout/measure.js';
import { layout } from '../src/layout/runLayout.js';
import type { Rect } from '../src/layout/fromElk.js';

/** A node with sane defaults; override what the test cares about. */
function node(over: Partial<GNode> & Pick<GNode, 'id' | 'type'>): GNode {
  return { label: 'Label', parent: null, ...over } as GNode;
}

/** Fields named f0..fN-1, each with a short type. */
function fields(n: number): NonNullable<GNode['fields']> {
  return Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: 'uuid' }));
}

// ---------------------------------------------------------------------------
// 1. The seven non-entity types are unchanged, to the pixel.

const PLAIN_TYPES: NodeType[] = [
  'service',
  'database',
  'queue',
  'cache',
  'storage',
  'client',
  'external',
];

describe('non-entity nodes keep the §5.1 box exactly', () => {
  it.each(PLAIN_TYPES)('%s: short label clamps to the minimum width', (type) => {
    // "Api" measures well under the minimum, so the clamp floor applies.
    expect(sizeNode(node({ id: 'n', type, label: 'Api' }))).toEqual({
      width: 150,
      height: 60,
    });
  });

  it.each(PLAIN_TYPES)('%s: a note makes the box 76 tall, not wider', (type) => {
    expect(
      sizeNode(node({ id: 'n', type, label: 'Api', note: 'a note' })),
    ).toEqual({ width: 150, height: 60 + 16 });
  });

  it.each(PLAIN_TYPES)('%s: a long label clamps to the maximum width', (type) => {
    expect(
      sizeNode(
        node({
          id: 'n',
          type,
          label: 'An extremely long node label that overflows',
        }),
      ),
    ).toEqual({ width: 260, height: 60 });
  });

  it('sizes an intermediate label to measured text + padding + icon', () => {
    const label = 'Payments Service';
    const expected = measureText(label, LABEL_FONT) + NODE.padX * 2 + NODE.iconW;
    expect(expected).toBeGreaterThan(NODE.minW);
    expect(expected).toBeLessThan(NODE.maxW);
    expect(sizeNode(node({ id: 'n', type: 'service', label }))).toEqual({
      width: expected,
      height: 60,
    });
  });

  it('ignores fields on a non-entity node (fields are ERD-only meaning)', () => {
    expect(
      sizeNode(node({ id: 'n', type: 'service', label: 'Api', fields: fields(5) })),
    ).toEqual({ width: 150, height: 60 });
  });

  it('ignores meta everywhere — hover detail is not geometry', () => {
    expect(
      sizeNode(node({ id: 'n', type: 'service', label: 'Api', meta: { owner: 'core' } })),
    ).toEqual(sizeNode(node({ id: 'n', type: 'service', label: 'Api' })));
  });
});

// ---------------------------------------------------------------------------
// 2. Entity table sizing.

describe('entity sizing', () => {
  it('grows taller with each field', () => {
    const one = sizeNode(node({ id: 'e', type: 'entity', fields: fields(1) }));
    const three = sizeNode(node({ id: 'e', type: 'entity', fields: fields(3) }));
    expect(three.height).toBeGreaterThan(one.height);
    expect(three.height - one.height).toBe(2 * ENTITY.rowH);
  });

  it('matches header + rows*rowH + padding exactly', () => {
    for (const n of [1, 2, 3, 7, 40]) {
      const { height } = sizeNode(node({ id: 'e', type: 'entity', fields: fields(n) }));
      expect(height).toBe(ENTITY.headerH + n * ENTITY.rowH + ENTITY.padB);
    }
  });

  it('falls back to the standard box when the entity has no fields', () => {
    expect(sizeNode(node({ id: 'e', type: 'entity', label: 'Users' }))).toEqual({
      width: 150,
      height: NODE.h,
    });
    expect(
      sizeNode(node({ id: 'e', type: 'entity', label: 'Users', fields: [] })),
    ).toEqual({ width: 150, height: NODE.h });
    expect(
      sizeNode(node({ id: 'e', type: 'entity', label: 'Users', note: 'a note' })),
    ).toEqual({ width: 150, height: NODE.hWithNote });
  });

  it('widens to fit the widest field row, badge column included', () => {
    const f = { name: 'created_at', type: 'timestamptz' };
    const { width } = sizeNode(node({ id: 'e', type: 'entity', label: 'U', fields: [f] }));
    const rowW =
      ACCENT_W +
      ENTITY.padX * 2 +
      measureText('created_at', ENTITY_FIELD_FONT) +
      ENTITY.gap +
      measureText('timestamptz', ENTITY_FIELD_FONT);
    expect(rowW).toBe(fieldRowWidth(f));
    expect(width).toBe(Math.min(Math.max(rowW, NODE.minW), ENTITY.maxW));
    // Wider than the header alone would have made it.
    expect(width).toBeGreaterThan(
      measureText('U', LABEL_FONT) + NODE.padX * 2 + NODE.iconW,
    );
  });

  it('clamps an over-wide field row at the entity maximum width', () => {
    const f = {
      name: 'extremely_long_column_name_that_overflows',
      type: 'character varying',
      pk: true,
      fk: true,
    };
    expect(fieldRowWidth(f)).toBeGreaterThan(ENTITY.maxW);
    const { width } = sizeNode(
      node({ id: 'e', type: 'entity', label: 'Users', fields: [f] }),
    );
    expect(width).toBe(ENTITY.maxW);
    expect(ENTITY.maxW).toBeGreaterThan(NODE.maxW);
  });

  it('ignores a field note when sizing — the row never draws it', () => {
    const bare = { name: 'email', type: 'citext' };
    const annotated = { ...bare, note: 'unique, lowercased on write' };
    expect(fieldRowWidth(annotated)).toBe(fieldRowWidth(bare));
    expect(
      sizeNode(node({ id: 'e', type: 'entity', label: 'U', fields: [annotated] })),
    ).toEqual(sizeNode(node({ id: 'e', type: 'entity', label: 'U', fields: [bare] })));
  });

  it('reserves the room the badges actually take, not a constant', () => {
    const plain = { name: 'order_reference_id', type: 'uuid' };
    const pk = { ...plain, pk: true };
    const both = { ...plain, pk: true, fk: true };
    // PK+FK is a normal join-table row (rules-erd.md rule 6), so a
    // composite key must widen the box strictly more than a single one.
    expect(fieldRowWidth(pk)).toBeGreaterThan(fieldRowWidth(plain));
    expect(fieldRowWidth(both)).toBeGreaterThan(fieldRowWidth(pk));
    expect(fieldRowWidth(both) - fieldRowWidth(pk)).toBeCloseTo(
      badgeWidth('FK') + ENTITY.gap,
      6,
    );
  });

  it('is at least as wide as the header when fields are narrow', () => {
    const label = 'Subscription Invoices';
    const { width } = sizeNode(
      node({ id: 'e', type: 'entity', label, fields: [{ name: 'id' }] }),
    );
    expect(width).toBe(
      Math.min(measureText(label, LABEL_FONT) + NODE.padX * 2 + NODE.iconW, ENTITY.maxW),
    );
  });

  it('is deterministic — same node, same size', () => {
    const n = node({ id: 'e', type: 'entity', label: 'Users', fields: fields(4) });
    expect(sizeNode(n)).toEqual(sizeNode(n));
  });
});

// ---------------------------------------------------------------------------
// 3. A real ELK layout of an ERD document.

const ERD_DOC: GraphDoc = {
  schemaVersion: 1,
  title: 'Billing ERD',
  direction: 'RIGHT',
  nodes: [
    {
      id: 'users',
      label: 'users',
      type: 'entity',
      parent: null,
      fields: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'email', type: 'varchar(255)' },
        { name: 'created_at', type: 'timestamptz' },
      ],
    },
    {
      id: 'invoices',
      label: 'invoices',
      type: 'entity',
      parent: null,
      fields: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'user_id', type: 'uuid', fk: true },
        { name: 'total_cents', type: 'bigint' },
        { name: 'status', type: 'text' },
        { name: 'issued_at', type: 'timestamptz', nullable: true },
      ],
    },
    {
      id: 'line-items',
      label: 'line_items',
      type: 'entity',
      parent: null,
      fields: [
        { name: 'id', type: 'uuid', pk: true },
        { name: 'invoice_id', type: 'uuid', fk: true },
        { name: 'sku', type: 'text' },
      ],
    },
    { id: 'billing-api', label: 'Billing API', type: 'service', parent: null },
  ],
  groups: [],
  edges: [
    { id: 'e-user-inv', from: 'users', to: 'invoices', cardinality: '1:N' },
    { id: 'e-inv-line', from: 'invoices', to: 'line-items', cardinality: '1:N' },
    { id: 'e-api-inv', from: 'billing-api', to: 'invoices', label: 'writes' },
  ],
  collapsed: [],
};

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe('ERD document through the real elkjs layout', () => {
  it('places every entity at its table size with no overlapping rects', async () => {
    const laid = await layout(ERD_DOC);

    for (const n of ERD_DOC.nodes) {
      const r = laid.nodes.get(n.id);
      expect(r, `no rect for ${n.id}`).toBeDefined();
      const { width, height } = sizeNode(n);
      expect(r!.width).toBeCloseTo(width, 6);
      expect(r!.height).toBeCloseTo(height, 6);
      expect(Number.isFinite(r!.x) && Number.isFinite(r!.y)).toBe(true);
    }

    const rects = ERD_DOC.nodes.map((n) => [n.id, laid.nodes.get(n.id)!] as const);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(
          overlaps(rects[i]![1], rects[j]![1]),
          `${rects[i]![0]} overlaps ${rects[j]![0]}`,
        ).toBe(false);
      }
    }
  });
});
