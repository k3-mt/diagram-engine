// format/table.ts — GraphDoc -> compact text table for agents (spec §2.4, §4.1).
// The same table diagram_get returns: cheaper than JSON and models read it
// more reliably. Columns are padded within each section for scanability.

import type { GraphDoc } from '../schema/graph.js';

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

  lines.push('### Edges (id | from -> to | label | style)');
  lines.push(
    ...alignRows(
      doc.edges.map((e) => [
        e.id,
        `${e.from} -> ${e.to}`,
        e.label ?? '-',
        e.style ?? 'solid',
      ]),
    ),
  );

  return lines.join('\n');
}
