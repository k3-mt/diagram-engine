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
export const GEdgeChangesSchema = GEdgeSchema.omit({ id: true }).partial();

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
  summary: z.string(),
});
export type GraphPatch = z.infer<typeof GraphPatchSchema>;
