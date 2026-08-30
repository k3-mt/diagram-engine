// format/table.ts — GraphDoc -> compact text table for agents (spec §2.4, §4.1).
// The same table diagram_get returns: cheaper than JSON and models read it
// more reliably. Columns are padded within each section for scanability.

import { formatBinding } from '../bindings/ref.js';
import type { GBinding, GField, GraphDoc } from '../schema/graph.js';

/**
 * How many bindings of one element the table prints before it stops.
 *
 * This table sits in the agent's context on EVERY turn, so a node with eight
 * bindings must not push the architecture off the screen — three is enough to
 * show that the node is sourced and where from, which is what the agent reads
 * this section for. The rest are counted, not hidden: the row ends
 * `(+5 more)`, so the agent can see they exist and read them out of graph.json
 * if it needs them. Adding a binding it cannot see is not a trap either — V15
 * rejects a duplicate source by name and says why.
 */
export const TABLE_BINDINGS_SHOWN = 3;

/** `repo=services/orders/, compose=orders-api (+5 more)` */
function formatBindings(bindings: GBinding[]): string {
  const shown = bindings.slice(0, TABLE_BINDINGS_SHOWN).map(formatBinding).join(', ');
  const hidden = bindings.length - TABLE_BINDINGS_SHOWN;
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}

/**
 * One column, as compactly as it can still be read:
 *   id:uuid PK        email:varchar? (unique)        owner_id:uuid FK
 * Type omitted when unknown; "?" marks nullable; the note goes in parens.
 */
function formatField(f: GField): string {
  let s = f.type !== undefined ? `${f.name}:${f.type}` : f.name;
  if (f.nullable === true) s += '?';
  if (f.pk === true) s += ' PK';
  if (f.fk === true) s += ' FK';
  if (f.note !== undefined) s += ` (${f.note})`;
  return s;
}

/** Pad every column in a section to its widest cell, joined with " | ". */
function alignRows(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join(' | ')
      .trimEnd(),
  );
}

/**
 * Render the document as the compact text table from spec §4.1:
 *
 *   ## "Checkout platform"  (direction: DOWN)
 *
 *   ### Groups (id | kind | label | parent)
 *   vpc-private | vpc | Private VPC | -
 *
 *   ### Nodes (id | type | label | parent)
 *   web-client    | client   | Web Client     | -
 *
 *   ### Edges (id | from -> to | label | style)
 *   e1 | web-client -> api-gateway  | https  | solid
 *
 * Three sections appear only when the document uses them, so an
 * architecture-only diagram costs the agent exactly what it did before:
 *
 *   - the edges table grows a `cardinality` column when any edge carries one,
 *     and an `alt` column when any edge carries an alternative tag (§18.11)
 *   - ### Entities (id | fields) — one line per entity, columns comma-joined
 *   - ### Meta (id | key=value)  — only nodes that actually have meta
 *   - ### Bindings (kind | id | source=ref) — provenance (§3.8), nodes and
 *     edges, only the elements that carry one
 */
export function toTable(doc: GraphDoc): string {
  const lines: string[] = [];
  lines.push(`## "${doc.title}"  (direction: ${doc.direction})`);
  lines.push('');

  lines.push('### Groups (id | kind | label | parent)');
  lines.push(
    ...alignRows(doc.groups.map((g) => [g.id, g.kind, g.label, g.parent ?? '-'])),
  );
  lines.push('');

  lines.push('### Nodes (id | type | label | parent)');
  lines.push(
    ...alignRows(doc.nodes.map((n) => [n.id, n.type, n.label, n.parent ?? '-'])),
  );
  lines.push('');

  const anyCardinality = doc.edges.some((e) => e.cardinality !== undefined);
  // §18.11: the `alt` tag is the one thing on an edge that changes what a
  // blast radius MEANS — two edges from one source sharing a tag are
  // alternatives, not two hard dependencies — so it has to be readable in the
  // same table the agent edits from. Conditional exactly like `cardinality`:
  // a document that never says `alt` pays nothing, and a document that does
  // shows the tag on every edge, `-` included, so "which edges are in the set"
  // is one column to scan rather than a JSON export away.
  const anyAlt = doc.edges.some((e) => e.alt !== undefined);
  lines.push(
    `### Edges (id | from -> to | label | style${anyCardinality ? ' | cardinality' : ''}${anyAlt ? ' | alt' : ''})`,
  );
  lines.push(
    ...alignRows(
      doc.edges.map((e) => {
        const row = [e.id, `${e.from} -> ${e.to}`, e.label ?? '-', e.style ?? 'solid'];
        if (anyCardinality) row.push(e.cardinality ?? '-');
        if (anyAlt) row.push(e.alt ?? '-');
        return row;
      }),
    ),
  );

  const entities = doc.nodes.filter((n) => n.fields !== undefined && n.fields.length > 0);
  if (entities.length > 0) {
    lines.push('');
    lines.push('### Entities (id | fields)');
    lines.push(
      ...alignRows(
        entities.map((n) => [n.id, (n.fields ?? []).map(formatField).join(', ')]),
      ),
    );
  }

  const withMeta = doc.nodes.filter(
    (n) => n.meta !== undefined && Object.keys(n.meta).length > 0,
  );
  if (withMeta.length > 0) {
    lines.push('');
    lines.push('### Meta (id | key=value)');
    lines.push(
      ...alignRows(
        withMeta.map((n) => [
          n.id,
          Object.entries(n.meta ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        ]),
      ),
    );
  }

  // §3.8 — provenance. Nodes first, then edges, in document order, with a kind
  // column so "which of these is the edge citation" is never a guess: node ids
  // and edge ids come from two different namespaces and an agent skimming
  // `e7 | repo=internal/pay.go:412` has no other way to tell. Present only
  // when the document actually uses bindings, exactly like ### Entities and
  // ### Meta — an architecture-only diagram pays nothing for a feature it
  // never touched.
  const bound: string[][] = [];
  for (const n of doc.nodes) {
    if (n.bindings !== undefined && n.bindings.length > 0) {
      bound.push(['node', n.id, formatBindings(n.bindings)]);
    }
  }
  for (const e of doc.edges) {
    if (e.bindings !== undefined && e.bindings.length > 0) {
      bound.push(['edge', e.id, formatBindings(e.bindings)]);
    }
  }
  if (bound.length > 0) {
    lines.push('');
    lines.push('### Bindings (kind | id | source=ref)');
    lines.push(...alignRows(bound));
  }

  return lines.join('\n');
}
