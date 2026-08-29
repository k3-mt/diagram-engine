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
 * How many elements that exist in BOTH documents changed parent — the
 * "3 moved" half of the canonical demo turn (spec §1.3: "group added,
 * 2 moved"). Counting only survivors is the point: an element that was
 * added or removed is already reported by the count diff, and reporting it
 * twice would make one change look like two.
 */
function movedCount(before: GraphDoc, after: GraphDoc): number {
  const parentBefore = new Map<string, string | null>();
  for (const n of before.nodes) parentBefore.set(n.id, n.parent);
  for (const g of before.groups) parentBefore.set(g.id, g.parent);

  let moved = 0;
  for (const el of [...after.nodes, ...after.groups]) {
    if (!parentBefore.has(el.id)) continue; // new: already counted as "+1"
    if (parentBefore.get(el.id) !== el.parent) moved += 1;
  }
  return moved;
}

/**
 * One-line count diff between two documents, e.g. "+3 nodes, +1 group, -2 edges".
 *
 * Reparenting is reported alongside the counts ("+1 group, 3 moved"), because
 * the canonical turn — "put postgres, kafka and the worker in a private vpc" —
 * is one addGroup plus three updateNode ops, and a summary that mentions only
 * the group omits the part the user actually asked for. Rule 12 tells the
 * agent to report the change in one line; this is that line.
 *
 * When nothing counted and nothing moved but the documents differ (labels,
 * title, direction, ...) it returns "updated"; when nothing changed at all,
 * "no changes".
 */
export function summarise(before: GraphDoc, after: GraphDoc): string {
  const parts = [
    part(after.nodes.length - before.nodes.length, 'node'),
    part(after.groups.length - before.groups.length, 'group'),
    part(after.edges.length - before.edges.length, 'edge'),
  ].filter((p): p is string => p !== undefined);

  const moved = movedCount(before, after);
  if (moved > 0) parts.push(`${moved} moved`);

  if (parts.length) return parts.join(', ');
  return JSON.stringify(before) === JSON.stringify(after) ? 'no changes' : 'updated';
}
