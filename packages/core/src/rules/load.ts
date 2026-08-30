// rules/load.ts — the canonical agent rules text (spec §4.4).
//
// One canonical source, surfaced four ways: embedded in the diagram_patch MCP
// tool description, printed by `diagram rules`, written into CLAUDE.md /
// AGENTS.md by `diagram init`, and installed as a Claude Code skill. There is
// no system prompt in this architecture, so this text IS the prompt.
//
// WHY THE TEXT IS EMBEDDED HERE RATHER THAN READ FROM DISK
// -------------------------------------------------------
// packages/core/rules.md lives outside src/, and core has no build step of its
// own: the CLI compiles core's sources alongside its own with rootDir set to
// packages/ (see packages/cli/tsconfig.build.json), so this file ends up at
// packages/cli/dist/core/src/rules/load.js. tsc copies .ts, never .md, and the
// published package ships dist/ — so any path derived from import.meta.url
// would point at a rules.md that is not there. An upward filesystem search
// would work in this repo and quietly fail once installed, which is the worst
// kind of failure: green in CI, broken for the user.
//
// So the markdown is inlined as string constants and this module touches the
// filesystem NOT AT ALL. It therefore behaves identically from src/ under
// vitest and from dist/ under `npm run build`. The cost is one duplicated
// copy of the text; tests/rules.test.ts asserts it is byte-for-byte equal to
// packages/core/rules.md and packages/core/rules-erd.md, so drift fails the
// suite rather than shipping. After editing either .md, regenerate the two
// constants below (the test failure prints which one is stale).
//
// compactRules() is DERIVED from RULES_MD rather than hand-written, for the
// same reason: a second hand-maintained copy of the rules is a second thing to
// forget to update.

/** Verbatim contents of packages/core/rules.md. */
const RULES_MD = `# Diagram engine — rules for building diagrams

You edit a structured diagram document through the diagram tools.
You NEVER produce coordinates, positions, or layout hints. A layout
engine handles all geometry. Emit meaning only.

## Element types
service   an application the user owns and deploys
database  a relational or document store
queue     kafka, sqs, rabbitmq, pubsub
cache     redis, memcached
storage   s3, gcs, blob storage
client    browser app, mobile app, cli
external  a third-party system the user does not control

## Group kinds
vpc, region, cluster, account, generic

## Patch shape

A patch is {"ops":[...],"summary":"..."}; both keys are required.
Every node and group needs "parent": a group id, or null for top level.

    {"summary":"add web","ops":[{"op":"addNode","node":{"id":"web",
    "type":"client","label":"Web app","parent":null}}]}

## Rules

1. CALL diagram_get FIRST if you are not sure of the current state.
   Reuse existing ids. "the auth service" and "auth" both mean the
   existing node "auth-service"; never create a second node for one
   concept.

2. IDS are lowercase-hyphenated, derived from the label:
   "Order Service" -> "order-service". Nodes and groups share one id
   namespace.

3. MINIMAL OPS. "Put X and Y in a vpc" is one addGroup plus two
   updateNode ops changing parent. Do not remove and re-add nodes.

4. EDGE DIRECTION POINTS AT THE DEPENDENCY: caller to callee. A
   service that reads a database has an edge FROM the service TO the
   database; the data flows back the other way, the arrow does not.
   CHECK EVERY EDGE: read it aloud as "<from> <label> <to>". "orders
   reads postgres" is right, "s3 reads etl" is backwards. A protocol
   label ("https", "grpc") is a noun, not a verb: the arrow still runs
   from whoever initiates the call.

5. EDGE LABELS are 1-3 words: "reads", "publishes", "grpc". Omit the
   label when the relationship is obvious from the types.

6. DASHED for asynchronous relationships (queue consumption, events,
   webhooks). Solid for synchronous calls.

7. GROUPS ARE TRUST AND DEPLOYMENT BOUNDARIES. Do not group things
   merely because they are related in topic.

8. DO NOT INVENT: A MENTION IS NOT A COMPONENT. A hostname in a
   README or a comment is prose, not a box; text saying a box is
   another team's or is not deployed here settles it — note it on the
   node it fronts, do not draw it. A browser, app or device the
   system serves is still a node, though no file deploys it.

9. IF READING A CODEBASE, cite the file each node and edge came from.

10. DELETION. "Remove the cache" means removeNode plus removeEdge for
    every edge touching it, in one patch.

11. IF A PATCH IS REJECTED, read the errors, fix them, and retry once.
    They list the valid ids, so do not call diagram_get for an id the
    error already gave you.

12. AFTER A LARGE CHANGE, tell the user what changed in one line; the
    viewer already shows the picture, do not describe it back.

14. REDUNDANCY IS TOLD, NEVER DEDUCED. When the user says two things
    are replicas, standbys or instances of one component, give their
    edges the same \`alt\` tag: alternatives, not two dependencies.
    Never infer it from code — two connection strings are not failover.
    Ask, or leave \`alt\` off: over-reporting a blast radius is
    survivable, a guessed \`alt\` hides a real single point of failure.

---

## Addendum — node metadata, redundancy and ERD mode

The rules above are unchanged. What follows is additional capability,
not a revision. (Rule 13, bindings, is not built yet; the numbering
leaves its place open.)

### Redundancy (\`alt\`)

An edge is a hard dependency: lose the target and the source is at
risk. Edges FROM ONE SOURCE that carry the same \`alt\` string are
alternatives instead — failure reaches the source only when EVERY edge
in that set is down. The tag is scoped per source node, must be on a
solid (synchronous) edge, and needs at least two edges to two distinct
targets. See rule 14: \`alt\` is recorded because the user said so.

### Node metadata (\`meta\`)

Any node may carry \`meta\`: a small map of short string keys to short
string values. The viewer shows it in a hover panel, revealed only when
the reader points at the node.

    meta: { region: "us-east-1", runtime: "node20", owner: "payments" }

- WHAT BELONGS THERE: the detail a reader asks for on demand — region,
  runtime or version, owning team, instance size, scaling notes, an
  on-call rotation, a repository name.
- KEEP IT SHORT. Keys are lowercase labels of 1-24 chars; values are up
  to 200 chars but a hover panel is not a document. At most 16 keys per
  node. "us-east-1", not a paragraph about the region.
- META IS NOT THE DIAGRAM. If a fact should be visible without hovering,
  it is not meta: it belongs in the label, the note, an edge, or the
  group structure. Do not hide the thing the user asked to see.
- META IS NOT GEOMETRY. Never put an x, y, width, height, or waypoint in
  meta. Rule zero still holds: you emit meaning, the layout engine
  decides position.
- Meta is allowed on every node type, including entities.

### ERD mode (\`entity\`)

There is a further node type beyond the seven listed above:

    entity  a database table / domain entity, drawn as a list of
            columns (\`fields\`) with crow's-foot relationship markers

Only \`entity\` nodes may carry \`fields\`, and only edges touching an
entity may carry \`cardinality\` ("1:1", "1:N", "N:1", "N:M").

Before building an ERD, read \`rules-erd.md\`. It is the canonical
instruction for entities, fields, foreign keys, and cardinality
direction. An ERD and an architecture diagram may coexist in one
document.
`;

/** Verbatim contents of packages/core/rules-erd.md. */
const ERD_RULES_MD = `# Diagram engine — rules for ERD diagrams

An ERD (entity relationship diagram — the picture of tables and how they
reference each other) uses the same document, the same tools, and the same
rule: you emit meaning, never coordinates. The layout engine decides where
every table sits and how every line is routed.

## When to use type "entity"

entity   one database table or one domain entity, drawn as a box with a
         list of columns

Use "entity" when the thing has COLUMNS you are showing. Use the
architecture types (service, database, queue, cache, storage, client,
external) when you are showing a system that RUNS. "Postgres" as a box in
an architecture diagram is type "database"; the "orders" table inside that
Postgres is type "entity".

Only "entity" nodes may carry fields. A patch putting fields on a service
is rejected with:

    node "api-gateway" has fields but type is "service":
    use type "entity" for tables with columns

## Fields

A field is one column:

    name      the column name, exactly as it is in the database
    type      the column type, 1-24 chars
    pk        true if the column is part of the primary key
    fk        true if the column is a foreign key into another entity
    nullable  true if the column accepts NULL
    note      an optional short annotation, 1-60 chars

Only \`name\` is required. Omitted \`nullable\` means "not stated", not "NOT
NULL" — do not set it unless you know.

A row on the diagram shows the name, the type and the PK/FK badges — one
line, never wrapped. A field \`note\` is not drawn on the row: it appears in
the hover panel, with everything else about the column. Write notes for
the reader who hovers, and keep what must be visible at a glance in the
name and the type.

## Rules

1. IDS COME FROM TABLE NAMES. The table "order_items" becomes the id
   "order-items" with label "order_items". Keep the label spelled the
   way the database spells it; the id is the slug.

2. FIELD NAMES ARE UNIQUE within one entity. A duplicate is rejected:

       entity "users" has duplicate field "email": field names must be
       unique within an entity; rename or remove one

3. AN EMPTY ENTITY IS LEGAL. Add the table now, add its columns in a
   later patch. You do not have to know every column to draw the box.

4. REAL TYPES ONLY. When you are reading an actual schema or migration,
   copy the database's own type strings: "uuid", "varchar(255)",
   "timestamptz", "numeric(10,2)", "jsonb". Do not normalise them to
   "string" or "int". When the user only described the table in prose,
   use the plain type they said, or omit the type entirely.

5. DO NOT INVENT COLUMNS. This is rule 8 of the main rules applied to
   tables: no "created_at", no "updated_at", no surrogate "id" unless
   you saw it in a migration, a model file, or the user's description.
   A table with three described columns gets three columns.

6. FOREIGN KEYS ARE MARKED. Set fk: true on the referencing column, and
   set pk: true on every column of the primary key — composite primary
   keys are normal, so several pk: true fields in one entity are fine.

7. CARDINALITY GOES ON THE EDGE, one of:

       "1:1"  "1:N"  "N:1"  "N:M"

   Read left-to-right as from:to. The viewer draws crow's-foot markers
   from it.

8. EDGE DIRECTION IS FK -> PK. The edge runs FROM the table holding the
   foreign key TO the table holding the primary key it points at. An
   "orders" table with a user_id column gives:

       from: "orders", to: "users", cardinality: "N:1"

   because many orders reference one user. Reverse the reading, not the
   edge, when it is more natural to say "a user has many orders" — that
   is the same edge with cardinality "N:1".

9. N:M NEEDS A JOIN TABLE if the database has one. If you can see the
   join table in the schema, draw it as its own entity with two N:1
   edges. Use "N:M" as a single edge only when you are describing the
   relationship at a level above the physical tables.

10. CARDINALITY NEEDS AN ENTITY. Putting it on an edge between two
    services is rejected:

        edge "e3" has cardinality but neither "web-client" nor
        "api-gateway" is an entity: drop the cardinality or change an
        endpoint to type "entity"

11. LABEL THE RELATIONSHIP, not the key. Edge labels are still 1-3
    words: "places", "belongs to", "owns". Omit the label when the
    cardinality and the fk column already say it.

12. ONE DOCUMENT CAN HOLD BOTH. An ERD and an architecture diagram can
    live in the same document. Put the entities in their own group (a
    group of kind "generic" labelled after the database) so the two
    halves read as two pictures. Edges may cross between them — a
    service to the entity it owns is a legitimate edge — but do not put
    cardinality on such an edge unless one end really is a table.

13. GROUPS STILL MEAN BOUNDARIES. For an ERD that is the schema or the
    database the tables live in, not "these three tables are about
    billing". Topic is not a boundary.
`;

/** Which canonical rules file to load: the core rules, or the ERD addendum. */
export type RulesVariant = 'core' | 'erd';

/**
 * The full core rules text — what `diagram rules` prints and what
 * `diagram init` writes into CLAUDE.md / AGENTS.md.
 */
export function loadRules(): string {
  return RULES_MD;
}

/**
 * The full ERD rules text — what `diagram rules --erd` prints. Deliberately a
 * separate document: an agent drawing an architecture diagram should not pay
 * for the tables-and-foreign-keys instructions it will never use.
 */
export function loadErdRules(): string {
  return ERD_RULES_MD;
}

/** Variant-selecting form of the two loaders above, for command plumbing. */
export function loadRulesFor(variant: RulesVariant): string {
  return variant === 'erd' ? ERD_RULES_MD : RULES_MD;
}

let compactCache: string | undefined;

/**
 * A compressed form of the core rules, sized for the diagram_patch tool
 * description (spec §4.1: "the tool description is the prompt"). The agent
 * pays for this text on every turn, so the compression is exactly this:
 *
 *   - the markdown scaffolding (title, "## " headings, blank lines) goes,
 *   - each numbered rule is unwrapped onto one line,
 *   - the meta / redundancy / ERD addendum is replaced by a two-line pointer,
 *   - the framing line in COMPACT_SKIP_LINES goes (see the note there).
 *
 * What is NOT dropped is any rule text. A half-quoted rule ("MINIMAL OPS.
 * Emit only what is needed. \"Put X and Y in a vpc\" is") reads as a mangled
 * instruction, and an instruction the agent half-follows is worse than one it
 * never saw. Derived from RULES_MD at first call and cached, so it cannot
 * drift from the canonical file.
 */
/**
 * Preamble sections kept in rules.md but LEFT OUT of the compact form.
 *
 * "Patch shape" is a worked JSON example of the patch envelope. The agent is
 * already handed that shape as diagram_patch's inputSchema — generated from
 * the same zod schema that validates the patch, so it cannot be out of date —
 * and this description sits beside it in the same tool listing. Paying ~250
 * characters per turn to restate it in prose is paying twice for one fact,
 * and it is the kind of growth that quietly consumes a size budget that
 * exists to protect a per-turn cost. It stays in the full text, which
 * `diagram rules` prints and a human reads.
 */
const COMPACT_SKIP_SECTIONS = new Set(['Patch shape']);

/**
 * Preamble LINES left out of the compact form, for the same reason as the
 * section above: the compact text is embedded in diagram_patch's description,
 * inside a tool listing that already names the diagram tools and their
 * schemas. "You edit a structured diagram document through the diagram tools."
 * is orientation for a human opening rules.md; to an agent already holding
 * those tools it is a sentence charged on every turn to say what the tool
 * listing has said. The next line — the no-geometry rule, which nothing else
 * states — stays. Matched whole, so a reworded line fails loudly (it reappears
 * in the compact output) rather than silently skipping the wrong text.
 */
const COMPACT_SKIP_LINES = new Set([
  'You edit a structured diagram document through the diagram tools.',
]);

export function compactRules(): string {
  if (compactCache !== undefined) return compactCache;

  // Only the twelve canonical rules — the "---" addendum (node meta and ERD
  // mode) is summarised in the pointer line at the end instead.
  const main = RULES_MD.split('\n---\n')[0] ?? RULES_MD;

  const preamble: string[] = [];
  const rules: string[] = [];
  let inRules = false;
  let skipping = false;

  for (const raw of main.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) continue; // the document title carries no rule
    if (line === '## Rules') {
      inRules = true;
      skipping = false;
      continue;
    }
    if (line.startsWith('## ')) skipping = COMPACT_SKIP_SECTIONS.has(line.slice(3).trim());
    if (skipping) continue;
    if (!inRules) {
      if (COMPACT_SKIP_LINES.has(line)) continue;
      // Headings become labels: "## Element types" -> "Element types:". The
      // column padding that aligns the type table for a human reader is
      // scaffolding like the markdown around it, so runs of spaces collapse:
      // "queue     kafka" -> "queue kafka", same words, fewer characters.
      if (line !== '')
        preamble.push(line.startsWith('## ') ? `${line.slice(3)}:` : line.replace(/ {2,}/g, ' '));
      continue;
    }
    if (line === '') continue;
    if (/^\d+\. /.test(line)) {
      rules.push(line); // a new rule starts here
    } else if (rules.length > 0) {
      // A wrapped continuation of the rule above: unwrap onto its line.
      rules[rules.length - 1] = `${rules[rules.length - 1]!} ${line.trim()}`;
    }
  }

  compactCache = [
    ...preamble,
    '',
    'Rules:',
    ...rules,
    '',
    // The pointer's whole job is (a) ERD mode exists, (b) go and read it. The
    // four cardinality literals it used to spell out are unusable without the
    // ERD rules on direction and join tables, which the agent is being sent to
    // read anyway — paying for them here bought a detail that cannot be acted
    // on alone.
    'ERD mode: type "entity" nodes hold table columns. Run `diagram rules --erd`',
    'before drawing tables.',
  ].join('\n');
  return compactCache;
}
