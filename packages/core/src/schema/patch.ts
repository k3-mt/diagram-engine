// schema/patch.ts — the patch (spec §3.2).
// A GraphPatch is the only way meaning enters the document. Eleven op
// variants, discriminated on "op". Applied atomically (spec §3.4): a
// rejected patch leaves the document untouched.

import { z } from 'zod/v4';
import { DirectionSchema, GEdgeSchema, GGroupSchema, GNodeSchema } from './graph.js';

// Partial<Omit<GNode,'id'>> etc., derived from the same zod source — so any
// property added to GNode/GGroup/GEdge (e.g. "fields", "meta", "cardinality")
// becomes updatable through updateNode/updateEdge automatically.
//
// REPLACE, not merge: a key present in `changes` overwrites the whole property,
// exactly as `label` or `type` do (apply.ts uses Object.assign). So
// `changes: { fields: [...] }` replaces the entire column list, and the agent
// clears a property predictably by passing an empty value — `fields: []`,
// `meta: {}`. There is no per-field or per-meta-key merge; a key absent from
// `changes` is left untouched.
export const GNodeChangesSchema = GNodeSchema.omit({ id: true }).partial();
export const GGroupChangesSchema = GGroupSchema.omit({ id: true }).partial();
/**
 * Edge changes, with one addition to the derived shape: the OPTIONAL STRING
 * properties also accept `null`, meaning REMOVE THIS PROPERTY (apply.ts).
 *
 * Without it there is no way to take an optional string back off an edge over
 * the wire. `{"alt": ""}` fails min(1), `{"alt": null}` failed the type, and
 * an omitted key means "leave untouched", so the only route was removeEdge +
 * addEdge — which rule 3 forbids and which loses the edge id (G3). §18.11 is
 * explicit that the correction has to be as cheap as the original claim or it
 * will not get made, and `alt` is the first optional property whose ABSENCE is
 * enforced by an invariant (V18: a lone alt is a hard error), so "we dropped
 * the replica" was an ordinary edit the patch model could not express.
 *
 * `label` and `cardinality` get the same escape for the same reason — V13
 * already says "drop the cardinality" — and no GEdge property stores null, so
 * null is unambiguous here. Node and group changes are deliberately untouched:
 * `parent: null` already MEANS top level there, and overloading it to mean
 * removal would make the one field where null is data unwritable.
 */
export const GEdgeChangesSchema = GEdgeSchema.omit({ id: true })
  .partial()
  .extend({
    label: GEdgeSchema.shape.label.unwrap().nullable().optional(),
    cardinality: GEdgeSchema.shape.cardinality.unwrap().nullable().optional(),
    alt: GEdgeSchema.shape.alt.unwrap().nullable().optional(),
    // §3.9's three, for the same reason as the three above: an edge relabelled
    // from a call to a plain write has to be able to LOSE its `returns`, and
    // an edge dropped out of a numbered flow has to be able to lose its `seq`
    // — otherwise the only correction is removeEdge + addEdge, which rule 3
    // forbids and which loses the edge id. `seq` is a number rather than a
    // string, which changes nothing here: no GEdge property stores null, so
    // null is still unambiguously "remove this".
    kind: GEdgeSchema.shape.kind.unwrap().nullable().optional(),
    returns: GEdgeSchema.shape.returns.unwrap().nullable().optional(),
    seq: GEdgeSchema.shape.seq.unwrap().nullable().optional(),
  });

export const AddNodeOpSchema = z.object({
  op: z.literal('addNode'),
  node: GNodeSchema,
});

export const UpdateNodeOpSchema = z.object({
  op: z.literal('updateNode'),
  id: z.string(),
  changes: GNodeChangesSchema,
});

export const RemoveNodeOpSchema = z.object({
  op: z.literal('removeNode'),
  id: z.string(),
});

export const AddGroupOpSchema = z.object({
  op: z.literal('addGroup'),
  group: GGroupSchema,
});

export const UpdateGroupOpSchema = z.object({
  op: z.literal('updateGroup'),
  id: z.string(),
  changes: GGroupChangesSchema,
});

/**
 * removeGroup with `reparentTo` moves children instead of deleting them —
 * that's what "flatten the vpc" means (spec §3.2).
 */
export const RemoveGroupOpSchema = z.object({
  op: z.literal('removeGroup'),
  id: z.string(),
  reparentTo: z.string().nullable().optional(),
});

export const AddEdgeOpSchema = z.object({
  op: z.literal('addEdge'),
  edge: GEdgeSchema,
});

export const UpdateEdgeOpSchema = z.object({
  op: z.literal('updateEdge'),
  id: z.string(),
  changes: GEdgeChangesSchema,
});

export const RemoveEdgeOpSchema = z.object({
  op: z.literal('removeEdge'),
  id: z.string(),
});

export const SetTitleOpSchema = z.object({
  op: z.literal('setTitle'),
  title: z.string(),
});

export const SetDirectionOpSchema = z.object({
  op: z.literal('setDirection'),
  direction: DirectionSchema,
});

/** PatchOp (spec §3.2) — discriminated union on "op". */
export const PatchOpSchema = z.discriminatedUnion('op', [
  AddNodeOpSchema,
  UpdateNodeOpSchema,
  RemoveNodeOpSchema,
  AddGroupOpSchema,
  UpdateGroupOpSchema,
  RemoveGroupOpSchema,
  AddEdgeOpSchema,
  UpdateEdgeOpSchema,
  RemoveEdgeOpSchema,
  SetTitleOpSchema,
  SetDirectionOpSchema,
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

/** GraphPatch (spec §3.2): { ops, summary }. */
export const GraphPatchSchema = z.object({
  ops: z.array(PatchOpSchema),
  // The message says what to do, like every other constraint in the schema
  // (spec §3.3). A CLI-path agent has no generated JSON Schema to read, and
  // "expected string, received undefined" does not tell it that the key is
  // required, let alone what belongs in it.
  summary: z.string({
    error: 'summary is required: one line saying what this patch changes',
  }),
});
export type GraphPatch = z.infer<typeof GraphPatchSchema>;
