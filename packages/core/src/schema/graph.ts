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
  'entity', // a database table / domain entity (ERD mode), rendered as a field table
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

/**
 * Meta key format: lowercase-hyphenated/underscored, 1–24 chars.
 * Keys are short labels ("owner", "sla", "team_slack"), not sentences.
 */
export const META_KEY_REGEX = /^[a-z][a-z0-9_-]{0,23}$/;

/** Upper bound on the number of columns rendered in one entity node. */
export const MAX_FIELDS = 40;

/** Upper bound on the number of meta entries shown in the hover panel. */
export const MAX_META_KEYS = 16;

/**
 * GField — one column of an `entity` node (ERD mode, spec Part 13 item 2).
 * This is MEANING, not geometry: the viewer decides where a field is drawn,
 * the document only says which fields exist and what they mean.
 */
export const GFieldSchema = z.object({
  /** column name, 1–40 chars */
  name: z.string().min(1).max(40),
  /** column type as you would write it in DDL, e.g. "uuid", "varchar(255)" */
  type: z.string().min(1).max(24).optional(),
  /** part of the primary key */
  pk: z.boolean().optional(),
  /** foreign key into another entity */
  fk: z.boolean().optional(),
  /** nullable column (omitted means "unspecified", not "not null") */
  nullable: z.boolean().optional(),
  /** optional short annotation, 1–60 chars */
  note: z.string().min(1).max(60).optional(),
});
export type GField = z.infer<typeof GFieldSchema>;

/**
 * Node metadata — arbitrary detail the agent attaches to ANY node (not just
 * entities); the viewer reveals it in a hover panel. Still meaning, never
 * geometry: no x/y/width/height/waypoint may be stored here.
 */
export const GMetaSchema = z
  .record(
    z
      .string()
      .regex(
        META_KEY_REGEX,
        'use a lowercase key of 1–24 chars, letters/digits/-/_ after the first letter, e.g. "owner"',
      ),
    z.string().min(1).max(200),
  )
  .refine((m) => Object.keys(m).length <= MAX_META_KEYS, {
    message: `too many meta keys: keep at most ${MAX_META_KEYS}; merge or drop entries`,
  })
  // The refine itself is invisible to JSON Schema generation, so state the cap
  // declaratively too — that is what the MCP tool schema shows the agent.
  .meta({ maxProperties: MAX_META_KEYS });
export type GMeta = z.infer<typeof GMetaSchema>;

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
  /** ERD columns; meaningful on type "entity", at most 40 */
  fields: z
    .array(GFieldSchema)
    .max(
      MAX_FIELDS,
      `too many fields: keep at most ${MAX_FIELDS} per entity; split the table or drop columns`,
    )
    .optional(),
  /** free-form detail for the viewer's hover panel, at most 16 keys */
  meta: GMetaSchema.optional(),
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

/** Cardinality (ERD mode): relationship multiplicity carried by an edge. */
export const CardinalitySchema = z.enum(['1:1', '1:N', 'N:1', 'N:M']);
export type Cardinality = z.infer<typeof CardinalitySchema>;

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
  /**
   * Relationship multiplicity for ERD edges, drawn with crow's-foot markers.
   * "N:1" exists alongside "1:N" so direction is expressible without having
   * to reverse the edge's from/to.
   */
  cardinality: CardinalitySchema.optional(),
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
