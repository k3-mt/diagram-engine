// format/summary.ts — patch summary one-liner (spec §2.4, §3.4).
// summarise(before, after) -> "+3 nodes, +1 group, -2 edges".
// Terse structured text: the agent reads it as context on every turn,
// so verbosity costs tokens and attention (spec §4.1).

import type { GraphDoc } from '../schema/graph.js';

function part(delta: number, noun: string): string | undefined {
  if (delta === 0) return undefined;
  const n = Math.abs(delta);
  const plural = n === 1 ? noun : `${noun}s`;
  return `${delta > 0 ? '+' : '-'}${n} ${plural}`;
}

/**
 * One-line count diff between two documents, e.g. "+3 nodes, +1 group, -2 edges".
 * When no counts changed but the documents differ (labels, parents, title, ...)
 * returns "updated"; when nothing changed at all, "no changes".
 */
export function summarise(before: GraphDoc, after: GraphDoc): string {
  const parts = [
    part(after.nodes.length - before.nodes.length, 'node'),
    part(after.groups.length - before.groups.length, 'group'),
    part(after.edges.length - before.edges.length, 'edge'),
  ].filter((p): p is string => p !== undefined);

  if (parts.length) return parts.join(', ');
  return JSON.stringify(before) === JSON.stringify(after) ? 'no changes' : 'updated';
}
