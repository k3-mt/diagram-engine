// format/table.ts — GraphDoc -> compact text table for agents (spec §2.4, §4.1).
// The same table diagram_get returns: cheaper than JSON and models read it
// more reliably. Columns are padded within each section for scanability.

import type { GField, GraphDoc } from '../schema/graph.js';

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

  return lines.join('\n');
}
