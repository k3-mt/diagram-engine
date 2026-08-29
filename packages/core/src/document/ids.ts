// document/ids.ts — ID slug helpers and ID collision coercion (spec §3.5).
//
// The agent will occasionally reuse an ID. We coerce rather than reject:
//   - addNode with an existing id  -> treat as updateNode
//   - addGroup with an existing id -> treat as updateGroup
//   - addEdge with an existing id but different endpoints -> assign e-<nextCounter>
// Each coercion is reported as a note string so the caller can surface it
// in the tool result (that's how you diagnose whether the rules text works).

import { ID_REGEX, type GraphDoc } from '../schema/graph.js';
import type { PatchOp } from '../schema/patch.js';

/**
 * Turn an arbitrary label into a valid ID slug:
 * "Order Service" -> "order-service".
 * Lowercase-hyphenated, starts with a letter, max 48 chars (spec §3.1).
 */
export function slugify(text: string): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of other chars -> one hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  slug = slug.replace(/^[^a-z]+/, ''); // must start with a letter
  slug = slug.slice(0, 48).replace(/-+$/g, '');
  return slug;
}

/** True when `id` matches the slug regex `^[a-z][a-z0-9-]{0,47}$`. */
export function isValidId(id: string): boolean {
  return ID_REGEX.test(id);
}

/**
 * Levenshtein edit distance — used for the V5 "Did you mean ...?" suffix
 * and unknown-id suggestions.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? Infinity) + 1, // deletion
        (cur[j - 1] ?? Infinity) + 1, // insertion
        (prev[j - 1] ?? Infinity) + cost, // substitution
      );
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/**
 * Nearest existing id to `id` among `candidates` — a prefix match wins
 * outright, otherwise smallest Levenshtein distance within a sanity bound.
 * Returns undefined when nothing is plausibly close.
 */
export function nearestId(id: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === id) continue;
    // prefix relationship ("redis" vs "redis-cache") is the common miss
    if (c.startsWith(id) || id.startsWith(c)) {
      const score = Math.abs(c.length - id.length) * 0.5; // prefer prefixes
      if (score < bestScore) {
        best = c;
        bestScore = score;
      }
      continue;
    }
    const d = levenshtein(id, c);
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  if (best === undefined) return undefined;
  // sanity bound: don't suggest something wildly different
  const limit = Math.max(3, Math.floor(Math.max(id.length, best.length) / 2));
  return bestScore <= limit ? best : undefined;
}

/** All ids in the shared node ∪ group namespace. */
export function elementIds(doc: GraphDoc): string[] {
  return [...doc.nodes.map((n) => n.id), ...doc.groups.map((g) => g.id)];
}

/**
 * Next free counter for generated edge ids: scans existing `e<N>` / `e-<N>`
 * ids and returns max + 1. IDs are never reused (spec §3.1).
 */
export function nextEdgeCounter(doc: GraphDoc): number {
  let max = 0;
  for (const e of doc.edges) {
    const m = /^e-?(\d+)$/.exec(e.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Generated edge id: `e-<nextCounter>` (spec §3.5). */
export function nextEdgeId(doc: GraphDoc): string {
  return `e-${nextEdgeCounter(doc)}`;
}

/** Result of coercing one op: possibly-rewritten op, plus a note if coerced. */
export interface CoercedOp {
  op: PatchOp;
  note?: string;
}

/**
 * The three coercion cases from spec §3.5, applied against the document
 * state at the moment the op is about to run.
 *
 *  - addNode with an existing ID  -> updateNode (it almost always means
 *    "this thing, with these properties")
 *  - addGroup with an existing ID -> updateGroup
 *  - addEdge with an existing ID but different endpoints -> assign e-<nextCounter>
 *
 * Ops that need no coercion pass through unchanged.
 */
export function coerceOp(doc: GraphDoc, op: PatchOp): CoercedOp {
  switch (op.op) {
    case 'addNode': {
      const exists = doc.nodes.some((n) => n.id === op.node.id);
      if (exists) {
        const { id, ...changes } = op.node;
        return {
          op: { op: 'updateNode', id, changes },
          note: `coerced addNode "${id}" to updateNode (id exists)`,
        };
      }
      return { op };
    }
    case 'addGroup': {
      const exists = doc.groups.some((g) => g.id === op.group.id);
      if (exists) {
        const { id, ...changes } = op.group;
        return {
          op: { op: 'updateGroup', id, changes },
          note: `coerced addGroup "${id}" to updateGroup (id exists)`,
        };
      }
      return { op };
    }
    case 'addEdge': {
      const existing = doc.edges.find((e) => e.id === op.edge.id);
      if (existing && (existing.from !== op.edge.from || existing.to !== op.edge.to)) {
        const fresh = nextEdgeId(doc);
        return {
          op: { op: 'addEdge', edge: { ...op.edge, id: fresh } },
          note: `coerced addEdge "${op.edge.id}" to new id "${fresh}" (id exists with different endpoints)`,
        };
      }
      return { op };
    }
    default:
      return { op };
  }
}
