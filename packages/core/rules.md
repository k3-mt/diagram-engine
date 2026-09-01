# Diagram engine — rules for building diagrams

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

1. READ THE DIAGRAM FIRST if you are not sure of the current state.
   Reuse existing ids. "the auth service", "auth", and "authsvc" all
   refer to an existing node with id "auth-service". Never create a
   second node for the same concept.

2. IDS are lowercase-hyphenated, derived from the label:
   "Order Service" -> "order-service". Nodes and groups share one
   namespace, so ids must be unique across both.

3. MINIMAL OPS. Emit only what is needed. "Put X and Y in a vpc" is
   one addGroup plus two updateNode ops changing parent. Do not
   remove and re-add nodes.

4. EDGE DIRECTION POINTS AT THE DEPENDENCY: caller to callee. A
   service that reads a database has an edge FROM the service TO the
   database; the data flows back the other way, the arrow does not.
   CHECK EVERY EDGE by reading it aloud as "<from> <label> <to>":
   "orders reads postgres" is right, "s3 reads etl" is backwards. A
   protocol label ("https", "grpc") is a noun, not a verb: there the
   arrow still runs from whoever initiates the call.

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

9. IF READING A CODEBASE, cite in `bindings` the file each node and
   edge came from. Do not guess at connections.

10. DELETION. "Remove the cache" means removeNode plus removeEdge for
    every edge touching it, in one patch.

11. IF A PATCH IS REJECTED, read the errors, fix them, and retry once.

12. AFTER A LARGE CHANGE, tell the user what changed in one line; the
    viewer already shows the picture, do not describe it back.

14. REDUNDANCY IS TOLD, NEVER DEDUCED. When the user says two things
    are replicas or standbys, give their edges the same `alt`:
    alternatives, not two dependencies. Never infer it from code. Ask,
    or leave `alt` off — a guessed `alt` hides a real single point of
    failure, and over-reporting is survivable.

15. CITE WHAT YOU OPENED, NOTHING ELSE. Record a `bindings` entry only
    for a file you read the identifier out of. `diagram check
    --bindings` resolves every one, so an invented citation does not
    survive the next commit.

---

## Addendum — node metadata, redundancy and ERD mode

The rules above are unchanged. What follows is additional capability,
not a revision. (There is no rule 13; the number was reserved for
bindings while they were unbuilt and they arrived as rule 15, so the
gap is left rather than renumbering rules the benchmark was tuned on.)

### Bindings (`bindings`) — where a claim was read

Any node and any edge may carry `bindings`: the files you read it out
of. Nothing else in the document can hold an edge citation, so this is
how rule 9 is kept.

    bindings: [{ "source": "repo", "ref": "internal/pay.go", "line": 412 }]

- `source` is one of `repo`, `compose`, `terraform`, `k8s-manifest`,
  `package`, lowercase, at most one entry per source per element.
- `ref` is a repo-relative path (`services/orders/`, `internal/pay.go`)
  or an identifier inside a file (`orders-api`,
  `aws_ecs_service.orders`). Never a URL, never absolute, never `..`.
- `line` is 1-based and only for a ref that names a file.
- At most 8 bindings on a node, 4 on an edge.
- A BINDING IS PROVENANCE, NOT STATUS. It says where you read the
  claim. It never says anything about a running system — no health, no
  timestamps, no "last checked".
- `diagram check --bindings` resolves every path ref against the
  filesystem. See rule 15: a citation that does not resolve is worse
  than no citation, because it reads as evidence.
- A `repo` ref is ALWAYS a path and is always resolved, whatever it
  looks like: `repo=schema.prisma` is checked and reported missing if
  it is not there. An identifier is only for the other four sources —
  a compose service key, a terraform address, a manifest resource
  name, a package name — and those are RECORDED BUT NOT VERIFIED. The
  path ref is the one that carries weight; prefer it where you have it.
- Two files under one source is not two bindings: cite the directory
  they share, or the one file the claim actually came from. If you read
  a component out of both a handler and a config file, the handler with
  its line is the stronger citation.
- To take bindings off, `updateNode`/`updateEdge` with `"bindings": []`.

### Redundancy (`alt`)

An edge is a hard dependency: lose the target and the source is at
risk. Edges FROM ONE SOURCE that carry the same `alt` string are
alternatives instead — failure reaches the source only when EVERY edge
in that set is down. The tag is scoped per source node, must be on a
solid (synchronous) edge, and needs at least two edges to two distinct
targets. See rule 14: `alt` is recorded because the user said so.

To take a tag back off, `updateEdge` with `"alt": null` — one op, same edge
id. `""` is not a tag and is rejected; an omitted key means "leave it
alone". `label` and `cardinality` clear the same way.

### Node metadata (`meta`)

Any node may carry `meta`: a small map of short string keys to short
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

### ERD mode (`entity`)

There is a further node type beyond the seven listed above:

    entity  a database table / domain entity, drawn as a list of
            columns (`fields`) with crow's-foot relationship markers

Only `entity` nodes may carry `fields`, and only edges touching an
entity may carry `cardinality` ("1:1", "1:N", "N:1", "N:M").

Before building an ERD, read `rules-erd.md`. It is the canonical
instruction for entities, fields, foreign keys, and cardinality
direction. An ERD and an architecture diagram may coexist in one
document.
