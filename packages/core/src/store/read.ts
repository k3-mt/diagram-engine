// store/read.ts — read + parse + zod-validate graph.json (spec §2.5, §9).
//
// A missing file is not an error: the store starts every project with a
// sensible empty document (schemaVersion 1, "Untitled", DOWN, empty arrays).
// A present-but-broken file IS an error — the caller (e.g. `diagram serve`)
// keeps showing the last good diagram and writes the messages to errors.txt.

import * as fs from 'node:fs';
import { GraphDocSchema, type GraphDoc } from '../schema/graph.js';

/** Typed result of reading a document from disk. */
export type ReadDocResult =
  | { ok: true; doc: GraphDoc }
  | { ok: false; errors: string[] };

/** A fresh empty document — the state before any patch has been applied. */
export function emptyDoc(): GraphDoc {
  return {
    schemaVersion: 1,
    title: 'Untitled',
    direction: 'DOWN',
    nodes: [],
    groups: [],
    edges: [],
    collapsed: [],
  };
}

/**
 * Parse and zod-validate raw JSON text as a GraphDoc.
 * Shared by graph.json reads and history snapshot reads.
 */
export function parseDoc(raw: string): ReadDocResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${(e as Error).message}`] };
  }
  const result = GraphDocSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, doc: result.data };
}

/**
 * Read graph.json from disk.
 *
 * - File absent → `{ ok: true, doc: emptyDoc() }` (a new project).
 * - File present but unparseable or invalid → `{ ok: false, errors }`.
 */
export function readDoc(graphFile: string): ReadDocResult {
  let raw: string;
  try {
    raw = fs.readFileSync(graphFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, doc: emptyDoc() };
    }
    return {
      ok: false,
      errors: [`cannot read ${graphFile}: ${(e as Error).message}`],
    };
  }
  const result = parseDoc(raw);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors.map((msg) => `${graphFile}: ${msg}`),
    };
  }
  return result;
}
