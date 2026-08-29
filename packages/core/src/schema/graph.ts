// schema/graph.ts — the graph document (spec §3.1).
// The only persistent state. Everything else derives.
// Never stored here: any x, y, width, height, waypoint, or path string.
//
// Zod schemas are the single source of truth; the TS types are inferred
// from them so runtime validation and compile-time types cannot drift.

import { z } from 'zod/v4';

/**
 * ID format (spec §3.1): stable slug, never reused.
 * Nodes and groups share one namespace, because edges can reference either.
 */
export const ID_REGEX = /^[a-z][a-z0-9-]{0,47}$/;

export const IdSchema = z
  .string()
  .regex(ID_REGEX, 'use lowercase-hyphenated, e.g. "auth-service"');

/** NodeType (spec §3.1). */
export const NodeTypeSchema = z.enum([
  'service', // an application you own
  'database', // relational or document store
  'queue', // kafka, sqs, rabbit, pubsub
  'cache', // redis, memcached
  'storage', // s3, gcs, blob
  'client', // browser, mobile app, cli
  'external', // third party you don't control
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/** GroupKind (spec §3.1). */
export const GroupKindSchema = z.enum([
  'vpc',
  'region',
  'cluster',
  'account',
  'generic',
]);
export type GroupKind = z.infer<typeof GroupKindSchema>;

/** GNode (spec §3.1). */
export const GNodeSchema = z.object({
  /** stable slug, never reused */
  id: IdSchema,
  /** 1–40 chars */
  label: z.string().min(1).max(40),
  type: NodeTypeSchema,
  /** group id or null */
  parent: z.string().nullable(),
  /** optional second line, 1–60 chars */
  note: z.string().min(1).max(60).optional(),
});
export type GNode = z.infer<typeof GNodeSchema>;

/** GGroup (spec §3.1). */
export const GGroupSchema = z.object({
  id: IdSchema,
  /** 1–40 chars */
  label: z.string().min(1).max(40),
  kind: GroupKindSchema,
  parent: z.string().nullable(),
});
export type GGroup = z.infer<typeof GGroupSchema>;

/** GEdge (spec §3.1). `from`/`to` are a node id OR a group id. */
export const GEdgeSchema = z.object({
  id: IdSchema,
  /** node id OR group id */
  from: z.string(),
  to: z.string(),
  /** 1–24 chars */
  label: z.string().min(1).max(24).optional(),
  style: z.enum(['solid', 'dashed']).optional(),
  arrow: z.enum(['forward', 'both', 'none']).optional(),
});
export type GEdge = z.infer<typeof GEdgeSchema>;

export const DirectionSchema = z.enum(['DOWN', 'RIGHT']);
export type Direction = z.infer<typeof DirectionSchema>;

/** GraphDoc (spec §3.1). The single source of truth on disk. */
export const GraphDocSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string(),
  direction: DirectionSchema,
  nodes: z.array(GNodeSchema),
  groups: z.array(GGroupSchema),
  edges: z.array(GEdgeSchema),
  collapsed: z.array(z.string()),
});
export type GraphDoc = z.infer<typeof GraphDocSchema>;
