// debug/fixtures.ts — the six test fixtures, loaded eagerly at build time
// (vite JSON imports) and pushed through schema parse + document validation.
//
// This is the DEBUG picker's data source (spec M2 Step 9): valid fixtures
// become selectable documents; invalid ones stay in the list but carry
// their validation errors so the page can show them as text instead of a
// diagram. Pure module — no DOM.

// Runtime imports go straight to the core SOURCE modules rather than the
// '@diagram-engine/core' barrel: the barrel re-exports store/ (node:fs),
// which must not be pulled into the browser bundle. Type-only imports of
// the barrel elsewhere are erased at compile time and are fine.
import { GraphDocSchema } from '../../../core/src/schema/graph.js';
import { validate } from '../../../core/src/document/validate.js';
import type { GraphDoc } from '@diagram-engine/core';

// Vite resolves JSON imports at build time; paths are relative to this file.
// tsconfig has resolveJsonModule, so these typecheck too (as widened JSON
// shapes — we re-parse through zod below rather than trusting the cast).
import empty from '../../../../tests/fixtures/empty.json';
import flatThreeNodes from '../../../../tests/fixtures/flat-three-nodes.json';
import nestedTwoDeep from '../../../../tests/fixtures/nested-two-deep.json';
import crossBoundaryEdges from '../../../../tests/fixtures/cross-boundary-edges.json';
import invalidCyclicGroups from '../../../../tests/fixtures/invalid-cyclic-groups.json';
import invalidDuplicateId from '../../../../tests/fixtures/invalid-duplicate-id.json';

/** One picker entry: either a valid document or the errors that reject it. */
export type FixtureEntry =
  | { name: string; ok: true; doc: GraphDoc }
  | { name: string; ok: false; errors: string[] };

/**
 * Schema-parse then invariant-validate one raw fixture. Invalid fixtures
 * (schema or V1-V10) come back as an error entry, never a document.
 */
export function loadFixture(name: string, raw: unknown): FixtureEntry {
  const parsed = GraphDocSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      name,
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  const result = validate(parsed.data);
  if (!result.ok) return { name, ok: false, errors: result.errors };
  return { name, ok: true, doc: parsed.data };
}

/** All six fixtures, in a stable display order (valid ones first). */
export const FIXTURES: FixtureEntry[] = [
  loadFixture('flat-three-nodes', flatThreeNodes),
  loadFixture('nested-two-deep', nestedTwoDeep),
  loadFixture('cross-boundary-edges', crossBoundaryEdges),
  loadFixture('empty', empty),
  loadFixture('invalid-cyclic-groups', invalidCyclicGroups),
  loadFixture('invalid-duplicate-id', invalidDuplicateId),
];
