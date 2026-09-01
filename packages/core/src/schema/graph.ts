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

/**
 * EdgeKind — WHAT THE LINE MEANS, so the picture can say it (spec §3.9).
 *
 * The problem this solves. Rule 4 fixes an edge's direction at the
 * DEPENDENCY: caller to callee, "the data flows back the other way, the
 * arrow does not". That is the right direction for analysis — `analyse` and
 * `blastRadius` walk these edges as "lose the target and the source is at
 * risk", and reversing a read would reverse the failure. But every reader
 * instinctively reads an arrow as FLOW, and for a read those two point
 * opposite ways. One undifferentiated grey line was being asked to carry
 * both truths and carried neither.
 *
 * The fix is not a second edge. It is ONE edge that says which kind of
 * relationship it is; the viewer then draws the dependency leg and, where
 * the kind implies one, a RETURN LEG back along it (see `returns`). The
 * document stays acyclic, the edge count is unchanged, and `analyse` sees
 * exactly the graph it saw before.
 *
 *   call     synchronous request that expects an answer   → return leg
 *   read     the source pulls data out of the target      → return leg
 *   write    the source pushes data into the target       no return leg
 *   publish  fire-and-forget onto a queue or topic        no return leg
 *   consume  the source pulls messages off a queue        → return leg
 *
 * `call`, `read` and `write` are SYNCHRONOUS and draw solid; `publish` and
 * `consume` are ASYNCHRONOUS and draw dashed — which is rule 6, now stated
 * once by the kind instead of restated by hand on every edge.
 *
 * Optional, and absent means exactly what it meant before this field
 * existed: a dependency arrow drawn from `style` and `arrow`. Every
 * document written before §3.9 renders to the pixel it did.
 */
export const EdgeKindSchema = z.enum([
  'call',
  'read',
  'write',
  'publish',
  'consume',
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/** The kinds that draw a return leg: something comes back to the source. */
export const RETURNING_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'call',
  'read',
  'consume',
]);

/** The kinds that are asynchronous, and so draw dashed (rule 6). */
export const ASYNC_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'publish',
  'consume',
]);

/**
 * Highest step number an edge may carry. Two digits: past 99 the badge stops
 * being readable at any zoom, and a flow with a hundred numbered steps is a
 * sequence diagram, not an architecture diagram.
 */
export const MAX_EDGE_SEQ = 99;

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
   * What this line MEANS (spec §3.9). Sets how the edge is drawn — its
   * dash, its arrowheads, and whether a return leg is painted back along
   * it — so it REPLACES `style` and `arrow` rather than joining them (V20).
   */
  kind: EdgeKindSchema.optional(),
  /**
   * What comes back, 1–24 chars: the label on the return leg — "order[]",
   * "200 OK", "job id". Only meaningful on a kind that HAS a return leg
   * (V21); on a `write` or a `publish` nothing comes back, and a label on a
   * leg that is not drawn is a claim the picture cannot show.
   *
   * The leg itself is drawn whenever the kind implies one. This field only
   * names it, so `kind: "read"` alone still gets the arrow back — you do
   * not have to know what the payload is called to say that there is one.
   */
  returns: z.string().min(1).max(24).optional(),
  /**
   * Step number in a flow, 1–99 (spec §3.9). Rendered as a small numbered
   * badge on the line, so a reader can follow "1 → 2 → 3" through the
   * diagram instead of guessing which call happens first.
   *
   * ORDER, NOT IMPORTANCE. It says when this edge happens relative to the
   * others, and it is deliberately not unique: two edges numbered 3 are two
   * things that happen at the same step, which is exactly what a fan-out
   * looks like. Numbers need not be contiguous either — a document that
   * numbers only the four edges of its critical path is more readable than
   * one that numbers all forty.
   */
  seq: z.number().int().min(1).max(MAX_EDGE_SEQ).optional(),
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

// --- reading an edge's drawing and its behaviour ---------------------------
//
// THE ONE PLACE. Before §3.9 "is this edge asynchronous?" was the expression
// `edge.style === 'dashed'`, written out by hand in five modules: the blast
// propagation, the fan-in weighting, two invariants and the renderer. Adding a
// `kind` that ALSO says async would have left those five reading only half the
// document — a `kind: "publish"` edge would have been traversed as a
// synchronous dependency and reported as a cascade path that cannot happen.
// So the question is asked once, here, and the five callers ask it of this.

/**
 * Is this edge ASYNCHRONOUS — a queue, an event, a webhook? Async edges
 * contain failure (§18.3): a cascade stops at one, and `blastRadius` reports
 * its far side as contained rather than at risk.
 *
 * An explicit `style` still decides, because it always did; `kind` answers for
 * the edges that carry one instead (V20 forbids carrying both).
 */
export function edgeIsAsync(edge: Pick<GEdge, 'style' | 'kind'>): boolean {
  if (edge.style !== undefined) return edge.style === 'dashed';
  return edge.kind !== undefined && ASYNC_KINDS.has(edge.kind);
}

/**
 * Does something come back along this edge — a response, a row set, a
 * message? True for the returning kinds, and for an edge that names what
 * comes back without saying which kind it is.
 *
 * PURELY A DRAWING QUESTION. The return leg is a second stroke on one edge,
 * never a second edge: the dependency still runs from `from` to `to`, and
 * `analyse` is not told about the leg at all. See EdgeKindSchema.
 */
export function edgeHasReturn(edge: Pick<GEdge, 'kind' | 'returns'>): boolean {
  if (edge.kind !== undefined) return RETURNING_KINDS.has(edge.kind);
  return edge.returns !== undefined;
}

export const DirectionSchema = z.enum(['DOWN', 'RIGHT']);
export type Direction = z.infer<typeof DirectionSchema>;

/**
 * Deepest container level a stored view may name. A diagram nested sixteen
 * boundaries deep has a bigger problem than its view setting, and the bound
 * keeps `{"depth": 1e9}` out of the document.
 */
export const MAX_VIEW_DEPTH = 16;

/**
 * ViewSetting — the stored view as a RULE rather than a list.
 *
 * `collapsed` is a list of group ids, so it answers "which groups are shut"
 * for the document as it was when the view was set. Rename a group, add a
 * fifth stage, wrap everything in a new outer boundary, and that answer is
 * silently wrong: the new group renders open because nobody named it.
 *
 * `view.depth` says the thing the reader actually meant — "draw containers
 * this many levels deep, collapse what is at that level" — and `collapsed` is
 * re-derived from it on every structural change (see view/depth.ts). Absent
 * means the document is holding an explicit list that someone chose by hand,
 * which is still the escape hatch and is never overwritten.
 */
export const ViewSettingSchema = z.object({
  /**
   * How many container levels are drawn open. 0 collapses every top-level
   * boundary; 1 opens those and collapses their children; a depth past the
   * bottom of the tree collapses nothing.
   */
  depth: z.number().int().min(0).max(MAX_VIEW_DEPTH),
});
export type ViewSetting = z.infer<typeof ViewSettingSchema>;

/** GraphDoc (spec §3.1). The single source of truth on disk. */
export const GraphDocSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string(),
  direction: DirectionSchema,
  nodes: z.array(GNodeSchema),
  groups: z.array(GGroupSchema),
  edges: z.array(GEdgeSchema),
  collapsed: z.array(z.string()),
  /**
   * The rule `collapsed` was derived from, when there is one. Optional so
   * every document written before this field existed still parses, and so an
   * explicitly chosen list stays explicit.
   */
  view: ViewSettingSchema.optional(),
});
export type GraphDoc = z.infer<typeof GraphDocSchema>;
