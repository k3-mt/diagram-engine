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
 * Meta keys that would smuggle geometry into the document. The layout engine
 * owns every position and size (spec §1.3), and rules.md says so in prose —
 * this is the same sentence with teeth, so an agent that ignores the prose is
 * corrected by the schema instead of silently poisoning graph.json.
 */
export const GEOMETRY_META_KEYS = new Set([
  'x', 'y', 'w', 'h', 'cx', 'cy', 'dx', 'dy',
  'width', 'height', 'top', 'left', 'right', 'bottom',
  'pos', 'position', 'coord', 'coords', 'coordinates',
  'layout', 'waypoint', 'waypoints', 'points', 'path', 'rect', 'bbox', 'size',
]);

/** The one message for a geometry key, taken from rules.md's own wording. */
export const GEOMETRY_META_MESSAGE =
  'meta is not geometry — the layout engine decides position and size; drop this key';

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
  // Rule zero, enforced rather than merely asked for (spec §1.3, §3.1: geometry
  // is NEVER persisted). meta accepts any short lowercase key, so without this
  // an agent could write {"x":"120","y":"40"} into a node and that geometry
  // would survive every patch and be committed to git with graph.json.
  .refine((m) => Object.keys(m).every((k) => !GEOMETRY_META_KEYS.has(k)), {
    message: GEOMETRY_META_MESSAGE,
  })
  // The refine itself is invisible to JSON Schema generation, so state the cap
  // declaratively too — that is what the MCP tool schema shows the agent.
  .meta({ maxProperties: MAX_META_KEYS });
export type GMeta = z.infer<typeof GMetaSchema>;

/**
 * BindingSource (spec §3.8) — the KIND of artefact a claim was read out of.
 * Lowercase and closed: an agent that writes "Compose" is corrected by V14
 * rather than inventing a sixth source nobody checks.
 */
export const BindingSourceSchema = z.enum([
  'repo', // a path in the repository: a directory or a source file
  'compose', // a service name in a docker-compose file
  'terraform', // a terraform address, e.g. "aws_ecs_service.orders"
  'k8s-manifest', // a kubernetes manifest, by path or by kind/name
  'package', // a package name in a manifest (package.json, go.mod, ...)
]);
export type BindingSource = z.infer<typeof BindingSourceSchema>;

/** Upper bound on the length of a binding `ref`, matching a meta value. */
export const BINDING_REF_MAX = 200;

/**
 * Upper bound on a binding `line`. A citation past a million lines is a typo
 * or a byte offset, and the checker would have to read the whole file to say
 * so; the schema says it first and for free.
 */
export const MAX_BINDING_LINE = 1_000_000;

/** Upper bound on bindings per node (spec §3.8). */
export const MAX_NODE_BINDINGS = 8;

/** Upper bound on bindings per edge (spec §3.8). Fewer: an edge is one claim. */
export const MAX_EDGE_BINDINGS = 4;

/**
 * GBinding (spec §3.8) — WHERE A CLAIM WAS READ, and nothing else.
 *
 * A binding is provenance, never observation: it says which file or identifier
 * the agent opened to learn that this node or this edge exists. It says
 * nothing about a running system — no health, no timestamp, no "last checked"
 * (ground rule R5). `diagram check --bindings` resolves every ref against the
 * filesystem, which is what makes agent rule 15 mechanical rather than
 * aspirational: a citation to a file that does not exist is worse than no
 * citation, because it reads as evidence.
 *
 *   repo=services/orders/            a directory in the repository
 *   repo=internal/pay.go with line   one line of one file
 *   compose=orders-api               a service name, not a path
 *   terraform=aws_ecs_service.orders a terraform address
 */
export const GBindingSchema = z.object({
  source: BindingSourceSchema,
  /**
   * Repo-relative path or identifier, 1–200 chars. NEVER a URL, never
   * absolute, never escaping the root — V16 says so with a message, because
   * the checker resolves this string against a directory on disk.
   */
  ref: z.string().min(1).max(BINDING_REF_MAX),
  /**
   * 1-BASED line number, for when the claim is about one line. Only meaningful
   * when `ref` names a FILE: a line on a directory (`services/orders/`) or on
   * an identifier (`compose=orders-api`) points at nothing the checker could
   * open, so V16 rejects it.
   */
  line: z.number().int().min(1).max(MAX_BINDING_LINE).optional(),
});
export type GBinding = z.infer<typeof GBindingSchema>;

/**
 * `parent` on a node or a group: the containing group id, or null for top
 * level. The key is REQUIRED — omitting it is the most common first mistake a
 * CLI-path agent makes, and the default zod message ("expected string,
 * received undefined") names only `string`, which reads as an instruction to
 * invent a group id and earns a second, different rejection. So the message
 * says the whole truth, in the same say-what-to-do voice as IdSchema.
 */
export const ParentSchema = z.union([z.string(), z.null()], {
  error: 'parent is required: the containing group id, or null for top level',
});

/** GNode (spec §3.1). */
export const GNodeSchema = z.object({
  /** stable slug, never reused */
  id: IdSchema,
  /** 1–40 chars */
  label: z.string().min(1).max(40),
  type: NodeTypeSchema,
  /** group id or null — REQUIRED, and null is how you say "top level" */
  parent: ParentSchema,
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
  /** where this node was read from (spec §3.8), at most 8 entries */
  bindings: z
    .array(GBindingSchema)
    .max(
      MAX_NODE_BINDINGS,
      `too many bindings: keep at most ${MAX_NODE_BINDINGS} per node; cite the files you actually read`,
    )
    .optional(),
});
export type GNode = z.infer<typeof GNodeSchema>;

/** GGroup (spec §3.1). */
export const GGroupSchema = z.object({
  id: IdSchema,
  /** 1–40 chars */
  label: z.string().min(1).max(40),
  kind: GroupKindSchema,
  /** enclosing group id, or null for a top-level boundary. Required. */
  parent: ParentSchema,
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
  /**
   * Redundancy tag, 1–24 chars (spec §18.11). Edges FROM ONE SOURCE sharing an
   * `alt` tag are ALTERNATIVES, not independent hard dependencies: failure
   * propagates to the source only when every edge in the set is unavailable.
   * Scoped per source node — `orders → pg-primary` and `orders → pg-replica`
   * both tagged "db" are alternatives; an edge from another source tagged "db"
   * is unrelated. Absent means a hard dependency, exactly as before, so every
   * existing document keeps its current meaning.
   */
  alt: z.string().min(1).max(24).optional(),
  /**
   * Where this edge was read from (spec §3.8), at most 4 entries. This field
   * is the whole point of §3.8: before it existed an edge had no `note`, no
   * `meta` and no binding, so a coupling found by reading the code could be
   * drawn but could not be CITED — the schema could not hold the answer rule 9
   * asks for. Four, not eight: a node is a component and can legitimately
   * appear in a repo, a compose file and a terraform module at once; an edge
   * is one call site.
   */
  bindings: z
    .array(GBindingSchema)
    .max(
      MAX_EDGE_BINDINGS,
      `too many bindings: keep at most ${MAX_EDGE_BINDINGS} per edge; cite the call site you actually read`,
    )
    .optional(),
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
