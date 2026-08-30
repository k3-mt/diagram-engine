# Prompt-Driven Architecture Diagramming Engine
## Product Requirements & Complete Build Specification

**Version:** 2.0 — local agent architecture, no API keys
**Status:** Ready for implementation
**Scope:** Proof of concept — model dictation only, no mouse editing

---

# Part 1 — Product Requirements

## 1.1 The problem

Drawing an architecture diagram or an ERD (entity relationship diagram — boxes for database tables, lines for how they link) is slow. In Lucidchart or Excalidraw most of your time goes on placement: dragging boxes, aligning them, untangling lines. The thinking part takes two minutes. The drawing part takes forty.

Text-to-diagram tools (Mermaid, PlantUML, D2) fix the input problem but not the output problem. You still hand-write a strict syntax, and the result looks generated: containers that don't read well, line crossings that just overlap ambiguously, no sense of who the diagram is for.

## 1.2 The product

**A local engine that the developer's existing terminal agent drives.**

You are already sitting in a terminal running Claude Code, Codex CLI, Cursor's agent, or similar. You install this engine into your project. You run one command to open a viewer in your browser. Then you talk to your agent as normal, and the diagram builds itself in the viewer window beside you.

```
─── terminal ──────────────────┐  ┌─── browser: localhost:4400 ───┐
$ claude                       │  │                               │
                               │  │      [live diagram]           │
> we run a react client and    │  │                               │
  an ios app, both hit an      │  │                               │
  api gateway                  │  │                               │
                               │  │                               │
  ⏺ diagram_patch(4 ops)       │  │                               │
    ✓ 4 nodes, 3 edges         │  │                               │
                               │  │                               │
> put postgres in a vpc        │  │                               │
                               │  │                               │
  ⏺ diagram_patch(3 ops)       │  │                               │
    ✓ group added, 2 moved     │  │                               │
└───────────────────────────────┘  └───────────────────────────────┘
```

## 1.3 No API. Ever.

**Hard constraint.** This project ships no API key handling, no `ANTHROPIC_API_KEY`, no HTTP client to any model provider, no token accounting, no `.env` with a secret in it. The engine has no model in it at all.

The intelligence is whatever the developer is already running and already paying for. The engine is a **tool the agent picks up**, in exactly the way it picks up `git` or `grep`.

**Why this is the better design, not just a constraint:**

| | API architecture | Local agent architecture |
|---|---|---|
| Keys | You handle secrets, rotation, leaks | None exist |
| Cost | You or the user pays per diagram | Already covered by their subscription |
| Model choice | You pin one model | Claude, Codex, Gemini, local Llama — their call |
| Context | The engine knows only what's typed | The agent has already read the codebase |
| Retry on bad output | You write a retry loop | The agent self-corrects for free |
| Distribution | A hosted service | `npx diagram-engine` |
| Offline | Impossible | Works with a local model |

The context point is the sleeper advantage. When an agent that has just read your `docker-compose.yml` and your Terraform is the thing producing the diagram, "diagram our infrastructure" is a real instruction, not a prompt you have to hand-write.

**The retry point matters too.** In an API design you write code to catch a bad patch, reformat the errors, and re-prompt. Here, the engine returns validation errors as a tool result, the agent reads them, and it fixes its own mistake on the next tool call. That entire subsystem disappears.

## 1.4 Core principle (unchanged)

**The model never emits coordinates.**

- Agent produces **meaning**: nodes, types, containment, edges.
- Layout engine produces **geometry**: x, y, width, height, waypoints.
- Renderer produces **pixels**: SVG paths, hop arcs, labels.

Language models are good at pulling structure out of prose and bad at spatial packing. Layout engines are the reverse. Keep them apart.

## 1.5 Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Prose to first diagram in one turn | A 100-word description produces a correct diagram, no follow-up |
| G2 | Works with any agent | Claude Code and one non-MCP agent both drive it |
| G3 | Edits are incremental | Turn 5 preserves every node ID from turn 1 not explicitly changed |
| G4 | Layout is stable | Adding one leaf node moves nothing else by more than 20% of canvas width |
| G5 | Crossings are unambiguous | Every crossing renders a hop arc; zero flat overlaps |
| G6 | Fast enough to think in | Tool call to repainted canvas under 400ms |
| G7 | One document, many audiences | Exec and engineer views derive without a model turn |
| G8 | Zero secrets | `grep -ri "api_key" src/` returns nothing |

## 1.6 Non-goals

- Any model integration, API client, or key management.
- Mouse editing. No dragging, selecting, or resizing.
- Multi-user collaboration.
- A hosted service or account system.
- Freehand drawing, sticky notes, arbitrary text boxes.
- Import from Mermaid / PlantUML / draw.io.
- Mobile. Desktop, minimum 1280px.

## 1.7 Views

Three audiences, one document. Views derive by collapsing groups — never by re-prompting.

| View | Shows | Derivation |
|---|---|---|
| **Exec** | 5–9 boxes, all groups collapsed | `collapsed = root-level group IDs` |
| **Engineer** | Everything expanded, labels on | `collapsed = []` |
| **Focus** | One group open, siblings shut | `collapsed = allGroups − [id] − ancestors(id)` |

Collapsing merges edges: three edges from inside `vpc-private` to `api-gateway` become one, labelled `×3`.

## 1.8 Success criteria

In front of an observer, in a terminal:

1. A pasted paragraph becomes a legible diagram in one agent turn.
2. A follow-up turn adds a container around existing nodes without scrambling layout.
3. At least one crossing shows a clean hop arc.
4. `diagram view exec` collapses instantly with no model turn.
5. The agent makes a deliberate mistake (bad node reference), sees the error, and corrects itself unprompted.
6. `grep -r ANTHROPIC` finds nothing.

---

# Part 2 — System Architecture

## 2.1 Process topology

Two long-lived processes on the developer's machine. Neither talks to the internet.

```
┌────────────────────────────────────────────────────────────┐
│ Developer's terminal                                       │
│   $ claude    (or codex, cursor-agent, aider, ollama...)   │
└───────────────┬────────────────────────────────────────────┘
                │ stdio (MCP)  ── or ──  shell out to CLI
                ▼
┌────────────────────────────────────────────────────────────┐
│ PROCESS A: diagram-mcp  (short-lived, agent owns lifecycle)│
│   tools: get, patch, undo, redo, view, export, reset       │
│   • Zod validation                                         │
│   • atomic patch application                               │
│   • history                                                │
│   • writes .diagram/graph.json                             │
└───────────────┬────────────────────────────────────────────┘
                │ file write
                ▼
        .diagram/graph.json    ← single source of truth, on disk
                │
                │ chokidar watch
                ▼
┌────────────────────────────────────────────────────────────┐
│ PROCESS B: diagram serve   (long-lived, user starts it)    │
│   • static viewer on http://localhost:4400                 │
│   • WebSocket push on file change                          │
└───────────────┬────────────────────────────────────────────┘
                │ ws
                ▼
┌────────────────────────────────────────────────────────────┐
│ Browser viewer                                             │
│   view derive → ELK layout (worker) → hops → SVG render    │
└────────────────────────────────────────────────────────────┘
```

**Why disk is the interface between them.** The MCP process lives and dies with the agent session. The viewer should not. Putting the document on disk decouples them completely: restart Claude Code and the viewer keeps showing the diagram. It also means the file-protocol fallback (§4.3) is free — it's the same file.

**Why layout runs in the browser.** ELK is a browser-oriented library, text measurement needs a canvas context, and rendering needs a DOM. Keeping stages 3–6 client-side means the MCP server is a small dependency-light Node process that starts in under 100ms, which matters because the agent spawns it on every session.

## 2.2 Pipeline stages

```
agent intent
     │  MCP tool call: diagram_patch({ ops, summary })
     ▼
  1. DOCUMENT   validate → apply atomically → history → write graph.json
     │
     ▼  file change event
  2. VIEW       collapse groups, merge edges          (pure, <1ms)
     │
     ▼
  3. LAYOUT     elkjs: layered, orthogonal, hierarchical (Web Worker)
     │
     ▼
  4. GEOMETRY   flatten coords → find crossings → insert hops → round corners
     │
     ▼
  5. RENDER     React SVG, layered z-order
```

Every stage is a pure function. You can develop and test all of stages 2–5 against fixture files with no agent running at all.

## 2.3 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5 | Shared types across packages |
| MCP server | `@modelcontextprotocol/sdk`, stdio transport | The interop standard. Claude Code, Codex CLI, Cursor, Windsurf, Zed all speak it |
| CLI | `commander` | Same core, for agents without MCP |
| Validation | Zod | One schema, TS types and runtime checks |
| Watcher | `chokidar` | Reliable cross-platform file watching |
| Viewer server | `ws` + Node `http` serving prebuilt assets | No framework needed |
| Viewer build | Vite 5 + React 18 | Fast HMR while developing the renderer |
| Layout | `elkjs` 0.9.x | Only JS engine with hierarchical containers **and** orthogonal routing |
| Tests | Vitest | Same toolchain |

**Not used:** any HTTP client to a model provider. No `openai`, no `@anthropic-ai/sdk`, no `dotenv`. Add a CI check that fails the build if any of these appear in `package.json`.

**Do not use** `react-flow` (assumes mouse editing), `dagre` (no containers, no orthogonal routing), or `mermaid` (no access to geometry, so hops are impossible).

## 2.4 Repository layout

Monorepo, three packages, npm workspaces.

```
diagram-engine/
├── package.json                    # workspaces: packages/*
├── packages/
│   ├── core/                       # no DOM, no network, no deps beyond zod
│   │   ├── schema/
│   │   │   ├── graph.ts            # GraphDoc, GNode, GGroup, GEdge
│   │   │   ├── patch.ts            # GraphPatch, PatchOp
│   │   │   └── jsonSchema.ts       # generated from zod, for MCP tool defs
│   │   ├── document/
│   │   │   ├── apply.ts            # applyPatch — atomic
│   │   │   ├── validate.ts         # V1–V10 invariants
│   │   │   ├── history.ts
│   │   │   └── ids.ts
│   │   ├── view/derive.ts          # collapse + edge merge
│   │   ├── store/
│   │   │   ├── paths.ts            # .diagram/ resolution
│   │   │   ├── read.ts
│   │   │   └── write.ts            # atomic: tmp + rename
│   │   ├── format/
│   │   │   ├── table.ts            # GraphDoc -> compact text for agents
│   │   │   └── summary.ts          # patch -> "+3 nodes, 2 edges"
│   │   └── rules.md                # THE canonical agent instructions
│   │
│   ├── cli/                        # bin: diagram, diagram-mcp
│   │   ├── bin/diagram.ts
│   │   ├── bin/diagram-mcp.ts
│   │   ├── commands/
│   │   │   ├── init.ts             # write .mcp.json, CLAUDE.md, AGENTS.md, skill
│   │   │   ├── serve.ts            # viewer + watcher
│   │   │   ├── patch.ts            # accepts JSON on stdin
│   │   │   ├── get.ts  undo.ts  redo.ts  view.ts  export.ts  check.ts
│   │   │   └── rules.ts            # cat the rules for any agent
│   │   ├── mcp/
│   │   │   ├── server.ts
│   │   │   └── tools.ts            # 7 tool definitions
│   │   └── serve/
│   │       ├── http.ts
│   │       └── watch.ts
│   │
│   └── viewer/                     # browser bundle, built into cli/dist/public
│       ├── src/
│       │   ├── main.tsx
│       │   ├── ws.ts               # reconnecting client
│       │   ├── layout/
│       │   │   ├── measure.ts  toElk.ts  fromElk.ts  options.ts  worker.ts
│       │   ├── geometry/
│       │   │   ├── segments.ts  crossings.ts  hops.ts  corners.ts  path.ts
│       │   └── render/
│       │       ├── Canvas.tsx  GroupRect.tsx  NodeBox.tsx  EdgePath.tsx
│       │       ├── icons.tsx  theme.ts  StatusBar.tsx
│       └── vite.config.ts
└── tests/fixtures/
```

## 2.5 On-disk layout

```
<project>/.diagram/
├── graph.json           # the document — single source of truth
├── history/
│   ├── 0000.json ... 0042.json
│   └── pointer          # plain integer
├── errors.txt           # last validation failure, for file-protocol agents
└── out.svg              # written on `diagram export`
```

Commit `graph.json` to git. Add `history/`, `errors.txt`, and `out.svg` to `.gitignore` — `diagram init` does this.

**Atomic writes.** Always write to `graph.json.tmp` then `fs.renameSync`. The viewer watches this file; a partial read renders a broken diagram and, worse, a chokidar event on a half-written file will throw a JSON parse error into your reconnect loop.

**Concurrency.** Assume one writer. Take an exclusive `.diagram/.lock` (`fs.openSync` with `wx`) for the read-modify-write cycle, with a 2s stale timeout. Two agent turns racing on the same base document is the realistic failure and it silently loses a patch without this.

---

# Part 3 — Data Model

## 3.1 The graph document

The only persistent state. Everything else derives.

```ts
export type NodeType =
  | 'service'    // an application you own
  | 'database'   // relational or document store
  | 'queue'      // kafka, sqs, rabbit, pubsub
  | 'cache'      // redis, memcached
  | 'storage'    // s3, gcs, blob
  | 'client'     // browser, mobile app, cli
  | 'external'   // third party you don't control
  | 'entity';    // a database table / domain entity (ERD mode) — §3.6

export type GroupKind = 'vpc' | 'region' | 'cluster' | 'account' | 'generic';

export interface GNode {
  id: string;            // stable slug, never reused
  label: string;         // 1–40 chars
  type: NodeType;
  parent: string | null; // group id or null
  note?: string;         // optional second line, 1–60 chars
  fields?: GField[];     // ERD columns, max 40 — only on type 'entity' (§3.6)
  meta?: GMeta;          // free-form detail for the hover panel, max 16 keys (§3.7)
}

export interface GGroup {
  id: string;
  label: string;
  kind: GroupKind;
  parent: string | null;
}

export interface GEdge {
  id: string;
  from: string;          // node id OR group id
  to: string;
  label?: string;        // 1–24 chars
  style?: 'solid' | 'dashed';
  arrow?: 'forward' | 'both' | 'none';
  cardinality?: Cardinality;  // ERD multiplicity, drawn crow's-foot (§3.6)
}

export interface GraphDoc {
  schemaVersion: 1;
  title: string;
  direction: 'DOWN' | 'RIGHT';
  nodes: GNode[];
  groups: GGroup[];
  edges: GEdge[];
  collapsed: string[];
}
```

**ID format:** `^[a-z][a-z0-9-]{0,47}$`. Nodes and groups share one namespace, because edges can reference either.

**Never stored:** any x, y, width, height, waypoint, or path string. If you catch yourself persisting geometry, you've broken the core principle.

## 3.2 The patch

```ts
export type PatchOp =
  | { op: 'addNode';      node: GNode }
  | { op: 'updateNode';   id: string; changes: Partial<Omit<GNode,'id'>> }
  | { op: 'removeNode';   id: string }
  | { op: 'addGroup';     group: GGroup }
  | { op: 'updateGroup';  id: string; changes: Partial<Omit<GGroup,'id'>> }
  | { op: 'removeGroup';  id: string; reparentTo?: string | null }
  | { op: 'addEdge';      edge: GEdge }
  | { op: 'updateEdge';   id: string; changes: Partial<Omit<GEdge,'id'>> }
  | { op: 'removeEdge';   id: string }
  | { op: 'setTitle';     title: string }
  | { op: 'setDirection'; direction: 'DOWN' | 'RIGHT' };

export interface GraphPatch { ops: PatchOp[]; summary: string }
```

`removeGroup` with `reparentTo` moves children instead of deleting them — that's what "flatten the vpc" means.

## 3.3 Validation invariants

Run after every patch, before committing. Error strings are part of the contract: **the agent reads them and self-corrects, so they must say what to do.**

| # | Rule | Error message |
|---|---|---|
| V1 | IDs match the slug regex | `invalid id "Auth Service": use lowercase-hyphenated, e.g. "auth-service"` |
| V2 | No duplicate ID across nodes ∪ groups | `duplicate id "postgres": already exists as a node` |
| V3 | `parent` refers to an existing group | `node "cache" has unknown parent "vpc". Existing groups: vpc-private, region-eu` |
| V4 | No cycle in the group parent chain | `group cycle: vpc-a → vpc-b → vpc-a` |
| V5 | Edge endpoints exist | `edge "e12" references unknown node "redis". Did you mean "redis-cache"?` |
| V6 | No self-edges | `edge "e12" connects "auth" to itself` |
| V7 | No duplicate edge (same from, to, label) | `duplicate edge auth → postgres "reads"` |
| V8 | ≤ 200 elements | `graph too large (201). Remove elements or split the diagram` |
| V9 | Label lengths in bounds | `label too long (54 chars, max 40): "..."` |
| V10 | No edge from a group to its own descendant | `edge from "vpc" to its child "postgres"` |
| V11 | No duplicate field name within one entity | `entity "users" has duplicate field "email": field names must be unique within an entity; rename or remove one` |
| V12 | `fields` only on type `entity` | `node "api-gateway" has fields but type is "service": use type "entity" for tables with columns` |
| V13 | `cardinality` needs at least one entity endpoint | `edge "e3" has cardinality but neither "web-client" nor "api-gateway" is an entity: drop the cardinality or change an endpoint to type "entity"` |

V11–V13 are the ERD invariants (§3.6). Two omissions there are deliberate: an entity with
no fields passes, and `meta` is never type-checked against the node's type. V13 also stays
quiet when an endpoint id is unknown — V5 already reports that, and two errors for one
mistake makes the agent fix the wrong thing.

V3 and V5 append the valid options. That one detail turns a two-turn correction into a one-turn one, because the agent doesn't have to call `diagram_get` to find out what exists.

## 3.4 Atomic application

```ts
export function applyPatch(doc: GraphDoc, patch: GraphPatch):
  | { ok: true;  doc: GraphDoc; summary: string }
  | { ok: false; errors: string[] } {

  const next = structuredClone(doc);
  const errors: string[] = [];

  for (const [i, op] of patch.ops.entries()) {
    try { applyOp(next, op); }
    catch (e) { errors.push(`op ${i} (${op.op}): ${(e as Error).message}`); }
  }
  if (errors.length) return { ok: false, errors };

  const v = validate(next);
  if (!v.ok) return { ok: false, errors: v.errors };

  return { ok: true, doc: next, summary: summarise(doc, next) };
}
```

Never partially apply. A rejected patch leaves `graph.json` untouched and returns the errors as the tool result. The agent fixes it.

## 3.5 ID collision coercion

The agent will occasionally reuse an ID. Coerce rather than reject:

- `addNode` with an existing ID → treat as `updateNode`. It almost always means "this thing, with these properties."
- `addGroup` with an existing ID → same.
- `addEdge` with an existing ID but different endpoints → assign `e-${nextCounter}`.

Report each coercion in the tool result under a `notes` field. It's how you diagnose whether your rules text is working.

## 3.6 ERD mode — entities, fields, cardinality

Shipped in commit `00bf950`. Originally Part 13 item 2; it is now part of the data model,
and every invariant, formatter, and renderer below is live.

An **entity** is a database table or domain object. It is a `NodeType` like any other, so
it groups, connects, collapses, and lays out with no special handling — the only
difference is that it carries columns and the renderer draws it as a table (§8.5).

```ts
export interface GField {
  name: string;        // column name, 1–40 chars
  type?: string;       // as you would write it in DDL: "uuid", "varchar(255)". 1–24 chars
  pk?: boolean;        // part of the primary key
  fk?: boolean;        // foreign key into another entity
  nullable?: boolean;  // omitted means "unspecified", NOT "not null"
  note?: string;       // short annotation, 1–60 chars
}

export type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M';
```

**`N:1` exists alongside `1:N` on purpose.** Direction is then expressible without
reversing the edge's `from`/`to`, so an ERD edge can keep pointing the way the data
actually flows while still reading correctly at both ends.

**A field list is meaning, not geometry.** The document says which columns exist and what
they mean; the viewer decides where a row lands and what it can fit. `MAX_FIELDS = 40` per
entity — past that a table stops being legible and should be split.

**An entity with zero fields is valid.** The agent commonly names the tables in one turn
and fills in columns in the next; rejecting the intermediate state would force it to hold
the whole schema in one patch.

## 3.7 Node metadata

```ts
export type GMeta = Record<string, string>;   // max 16 keys
```

Free-form detail the agent attaches to **any** node — not just entities — which the viewer
reveals in a hover panel (§8.6). Owner, SLA, runbook link, the repo path it was read from.

- Keys match `^[a-z][a-z0-9_-]{0,23}$`: short labels like `owner` or `team_slack`, not
  sentences. Values are 1–200 chars. At most `MAX_META_KEYS = 16` entries.
- **Deliberately unconstrained by node type.** `fields` are columns, so they only mean
  something on an entity; metadata is general-purpose and belongs anywhere.
- **The geometry ban applies here too.** `meta` is the obvious place to smuggle in an x/y
  and call it annotation. Don't. It breaks §1.4 just as thoroughly as a coordinate on the
  node would.

Metadata is how an agent that has read the codebase records *where a node came from*, which
is what makes rule 9 of the agent rules (cite what you found) checkable rather than a hope.

## 3.8 Bindings — provenance, and the check that makes it real

**Not built. This is P5-01 to P5-03.**

Agent rule 9 says *cite the file each node and edge came from*. Today that is
unenforceable, and the benchmark says so: on the held-out reference system the agent finds
the planted hidden edge in 20 of 20 runs, points it the right way in 20 of 20, and cites it
to its source file in **2**. The reason is structural, not behavioural — `GEdge` has no
`note`, no `meta` and no binding, so **there is physically nowhere to put an edge citation.**
The rule asks for something the schema cannot hold.

```ts
export type BindingSource =
  | 'repo' | 'compose' | 'terraform' | 'k8s-manifest' | 'package';

export interface GBinding {
  source: BindingSource;
  ref: string;        // repo-relative path or identifier, never a URL
  line?: number;      // 1-based, when the claim is about one line
}

export interface GNode { /* ... */ bindings?: GBinding[] }   // max 8
export interface GEdge { /* ... */ bindings?: GBinding[] }   // max 4
```

A binding says **where a claim was read**, never anything about a running system (R5).
`repo=services/orders/`, `compose=orders-api`, `terraform=aws_ecs_service.orders`. It is
§4.1's `### Meta` idea made checkable.

### Invariants

| # | Rule | Error message |
|---|---|---|
| V14 | `source` is on the known list | `binding source "Compose" on node "orders": use lowercase, one of repo, compose, terraform, k8s-manifest, package` |
| V15 | No duplicate `source` on one element | `node "orders" has two "compose" bindings: one entry per source` |
| V16 | `ref` is repo-relative, never a URL | `binding ref on "orders" must be a repo-relative path, not a URL` |
| V17 | ≤ 8 bindings per node, ≤ 4 per edge | `node "orders" has 9 bindings, max 8` |

### The deterministic check

Invariants only prove a binding is well-formed. **A citation to a file that does not exist
is worse than no citation**, because it reads as evidence. So provenance needs a checker
that touches the filesystem, and it must be deterministic — no model, no judgement, exit 0
or exit 1:

```
diagram check --bindings [--root <path>]
```

For every binding: does `ref` resolve under `--root`? If `line` is given, does the file have
that many lines? Report each failure with the element it came from, and exit non-zero if any
fail. Terse, like everything else (§4.1):

```
bindings — 14 elements, 22 bindings
  ok        20
  missing    1   orders    repo=services/orders/   no such path
  stale      1   e7        repo=internal/pay.go:412   file has term lines
```

### Identifier refs must be checkable too

A ref that names a thing *inside* a file — `terraform=aws_ecs_service.orders`,
`compose=orders-api`, `package=@acme/orders` — cannot be resolved as a path. Reporting it
`ok` would be the exact lie this feature prevents, so the first implementation reported it
`unchecked`. Honest, but it left **about a quarter of all citations asserted rather than
verified**, invisible behind a headline precision of 1.0.

Identifier refs are checkable, and deterministically. For each source, look in the files
that source can live in, and match a **structured pattern** — never a bare substring, which
would report a citation `ok` because the string appears in a comment:

| source | searched in | must match |
|---|---|---|
| `terraform` | `*.tf` | `resource "aws_ecs_service" "orders"`, and the `module`/`data`/`variable` forms |
| `compose` | `docker-compose*.y*ml`, `compose*.y*ml` | a service key under `services:` |
| `package` | `package.json` | the `name` field, exactly |
| `k8s-manifest` | `*.yaml`, `*.yml` | a document whose `kind` and `metadata.name` both match |

Three rules keep this honest:

1. **No candidate file of the right kind → `missing`, not `unchecked`.** Citing Terraform in
   a repository with no `.tf` file is a wrong citation, and saying so is the point.
2. **A pattern that cannot be written precisely stays `unchecked`.** Guessing is worse than
   admitting. The count of unchecked bindings is always reported, so the gap is visible
   rather than absorbed into a passing number.
3. **The search is bounded and deterministic**: same tree, same answer, every time. It reads
   only files under `--root`, and only files of the kind the source names.

`unchecked` should approach zero on a real repository. It is a residue, not a category the
tool is comfortable with.

Three properties make this worth building rather than a nicety:

1. **It runs in CI.** A diagram whose citations no longer resolve is a diagram that has
   drifted from the code, and that is detectable on every commit without an agent.
2. **It is the honest half of rule 9.** An agent can invent a citation; it cannot invent one
   that resolves. Precision becomes measurable rather than asserted — which is what turns
   acceptance G10 and G11 from claims into tests.
3. **It is checkable by the eval harness** (P5-02), so binding precision joins direction and
   invention as a number the benchmark reports.

### The rule this makes enforceable

> **15. CITE WHAT YOU OPENED, NOTHING ELSE.** Record a binding only for a file you actually
> read the identifier out of. `diagram check --bindings` resolves every one of them against
> the filesystem, so an invented citation does not survive the next commit — it just makes
> the diagram look sourced while being wrong, which is worse than leaving it out.

The sanction has to be in the rule text. An agent told merely to cite will cite; an agent
told the citation is mechanically verified has a reason to cite only what it read.

---

# Part 4 — The Agent Interface

Three ways in, one core. Every path goes through `applyPatch` and gets identical validation.

## 4.1 Path A — MCP server (primary)

MCP (Model Context Protocol — the open standard for exposing tools to coding agents over stdio) is supported by Claude Code, Codex CLI, Cursor, Windsurf, Zed, and Continue. This is the good path.

`diagram init` writes `.mcp.json` into the project root:

```json
{
  "mcpServers": {
    "diagram": {
      "command": "npx",
      "args": ["-y", "diagram-engine", "mcp"],
      "env": { "DIAGRAM_DIR": "${workspaceFolder}/.diagram" }
    }
  }
}
```

The agent picks it up on next launch. Seven tools:

| Tool | Input | Returns |
|---|---|---|
| `diagram_get` | `{ }` | Compact text table of the current graph |
| `diagram_patch` | `{ ops[], summary }` | `ok` + change summary + notes, **or** the error list |
| `diagram_undo` | `{ }` | New state summary |
| `diagram_redo` | `{ }` | New state summary |
| `diagram_view` | `{ preset }` or `{ collapsed[] }` | Confirmation |
| `diagram_export` | `{ format, path }` | Written path |
| `diagram_reset` | `{ confirm: true }` | Confirmation |

**Tool result format matters more than you'd expect.** Return terse structured text, not JSON. The agent reads it as context on every turn, so verbosity costs tokens and attention.

```
ok — 3 nodes, 2 edges added
graph: 11 nodes, 2 groups, 9 edges
notes: coerced addNode "auth" to updateNode (id exists)
```

On failure:

```
rejected — no changes applied
  op 2 (addEdge): edge "e7" references unknown node "redis".
                  Did you mean "redis-cache"?
  op 4 (addNode): invalid id "Order Service": use lowercase-hyphenated
```

**`diagram_get` output** — the same compact table you'd send an API. Cheaper than JSON and models read it more reliably:

```
## "Checkout platform"  (direction: DOWN)

### Groups (id | kind | label | parent)
vpc-private | vpc | Private VPC | -

### Nodes (id | type | label | parent)
web-client    | client   | Web Client     | -
api-gateway   | service  | API Gateway    | -
postgres      | database | Postgres       | vpc-private

### Edges (id | from -> to | label | style)
e1 | web-client -> api-gateway  | https  | solid
e4 | orders -> kafka            | events | dashed
```

**Three sections appear only when the document uses them**, so an architecture-only diagram costs the agent exactly what it did before ERD mode existed (§3.6). When entities are present:

```
### Edges (id | from -> to | label | style | cardinality)
e7 | orders -> users | places | solid | N:1

### Entities (id | fields)
users  | id:uuid PK, email:citext (lowercased on write), created_at:timestamptz?
orders | id:uuid PK, user_id:uuid FK, total_cents:integer

### Meta (id | key=value)
orders | owner=payments-team, source=services/orders/schema.sql
```

A field renders as `name:type`, with `?` for nullable, ` PK` / ` FK` for keys, and any note in parentheses. Type is omitted when unknown. The `cardinality` column appears on the edges table only when some edge carries one, and shows `-` for the edges that don't.

Keep field notes free of commas where you can: the column list is comma-joined, and while the parentheses disambiguate it for a careful reader, the table is optimised for an agent skimming it.

The `### Meta` section is what makes rule 9 of the agent rules — cite what you found — verifiable rather than aspirational: `source=services/orders/schema.sql` is a claim you can go and check.

**The tool description is the prompt.** There's no system prompt in this architecture, so `diagram_patch`'s description carries the rules. Compressed version inline in the tool schema; full text in `packages/core/rules.md`, reachable via `diagram rules`.

## 4.2 Path B — CLI (universal fallback)

Every MCP tool has a CLI twin. Any agent that can run a shell command can drive the engine, including ones with no MCP support at all.

```bash
diagram get                                    # the table
diagram patch --stdin <<< '{"ops":[...]}'      # apply
diagram patch --file ops.json
diagram undo | diagram redo
diagram view exec | eng | focus <id>
diagram export svg --out arch.svg
diagram check                                  # validate without changing
diagram rules                                  # print the agent instructions
```

Exit code `0` on success, `1` on validation failure with errors on stderr. Agents read stderr.

## 4.3 Path C — File protocol (last resort)

For agents that only read and write files. The document is JSON on disk; let them edit it directly.

`diagram serve --watch-doc` validates `graph.json` on every change. If invalid, it writes the errors to `.diagram/errors.txt` and does **not** repaint. `diagram init` adds a line to `CLAUDE.md` / `AGENTS.md` telling the agent to check that file after editing.

Weaker than A and B — no atomic application, no history — but it means the engine works with anything.

## 4.4 The rules text

One canonical file, `packages/core/rules.md`, surfaced four ways: embedded in the MCP tool description, printed by `diagram rules`, written into `CLAUDE.md` / `AGENTS.md` by `diagram init`, and installed as a Claude Code skill at `.claude/skills/diagram/SKILL.md`.

```
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

## Rules

1. CALL diagram_get FIRST if you are not sure of the current state.
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

5. EDGE LABELS are 1-3 words: "reads", "publishes", "grpc", "webhook".
   Omit the label when the relationship is obvious from the types.

6. DASHED for asynchronous relationships (queue consumption, events,
   webhooks). Solid for synchronous calls.

7. GROUPS ARE TRUST AND DEPLOYMENT BOUNDARIES: vpcs, regions,
   accounts, clusters. Do not group things merely because they are
   related in topic.

8. DO NOT INVENT. Four services described means four services drawn.
   Do not add a load balancer, a CDN, or monitoring because it seems
   architecturally sensible. Only what was described or what you
   actually found in the codebase.

9. IF READING A CODEBASE, cite what you found. A node for every
   service in docker-compose.yml; an edge for every dependency you
   can actually see. Do not guess at connections.

10. DELETION. "Remove the cache" means removeNode plus removeEdge for
    every edge touching it. Emit both in one patch.

11. IF A PATCH IS REJECTED, read the errors, fix them, and retry once.
    The errors list the valid ids. Do not call diagram_get again just
    to find an id the error already gave you.

12. AFTER A LARGE CHANGE, tell the user what changed in one line. The
    viewer is already showing them the picture — do not describe the
    diagram back to them.
```

Rule 12 is worth keeping. Without it the agent narrates the diagram in prose after every turn, which is noise when the user is looking at the rendered thing.

## 4.5 What we deleted from v1

Gone, along with all the code and all the failure modes:

- API key handling, `.env`, secret management
- The Express `/api/patch` route
- The Anthropic SDK dependency
- `buildUserTurn` — the agent has the context already
- The one-shot retry loop — rule 11 does it, and better
- Rate limiting and in-flight request locking
- Token budgeting and `max_tokens` tuning
- The terminal pane in the browser — the user's real terminal is the terminal

**About a third of v1's code is now unnecessary.** The viewer is a viewer.

---

# Part 5 — Layout

## 5.1 Node sizing

ELK needs dimensions before layout. Measure once, cache by string.

```ts
const NODE = { minW: 150, maxW: 260, h: 60, hWithNote: 76, padX: 24, iconW: 28 };

function sizeNode(n: GNode) {
  const textW = measureText(n.label);           // cached offscreen canvas 2d
  const w = clamp(textW + NODE.padX*2 + NODE.iconW, NODE.minW, NODE.maxW);
  return { width: w, height: n.note ? NODE.hWithNote : NODE.h };
}
```

Truncate with an ellipsis past `maxW`. Do not wrap — variable-height nodes make the layout jumpier between turns.

**Entity nodes size differently.** An `entity` carrying fields (§3.6) is a table, not a box, so its height is driven by the document:

```ts
const ENTITY = { headerH: 34, rowH: 20, maxW: 340, padB: 8, padX, gap };
const ENTITY_FIELD_FONT = '400 11px ui-monospace, monospace';

function sizeEntity(n: GNode): Size | null {
  if (n.type !== 'entity') return null;
  if (!n.fields?.length) return null;          // no fields yet -> plain §5.1 box

  let widest = measureText(n.label) + NODE.padX*2 + NODE.iconW;   // the header
  for (const f of n.fields) widest = Math.max(widest, fieldRowWidth(f));

  return {
    width:  clamp(widest, NODE.minW, ENTITY.maxW),
    height: ENTITY.headerH + n.fields.length * ENTITY.rowH + ENTITY.padB,
  };
}
```

This is still §5.1 in spirit: the width is clamped and rows never wrap. Only the height varies, and it varies with **the document** (how many fields) rather than the viewport — so re-laying out an unchanged document still produces an identical result, and G4 holds.

`maxW` is 340 rather than `NODE.maxW`'s 260 because a realistic row — `created_at  timestamptz` — needs the room. An entity with no fields yet returns `null` and gets the ordinary box, which is what makes the "name the tables now, add columns next turn" pattern (§3.6) render sensibly in between.

**`fieldRowWidth` is the single source of truth for a row.** It must lay out exactly the terms the renderer draws, in the same order:

```
ACCENT_W | padX | name | gap | type | gap | badges | padX
```

Both bugs this code has had lived precisely here, and neither crashed — they just drew wrong, which is the §5.3 failure mode all over again:

- a **constant** badge column, too narrow for a composite `PK FK` row, so badges overhung the box edge;
- adding the field's `note` to the width, which the row never draws — the row is one line and the note lives in the hover panel (§8.6) — so every annotated table was sized too wide and the layout drifted.

Measure what is drawn. Never measure what the document merely contains.

## 5.2 ELK options

```ts
export const ROOT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': doc.direction,
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.spacing.edgeNodeBetweenLayers': '28',
  'elk.spacing.edgeEdge': '18',
  'elk.spacing.edgeNode': '20',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  'elk.padding': '[top=24,left=24,bottom=24,right=24]'
};

export const GROUP_OPTIONS = {
  'elk.padding': '[top=44,left=20,bottom=20,right=20]',  // 44 = room for the label
  'elk.spacing.nodeNode': '36'
};
```

Three options carry the weight:

**`hierarchyHandling: INCLUDE_CHILDREN`** — without it ELK lays out each container independently and cross-boundary edges route badly or not at all. Cross-boundary edges are most of an architecture diagram. Set this or nothing works.

**`considerModelOrder.strategy: NODES_AND_EDGES`** — makes ELK break ties using input array order. Since patches append and IDs are stable, this is what keeps turn 6 looking like turn 5. This is goal G4.

**`spacing.edgeEdge: 18`** — hop arcs have radius 6, so parallel edges need ~16px of separation or the arcs visually collide.

## 5.3 The coordinate flattening problem

**Most likely thing to eat half a day. Read carefully.**

ELK returns coordinates relative to a parent, and the rule differs between nodes and edges.

- **Node** `x`/`y` are relative to the parent node's origin.
- **Edge** section coordinates are relative to *the edge's container*, which ELK picks as the **lowest common ancestor** of source and target. An edge from inside `vpc-private` to a root node has the root as container. An edge between two siblings inside `vpc-private` has `vpc-private` as container.

You cannot apply one uniform offset.

```ts
function flatten(elkRoot: ElkNode): LaidOut {
  const absolute = new Map<string, {x:number;y:number}>();

  // pass 1 — absolute origins for every node and group
  (function walk(n: ElkNode, ox: number, oy: number) {
    const ax = ox + (n.x ?? 0), ay = oy + (n.y ?? 0);
    absolute.set(n.id, { x: ax, y: ay });
    n.children?.forEach(c => walk(c, ax, ay));
  })(elkRoot, 0, 0);

  // pass 2 — edges, offset by their CONTAINER's absolute origin
  const edges: AbsEdge[] = [];
  (function walkEdges(n: ElkNode) {
    const o = absolute.get(n.id)!;                 // n is the container
    for (const e of n.edges ?? []) {
      for (const s of e.sections ?? []) {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]
          .map(p => ({ x: p.x + o.x, y: p.y + o.y }));
        edges.push({ id: e.id, points: pts });
      }
    }
    n.children?.forEach(walkEdges);
  })(elkRoot);

  return { nodes: absolute, edges };
}
```

**Verification test (T8).** Fixture: one node inside a group, one node outside, an edge between them. Assert the edge's start point lands within 2px of the inner node's absolute boundary. Write this before the code. A wrong offset doesn't crash — it just looks like "the arrows are a bit off", which you will stare at for hours.

## 5.4 Worker protocol

```ts
worker.postMessage({ id: requestId, graph: elkGraph });
```

Track `requestId` and discard stale results. Agents emit patches in bursts; without this the canvas flickers between two layouts.

---

# Part 6 — Geometry: Crossings and Hops

This is what makes the output look designed rather than generated. Budget real time.

## 6.1 Segments

Every flattened edge is a polyline. Orthogonal routing means every segment is horizontal or vertical within 0.5px (ELK emits sub-pixel drift occasionally).

```ts
type Seg = { edgeId: string; index: number; orient: 'h'|'v';
             x1: number; y1: number; x2: number; y2: number };

function toSegments(edge: AbsEdge): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < edge.points.length - 1; i++) {
    const a = edge.points[i], b = edge.points[i+1];
    out.push({ edgeId: edge.id, index: i,
               orient: Math.abs(a.y - b.y) < 0.5 ? 'h' : 'v',
               x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}
```

A true diagonal shouldn't occur with `ORTHOGONAL`. Skip it for hop purposes, render it as a plain line, don't crash.

## 6.2 Crossing detection

Only horizontal-versus-vertical pairs can cross. Collinear overlaps are a separate problem; `edgeEdge` spacing mostly prevents them. Ignore for the PoC.

```ts
const HOP_R = 6;             // arc radius
const CORNER_GUARD = 10;     // no hops this close to a bend
const NODE_GUARD = 6;        // no hops this close to a node boundary

function findCrossings(segs: Seg[], nodeRects: Rect[]): Crossing[] {
  const hs = segs.filter(s => s.orient === 'h');
  const vs = segs.filter(s => s.orient === 'v');
  const out: Crossing[] = [];

  for (const h of hs) {
    const [hx1, hx2] = minmax(h.x1, h.x2);
    for (const v of vs) {
      if (v.edgeId === h.edgeId) continue;              // never hop yourself
      const [vy1, vy2] = minmax(v.y1, v.y2);
      const x = v.x1, y = h.y1;

      if (x <= hx1 || x >= hx2) continue;               // strict, excludes ends
      if (y <= vy1 || y >= vy2) continue;
      if (Math.min(Math.abs(x-hx1), Math.abs(x-hx2)) < CORNER_GUARD) continue;
      if (Math.min(Math.abs(y-vy1), Math.abs(y-vy2)) < CORNER_GUARD) continue;
      if (nodeRects.some(r => pointNear(r, x, y, NODE_GUARD))) continue;

      out.push({ x, y, hSeg: h, vSeg: v });
    }
  }
  return out;
}
```

O(h × v). At 200 edges × ~4 segments that's ~160k comparisons, roughly 3ms. Fine. If it ever isn't, bucket segments into a 100px grid.

## 6.3 Ownership rule

**The horizontal segment always hops. The vertical always runs straight.**

Pick one rule and never deviate. Alternatives (later edge hops, shorter edge hops, z-order decides) make the same visual situation render differently in different places, which reads as a bug. Consistency is what makes a hop legible — the eye learns "the arc goes over" in two seconds and then stops thinking about it.

## 6.4 Merging clustered crossings

Two crossings within `2·HOP_R + 2` produce touching arcs that look like a blob. Merge into one wider span.

```ts
function mergeClusters(points: number[], r: number): Span[] {
  const sorted = [...points].sort((a,b) => a-b);
  const spans: Span[] = [];
  let start = sorted[0]-r, end = sorted[0]+r;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]-r <= end+2) end = sorted[i]+r;
    else { spans.push({start,end}); start = sorted[i]-r; end = sorted[i]+r; }
  }
  spans.push({start,end});
  return spans;
}
```

Cap arc height at `HOP_R` regardless of span width, or a wide merged span renders as a balloon. Use two arcs with a flat top, or a cubic bezier.

## 6.5 Path building

```ts
function buildPath(segs: Seg[], hopsBySeg: Map<string, Span[]>): string {
  let d = `M ${segs[0].x1} ${segs[0].y1}`;
  for (const seg of segs) {
    if (seg.orient === 'v' || !hopsBySeg.has(key(seg))) {
      d += ` L ${seg.x2} ${seg.y2}`; continue;
    }
    const dir = seg.x2 > seg.x1 ? 1 : -1;
    const spans = hopsBySeg.get(key(seg))!
      .sort((a,b) => dir > 0 ? a.start-b.start : b.start-a.start);
    for (const s of spans) {
      const enter = dir > 0 ? s.start : s.end;
      const exit  = dir > 0 ? s.end   : s.start;
      const sweep = dir > 0 ? 1 : 0;               // both bulge UP
      d += ` L ${enter} ${seg.y1}`;
      d += ` A ${Math.abs(exit-enter)/2} ${HOP_R} 0 0 ${sweep} ${exit} ${seg.y1}`;
    }
    d += ` L ${seg.x2} ${seg.y2}`;
  }
  return d;
}
```

**The sweep flag inverts with travel direction.** Right-travelling needs `1` to bulge up; left-travelling needs `0`. Get it wrong and half your hops dent downward. Test both.

## 6.6 Corner rounding

Apply **after** hops, never before. Rounding first moves segment endpoints and invalidates every crossing you computed.

Replace corner `P` between segments `A` and `B` with a line to `P − unit(A)·8` and a quadratic `Q P` to `P + unit(B)·8`. Skip if either segment is under 20px, or a hop span comes within 12px — which is what `CORNER_GUARD` protects.

## 6.7 Arrowheads

```xml
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/>
</marker>
```

Because hops are guarded away from endpoints, the final segment is always straight and the marker orients correctly with no manual angle math.

## 6.8 Golden tests

Write these before the renderer. Run on every change.

| Test | Setup | Assert |
|---|---|---|
| T1 | Two edges crossing at right angles | exactly 1 hop, on the horizontal |
| T2 | Same, direction reversed | arc bulges up in both cases |
| T3 | Three verticals crossing one horizontal, 40px apart | 3 separate arcs |
| T4 | Same, 8px apart | 1 merged span |
| T5 | Crossing 4px from a bend | 0 hops |
| T6 | Edge crossing its own segment | 0 hops |
| T7 | Two parallel horizontals, same y | 0 hops |
| T8 | Edge from inside a group to outside | start within 2px of inner node boundary |
| T9 | 200 edges, random | under 50ms |

---

# Part 7 — Views

Pure function, under 1ms, no model turn. This is what makes audience switching feel instant.

```ts
export function deriveView(doc: GraphDoc, collapsed: string[]): GraphDoc {
  const hidden = new Set<string>();
  const rewrite = new Map<string,string>();

  for (const gid of collapsed)
    for (const d of descendantsOf(doc, gid)) { hidden.add(d); rewrite.set(d, gid); }

  const collapsedAsNodes: GNode[] = collapsed.map(gid => {
    const g = doc.groups.find(x => x.id === gid)!;
    return { id: gid, label: g.label, type: 'service', parent: g.parent,
             note: `${descendantsOf(doc, gid).length} components` };
  });

  const bucket = new Map<string, GEdge & { count: number }>();
  for (const e of doc.edges) {
    const from = rewrite.get(e.from) ?? e.from;
    const to   = rewrite.get(e.to)   ?? e.to;
    if (from === to) continue;                    // became internal, drop
    const k = `${from}->${to}`;
    const ex = bucket.get(k);
    if (ex) { ex.count++; ex.label = `×${ex.count}`; }
    else bucket.set(k, { ...e, from, to, count: 1 });
  }

  return { ...doc,
    nodes:  [...doc.nodes.filter(n => !hidden.has(n.id)
                                   && !collapsed.includes(n.parent ?? '')),
             ...collapsedAsNodes],
    groups: doc.groups.filter(g => !hidden.has(g.id) && !collapsed.includes(g.id)),
    edges:  [...bucket.values()],
    collapsed };
}
```

Edges internal to a collapsed group are dropped. Correct — an exec doesn't need to know that two things inside the VPC talk to each other.

| Preset | `collapsed` |
|---|---|
| `exec` | root-level group IDs |
| `eng` | `[]` |
| `focus <id>` | all group IDs − `[id]` − ancestors of `id` |

Reachable from `diagram view <preset>`, the `diagram_view` MCP tool, or three buttons in the viewer's status bar. Viewer buttons are viewport controls, not document edits, so they don't violate model-dictation.

---

# Part 8 — Rendering

## 8.1 Z-order

Strict. Getting this wrong is why generated diagrams look muddy.

1. Group rectangles, outermost first
2. Group labels
3. Edge paths
4. Edge labels, each with a halo rect in the canvas colour
5. Node boxes — `NodeBox` for every type, `EntityBox` for `entity` (§8.5)
6. Node icons and labels — and, for an entity, its header, separator and field rows
7. The hover inspection panel (§8.6) — HTML, outside the SVG entirely

Nodes above edges means an edge clipping a node corner is hidden, not drawn across it. Edge labels need the halo or they're unreadable where they sit on a line.

Layers 5 and 6 are why entity rendering is split across two components rather than one: the box belongs under the edge labels' halo layer and the field rows belong above it. Keeping the split makes the z-order enforceable instead of a convention. Layer 7 is not SVG at all — see §8.6.

## 8.2 Theme

```ts
export const theme = {
  canvas: '#FBFBF9',
  node:   { fill: '#FFFFFF', stroke: '#D4D2CC', radius: 8,
            shadow: '0 1px 2px rgba(0,0,0,.06)' },
  text:   { primary: '#1F1E1C', secondary: '#77756E' },
  edge:   { stroke: '#8A8880', width: 1.5 },
  group:  { fill: 'rgba(0,0,0,.018)', stroke: '#C9C7C0', dash: '4 4', radius: 12 },
  accent: { service:'#3B6FD4', database:'#2E8B69', queue:'#C4791E',
            cache:'#B8452F', storage:'#6B5BA8', client:'#4A4845',
            external:'#8A8880', entity:'#2F7A8C' }
};
```

Type colour appears only as a 3px left border and in the icon. Never fill the whole box — at 30 nodes it becomes a carnival. Eight hand-drawn 20px inline SVG glyphs, no icon library; `entity` is a table grid, a header band over a two-column body.

`entity` is a slate-teal, chosen as another muted mid-tone rather than a bright one, because an ERD is usually a canvas of nothing *but* entities and a saturated accent repeated forty times is exactly what the no-carnival rule exists to prevent.

## 8.3 Viewport

Fit to content on every render, capped at 120% zoom, animated over 250ms so additions feel like the camera pulling back rather than a jump cut.

```ts
const scale = Math.min((vw-2*PAD)/bounds.width, (vh-2*PAD)/bounds.height, 1.2);
const tx = (vw - bounds.width*scale)/2 - bounds.x*scale;
const ty = (vh - bounds.height*scale)/2 - bounds.y*scale;
```

Scroll zoom and space-drag pan allowed. Cross-fade the SVG over 150ms between layouts; don't interpolate node positions. Proper interpolation needs node matching across layouts plus add/remove handling — a day of work for polish you don't need.

## 8.4 Status bar

Thin strip at the bottom. Everything the browser window needs, given the terminal is elsewhere.

```
Checkout platform   11 nodes · 2 groups · 9 edges   [exec] [eng] [focus]
● connected                                    last update 2s ago    ⌘S
```

The connection dot matters. When the agent's MCP process dies or `diagram serve` is restarted, the user needs to see it here rather than wonder why the diagram stopped updating. Amber on reconnect, red after 5s down.

## 8.5 Entity nodes and crow's-foot edges (ERD mode)

A node of type `entity` (§3.6) routes to `EntityBox` instead of `NodeBox`. Everything else — accent border, icon, group nesting, hop arcs, collapse — is unchanged, which is the point: ERD mode is a rendering of the same document model, not a second engine.

**An entity is a table.** A header band carrying the label and icon, a separator, then one fixed-height row per field:

```ts
const ENTITY = { headerH: 34, rowH: 20, maxW: 340, padB: 8, ... };

// height is exact, never estimated — the row count decides it
height = ENTITY.headerH + fields.length * ENTITY.rowH + ENTITY.padB;
width  = clamp(widestFieldRow, NODE.minW, ENTITY.maxW);
```

The height formula must be **exactly** what ELK was told (§5.1 measures it), or rows overflow the box or float inside it. Entity height is the one place in the engine where a node's size is driven by document content rather than a constant, so it is also the one place where a sizing mistake is invisible until a table happens to be long.

**Field rows use a smaller monospaced font** than labels — column names and DDL types are code, they align better, and monospace lets a 340px row hold meaningfully more.

**Rows truncate with an ellipsis, never wrap** — the same rule as node labels (§5.1), for the same reason: variable-height rows make layout jumpier between turns. Anything a row truncates is still reachable in the hover panel (§8.6), so truncation loses nothing.

**PK/FK badges are grey chrome, not coloured.** §8.2 says type colour appears only as the left border; a table of forty rows with coloured key badges is precisely the carnival that rule forbids.

**Crow's-foot markers replace the arrowhead entirely** on an edge carrying `cardinality`. An ERD relationship reads at both ends, so a one-directional arrow is wrong there — the marker pair *is* the notation. Both markers are drawn with the entity at the `+x` side of the marker frame, and `orient="auto-start-reverse"` (§6.7) flips the frame at the start of the path, so one definition serves both ends with no angle maths. Edges without `cardinality` keep the normal arrowhead.

## 8.6 The hover inspection panel

Node metadata (§3.7) and full field lists surface in a panel on hover.

**It is plain positioned HTML, a sibling of the `<svg>` — not `<foreignObject>`, not SVG text.** SVG gives no text wrapping and no scrolling, and a 40-row field list needs both. This makes it the seventh layer of §8.1, above all six SVG layers because it is not in the SVG at all.

**It is read-only and pure**: a `GNode` and a screen position in, markup out. It never patches, never calls back into the document, and is never handed a mutation callback. §1.6 rules out mouse *editing*; inspection is a viewport control in the same sense as the view presets (§7), so it stays inside model-dictation.

**It sets `pointer-events: none` on itself**, or it steals the hover it is describing and flickers. It flips near the viewport edges rather than rendering off-screen, which is why it needs the container's dimensions rather than just a point.

Hover is how the document carries more than the canvas can legibly show — the answer to "where did this node come from" without a node box growing a paragraph.

---

# Part 9 — The Viewer Server

```ts
// diagram serve
const server = http.createServer(serveStatic(DIST_PUBLIC));
const wss = new WebSocketServer({ server });

chokidar.watch(GRAPH_PATH, { awaitWriteFinish: { stabilityThreshold: 40 } })
  .on('change', () => {
    const r = readDoc(GRAPH_PATH);                 // parse + zod validate
    if (!r.ok) { fs.writeFileSync(ERRORS_PATH, r.errors.join('\n')); return; }
    broadcast(wss, { type: 'doc', doc: r.doc });
  });

server.listen(port, () => open(`http://localhost:${port}`));
```

- **`awaitWriteFinish`** prevents reading a half-written file even with atomic renames on some filesystems.
- **Invalid file → no repaint.** Keep showing the last good diagram, write to `errors.txt`, flash the status bar amber. Never blank the canvas on a parse error.
- **Port:** default 4400, `--port` to change, auto-increment on EADDRINUSE up to 4410.
- **`--no-open`** for when the developer already has the tab.
- Bind `127.0.0.1` only. Never `0.0.0.0`.

---

# Part 10 — Build Plan

Sixteen steps, nine milestones. Each milestone ends in something runnable.

### M0 — Monorepo (0.5 day)

**Step 1.** npm workspaces, three packages, shared `tsconfig`. `packages/core` builds with zero runtime deps beyond Zod. CI check: fail if `package.json` anywhere lists a model SDK or `dotenv`.

### M1 — Document core (1 day)

**Step 2.** `schema/graph.ts` and `schema/patch.ts` in Zod, plus `jsonSchema.ts` generating the MCP tool input schema from the same source. Write this once, carefully — it's the contract for everything.

**Step 3.** `apply.ts`, `validate.ts` (V1–V10 with the exact error strings, including the "did you mean" suffixes), `history.ts`, `ids.ts` with the three coercion cases.

**Step 4.** `store/` — atomic write via tmp+rename, `.lock` acquisition with 2s stale timeout, history directory management.

**Step 5.** Tests. Six fixtures: empty, flat 3-node, two-deep nesting, cross-boundary edges, a cyclic-group doc that must fail, a duplicate-ID doc that must fail.

*Exit: `npm test` green in `core`. No UI, no agent.*

### M2 — Layout (1.5 days)

**Step 6.** `measure.ts` (cached canvas text measurement) and `toElk.ts` with per-container options.

**Step 7.** `fromElk.ts` — the two-pass flattening from §5.3. **Write test T8 first and make it pass before moving on.**

**Step 8.** `worker.ts` with request-ID staleness handling.

**Step 9.** Debug renderer: grey rectangles, straight polylines, no styling. Feed it the fixtures. Confirm nesting, spacing, and that cross-boundary edges land on the right boxes.

*Exit: fixtures render as recognisable, correctly nested diagrams.*

### M3 — Geometry (1.5 days)

**Step 10.** `segments.ts` and `crossings.ts`. Tests T1, T5, T6, T7, T9.

**Step 11.** `hops.ts` — cluster merging, arc insertion. Tests T2, T3, T4. The sweep-flag direction test is the one people skip and then lose an afternoon to.

**Step 12.** `corners.ts` and `path.ts`. Rounding after hops, with the guard.

*Exit: clean hop arcs in the debug renderer. This is the visual milestone — screenshot it.*

### M4 — Renderer (1 day)

**Step 13.** `render/` — theme, seven icons, `GroupRect`, `NodeBox`, `EdgePath` with the marker, correct z-order, label halos, fit-to-content viewport, scroll zoom, space-drag pan, status bar with the connection dot.

*Exit: fixtures look like a product.*

### M5 — Serve (0.5 day)

**Step 14.** `diagram serve` — static host, chokidar watch, WebSocket broadcast, reconnecting client, invalid-file handling, port fallback. Test by editing `graph.json` by hand in another editor and watching the browser repaint.

*Exit: hand-edit the file, see the diagram change.*

### M6 — Agent surface (1.5 days)

**Step 15.** `diagram-mcp` — stdio server, seven tools, terse text results, `rules.md` embedded in the `diagram_patch` description. Then the CLI twins. Then `diagram init` writing `.mcp.json`, `.gitignore` entries, the `CLAUDE.md` / `AGENTS.md` block, and the Claude Code skill file.

*Exit: end-to-end. Open Claude Code, describe a system, watch the browser.*

### M7 — Views and export (0.5 day)

**Step 16.** `deriveView` with edge merging and internal-edge dropping. The three presets across all three surfaces. SVG export from the viewer and from the CLI. PNG at 2× via canvas. JSON export/import.

### M8 — Rules hardening (1 day, ongoing)

Run twenty varied sessions across at least two different agents. Log every rejected patch and every ID coercion. Fix `rules.md`, not the code, unless a real bug appears.

The three failures you will see:
- **Inventing infrastructure** — the agent adds a load balancer nobody mentioned. Tighten rule 8.
- **Splitting one concept into two nodes** — `auth` and `auth-service`. Tighten rule 1, and check the V5 "did you mean" suffix is actually firing.
- **Reversed read edges** — database → service instead of service → database. Tighten rule 4 with an explicit example.

**Total: roughly 9 working days.**

---

# Part 11 — Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ELK coordinate flattening wrong | High | High | T8 written before the code. Fails loudly, not visually |
| Layout jumps between turns | Medium | High | `considerModelOrder`, stable IDs, patches not regeneration. If still unstable try `elk.layered.layering.strategy: LONGEST_PATH` |
| Agent invents duplicate nodes | High | Medium | Rules 1–2, V5 "did you mean", `addNode` coercion to `updateNode` |
| Agent invents infrastructure | Medium | Medium | Rule 8. Very common — models want to add load balancers |
| MCP config differs per agent | Medium | Medium | This is why Path B exists. `diagram init --agent codex\|cursor\|claude` writes the right config |
| Two agent turns race on one doc | Low | High | `.lock` file, 2s stale timeout |
| Viewer shows stale state silently | Medium | Medium | Connection dot in the status bar, amber then red |
| Hop arcs cluster into blobs | Medium | Low | Span merging, `edgeEdge` ≥ 18 |
| Over 60 nodes becomes illegible | Medium | Low | Out of scope. Push toward `focus`. Warn above 60 |

---

# Part 12 — Demo Script

Two windows side by side. Terminal left, browser right. Ninety seconds.

1. `diagram init && diagram serve` — browser opens, empty canvas.
2. `claude` — start the agent.
3. **Paste prose:** "We run a React web app and an iOS client. Both call an API gateway. The gateway routes to an auth service and an orders service. Auth reads a Postgres users table. Orders reads Postgres and publishes order events to Kafka. A fulfilment worker consumes those events and writes to S3."
   → Eight nodes appear in the browser. *G1.*
4. **"put postgres, kafka and the fulfilment worker in a private vpc"**
   → Container forms around existing nodes. Nothing else moves much. *G3, G4.*
5. **"add a redis cache that orders reads from"**
   → New node, edge crosses an existing one. Point at the hop. *G5.*
6. **"now read the docker-compose.yml in this repo and add anything I missed"**
   → This is the moment that lands. No API architecture can do it. *§1.3.*
7. `diagram view exec` → instant collapse, no model turn. *G7.*

Closing line: there is no API key in this project.

---

# Part 13 — Extensions

Ordered by value per unit of effort.

1. **PNG feedback loop.** `diagram export png` via `resvg-js` (Rust binding, no headless browser). The agent renders, reads the image back, and checks its own work. Genuinely new capability — the agent can *see* that a diagram is cluttered and restructure it.
2. **ERD mode.** New `entity` node type with a field list, edges carrying cardinality (1:1, 1:N, N:M), crow's-foot markers. The graph model already supports it; mostly rendering plus a second rules file.
3. **Diff highlighting.** Compare the last two documents, flash additions green and removals red for 1.5s. Cheap, and it makes bursts of agent edits legible.
4. **`diagram scan`.** Seed a document from `docker-compose.yml`, Terraform state, or a Kubernetes manifest. Gives the agent a factual starting point instead of a blank canvas.
5. **Git-aware history.** `graph.json` is already committed. `diagram log` walks git history and animates the architecture changing over releases.
6. **Mouse editing.** The big one. Needs pinned positions, drag reconciliation, and geometry persistence. Roughly triples the surface area. Do not start until the dictation loop is genuinely good.

> **Note on item 2.** ERD mode is no longer an extension — it shipped in commit `00bf950`
> (an `entity` node type with a `fields[]` array, edge `cardinality`, per-node `meta`, and
> a hover inspection panel). It is specified in §3.6, §3.7, V11–V13, §8.5 and §8.6, and
> should be read as part of the data model rather than as future work. It is also the
> first working evidence for the layered model in Part 14: an entity node is a second
> visual language rendered inside a node of the first.

---

# Part 14 — Direction: The Layered Canvas

**Status: not a v2 requirement.** Nothing in this Part is in scope for M0–M8, and no
milestone gate should test against it. It records where the engine is heading, what the
architecture already supports for free, and — most importantly — the one problem that has
to be solved before any of it is worth building. Read it before making a schema decision
that would be expensive to reverse.

## 14.1 The idea

A node is not only a box. It is a door. Open the `orders` service and you get a canvas of
its internals; open a component inside that and you get the logic it runs. The document
stops being one flat picture and becomes a **multi-layered graph** — a system designed
visually, top to bottom, before any code exists.

Two distinct products hide inside that sentence, and conflating them is the main risk:

| | **(a) Drill-down** | **(b) Layered languages** |
|---|---|---|
| What a lower layer contains | The same vocabulary, nested deeper — services inside services | A *different* vocabulary — logic steps, control flow, data |
| Document shape | One document, deeper hierarchy | Many canvases, one per opened node |
| Cross-layer edges | Free — ELK resolves a common ancestor | The hard problem (§14.4) |
| Cost | **Already built. See §14.2** | ~8–10 days. See §14.7 |

The engine ships (a) almost by accident. (b) is the actual ambition.

## 14.2 (a) is already in the box

This is worth stating plainly because it is easy to miss and it changes the sequencing:

- `GGroup.parent` already nests arbitrarily deep (§3.1).
- ELK already lays out nested containers correctly, via
  `hierarchyHandling: INCLUDE_CHILDREN` (§5.2).
- The `focus <id>` preset — *all group IDs, minus the target, minus its ancestors* (§7) —
  is precisely "one container open, siblings shut." That **is** drill-down.

So layered navigation over a single document needs no schema change and no new layout
work. It needs a way to *move* between focus states: a breadcrumb, an ascend action, and
an agent-facing tool that sets focus. Navigation is viewport state, not document state —
the same call §7 already makes for view presets, so it does not violate model-dictation.

**Build this first, in M9.** It tests whether layered navigation actually feels good
before anything expensive is committed to.

## 14.3 Why the ambitious version is worth it

**The architecture absorbs it without a rewrite.** The core principle (§1.4) — meaning
from the model, geometry from the layout engine — is indifferent to how many canvases
exist. Every new layer inherits ELK, hop arcs, and the renderer for nothing. Most
diagramming tools cannot add a layer without touching layout. This one can.

**Layering is cheap for an agent and expensive for a human.** This is the asymmetry the
whole product rests on. Maintaining four layers by hand means four times the dragging,
which is why in practice nobody maintains them. "Expand the orders service into its
internal flow" is one tool call, made by an agent that has already read `orders/`. The
value-to-effort ratio of layering is *inverted* for agents versus humans.

**It is the principled answer to a limit already conceded.** The risk table (Part 11) says
past 60 nodes the diagram becomes illegible, marks it out of scope, and says "push toward
`focus`". Layers are not a feature bolted on top of that limit; they are the correct
resolution of it.

**The endgame is not the picture.** A layered document that is *validated* (§14.5) is a
machine-readable specification, and the same agent that drew it can implement from it.
Diagram-as-source-of-truth is worth an order of magnitude more than diagram-as-output.

## 14.4 The hard problem: cross-layer edges

**Solve this on paper before writing any multi-canvas code.**

Today an edge from inside `vpc-private` to a root node works because ELK picks the
*lowest common ancestor* (the innermost container holding both endpoints) as the edge's
layout container. That is the whole subject of §5.3, and it is the part that was flagged
as most likely to eat half a day. It did.

If sub-canvases are separate documents, an edge from inside `orders`'s canvas to inside
`auth`'s canvas **has no common ancestor to resolve against.** There is no container, so
there is no coordinate space, so there is no route.

The standard answer is **ports** (named connection points on a node's boundary; a child
canvas terminates its edges on stubs that stand in for the parent's edges). It is how
Simulink and hardware schematics handle exactly this. Ports work, but they add real
modelling burden, and the agent has to get them right on every patch.

The alternative — keep one physical document with very deep nesting — makes the problem
vanish, but then layers are just groups, and per-layer languages (§14.6) become hard
instead. **Pick deliberately.**

## 14.5 The second hard problem: layer drift

If `orders` has three outbound edges at the parent level, its sub-canvas must account for
all three. Nothing makes that true. Layers silently diverge, and the diagram begins to
lie — and the lie sits *behind a click*, which is worse than a wrong diagram in plain
sight, because nobody reviews it.

This is why C4 tooling and Enterprise Architect are unpleasant to maintain in practice.
It is not a tooling accident; it is inherent to hand-maintained layers.

It calls for a new class of invariants alongside V1–V10 (§3.3), with the same
"say what to do" error contract:

| # | Rule | Error message |
|---|---|---|
| L1 | Every parent-level edge touching a node terminates on a port in that node's canvas | `node "orders" has 3 edges but its canvas exposes 2 ports. Missing: kafka-out` |
| L2 | Every port in a child canvas corresponds to a parent-level edge | `port "s3-out" in canvas "orders" has no matching edge at the parent level` |
| L3 | A node's `canvas` reference resolves to an existing canvas | `node "orders" opens canvas "orders-internal" which does not exist` |
| L4 | No cycle in the canvas containment chain | `canvas cycle: orders → billing → orders` |
| L5 | A canvas's `kind` permits the node types used in it | `node type "queue" is not valid in a flow canvas. Valid: step, decision, io` |
| L6 | Canvas depth ≤ 3 | `canvas depth 4 exceeds the limit; see §14.6 on why depth stops paying` |

**Do not read L1–L6 as a chore.** They are the product. Consistency checking is what makes
a layered document trustworthy enough to generate code from, and it is the one thing an
agent-driven tool can do that a hand-driven one cannot — because regenerating a layer from
the codebase is cheap.

## 14.6 The third hard problem: layers are different languages

Architecture and logic are not the same notation. Boxes mean deployed things in one and
steps in the other; edges mean network calls in one and control flow in the other. They
want different validation and different layout (flow wants sequence and swimlanes;
architecture wants containment).

`NodeType` (§3.1) is currently a single flat union. A layered engine needs a per-canvas
`kind`, each with its own type vocabulary, its own invariants, and its own rules file.

**This problem already exists in miniature, unsolved.** `packages/core/rules.md` and
`packages/core/rules-erd.md` both exist, and nothing in the code chooses between them. An
agent has no way to know which applies. Fix that first — it is the same problem at the
smallest possible scale, and the mechanism that solves it generalises.

## 14.7 Sketch of the data model

Recorded so the shape is agreed before it gets built. Deliberately minimal, and
**additive** — an existing single-canvas `graph.json` stays valid.

```ts
export type CanvasKind = 'architecture' | 'erd' | 'flow';

export interface GPort {
  id: string;
  label: string;
  direction: 'in' | 'out';
}

// GNode gains one optional field. Non-breaking.
export interface GNode {
  // ...existing fields
  canvas?: string;   // id of the canvas this node opens into
  ports?: GPort[];   // boundary terminals, for cross-layer edges (§14.4)
}

// GEdge endpoints may address a port: "orders:kafka-out"
// GraphDoc gains identity and lineage.
export interface GraphDoc {
  // ...existing fields
  id: string;
  kind: CanvasKind;
  parentRef?: { canvas: string; node: string };
}
```

On disk, `.diagram/graph.json` becomes:

```
<project>/.diagram/
├── index.json              # root canvas id + canvas registry
├── canvases/
│   ├── root.json
│   └── orders-internal.json
└── history/                # unchanged, now per-canvas
```

`store/paths.ts` already centralises path resolution, so this is a contained change.
`store/write.ts` already handles atomic writes, locking, and history — none of that needs
rethinking, only applying per canvas.

## 14.8 Prior art

This is **C4** — context, container, component, code — with an agent driving it. Read C4
before building, and note that its own author advises most teams *not* to maintain the
code level, because upkeep exceeds value. That is real evidence about where the returns
stop, and it is the basis for the depth-3 cap in L6.

Nesting itself is old. The defensible idea here is nesting that **stays true**, because
regenerating a layer from the codebase is cheap when an agent does it. That, not the
nesting, is what is new.

## 14.9 Staging and cost

| Milestone | Work | Cost | Gate to pass first |
|---|---|---|---|
| **M9** | Drill-down navigation over the existing hierarchy: breadcrumb, ascend, an agent tool that sets focus. No schema change (§14.2) | 1 day | M7 shipped |
| **M10** | Resolve the rules-file selection problem (§14.6) — per-document `kind` choosing its rules text | 0.5 day | M8 shows the agent draws a truthful *flat* diagram |
| **M11** | Multi-canvas schema and store (§14.7) | 2 days | §14.4 decided on paper |
| **M12** | Ports and the cross-layer edge model | 2 days | — |
| **M13** | L1–L6 consistency invariants | 1.5 days | — |
| **M14** | Viewer: canvas navigation, cross-layer edge rendering | 2 days | — |
| **M15** | Per-layer languages, one rules file per kind | 2 days, then ongoing | — |

**Roughly 8–10 days beyond the PoC** — as much again as everything before it.

## 14.10 Decision gates

Answer these in order. Each one can stop the work, and stopping is a valid outcome.

1. **Does M8 show the agent drawing a truthful single layer?** If it invents infrastructure
   at depth 1, it will invent more at depth 2, hidden behind a click. Layering multiplies
   every rules failure. **This gate is non-negotiable.**
2. **After M9, does layered navigation feel good?** If drilling through focus states is
   not pleasant with zero schema change, it will not become pleasant with a large one.
3. **How much of "dive into the node" is progressive disclosure rather than a new canvas?**
   The `entity` field list and the `meta` hover panel already deliver detail-on-demand with
   no second canvas and none of §14.4–14.6. Establish what genuinely needs its own canvas
   before paying for canvases.
4. **One document with deep nesting, or many documents with ports?** (§14.4) Reversing this
   later is expensive.

---

# Part 15 — Analysis

**Status: not a v2 requirement.** Out of scope for M0–M8; no milestone gate tests against
it. Unlike Part 14 this is small, near-term, and needs no schema change — the natural
milestone after M7.

## 15.1 Why

A diagram tells you what connects to what. A bottleneck is about *pressure* — how much
flows, how fast, what blocks on what, what everything else depends on. None of that is
visible in `nodes`, `groups`, `edges`. The engine currently draws a map with no contour
lines.

The trap is that a clean diagram *feels* like it is telling you about performance, and it
is not. That is worse than an ugly one, because it will be trusted.

Analysis closes the gap in the same division of labour the rest of the spec uses: **the
engine computes the structural facts, the agent supplies the judgment.** The engine says
`postgres has fan-in 9`. The agent — which has read the codebase — says why that matters
and what to do. Neither half is useful alone.

## 15.2 What structure alone gives you

Six signals, all pure functions over `GraphDoc`, no model turn, sub-millisecond at the
200-element cap. Testable against fixtures with nothing running, exactly like `deriveView`.

| Signal | Computed from | Reads as |
|---|---|---|
| **Fan-in / fan-out** | inbound and outbound edge counts, split sync vs async | Nine services on one Postgres, stated as a fact |
| **Shared dependency** | how many entry points (nodes with no inbound edge) can reach it | The thing whose outage is everyone's outage |
| **Articulation points** | remove the node — does the graph split? | Single points of failure, named |
| **Longest sync chain** | longest path over synchronous edges only | Where latency accumulates; also the blast radius |
| **Boundary crossings** | edges whose endpoints differ in group ancestry | Every one is a network hop the box diagram hides |
| **Sync cycles** | strongly connected components over sync edges | Cascading-failure and distributed-deadlock risk |

**`style` is doing the heavy lifting here.** `dashed` already means asynchronous (§4.4
rule 6), and `style` absent means solid means synchronous. That one existing field is what
makes half this table computable. No new schema.

**Implementation notes, because the naive version is right at this size.**

- *Articulation points:* do not reach for Tarjan's low-point algorithm. At ≤200 elements,
  remove each node in turn and count connected components of the undirected projection.
  `O(n·(n+e))` is nothing here, and it is very hard to get wrong.
- *Longest sync chain:* longest path is NP-hard on a general graph, so condense strongly
  connected components first, then take the longest path over the resulting DAG — which is
  linear. A cycle is reported as a cycle (it is a finding in its own right), never silently
  traversed.
- *Entry points:* nodes with no inbound edge. Usually `client` type; do not hard-code that.

## 15.3 The operational layer, and the line that must hold

Structure yields *candidates*. It cannot tell you the queue is actually backed up. That
needs numbers, and numbers must come from somewhere real: metrics, a load test, a capacity
model someone typed in deliberately.

`meta` (§3.7) is the hook — `rps=12000`, `p99=340ms`, `instances=3`. An agent that has read
your Terraform can fill in replica counts and instance sizes truthfully. **It cannot fill
in traffic, and it will guess if allowed to.**

So the contract:

| # | Rule |
|---|---|
| A1 | Analysis NEVER mutates the document. It is a read. |
| A2 | Analysis runs on the FULL document, never the derived view (§7) — otherwise `exec` hides the very chokepoints you are looking for. |
| A3 | Structural findings are **asserted**. Operational findings are **attributed** — name the `meta` key they came from, or do not state them. |
| A4 | `entity` nodes and `cardinality` edges are EXCLUDED. An ERD is a data model, not a runtime; "bottleneck" over a foreign key is a category error. Say so in the output rather than silently skipping. |
| A5 | ALWAYS report coverage: how many nodes carry no operational metadata. An analysis that hides its own blind spots is worse than none. |

A3 is the same fight as rule 8 of the agent rules (do not invent), one level up, and it
matters more: a wrong number looks authoritative in a way a wrong box does not.

## 15.4 Output

An eighth MCP tool and a CLI twin, `diagram analyse`. Terse text, same as everything else
(§4.1) — the agent reads it on every turn:

```
chokepoints
  postgres      fan-in 9 (7 sync)   articulation point — isolates 4 nodes
  api-gateway   fan-in 5 (5 sync)   articulation point — isolates 11 nodes

sync chains
  web-client → api-gateway → orders → postgres    (depth 4, all sync)

boundary crossings
  vpc-private ↔ root: 6 edges

sync cycles
  orders → inventory → orders

coverage
  11 of 14 nodes carry no operational meta
  2 entity nodes excluded (data model, not runtime)
```

The last two blocks are not padding. They are what stops the analysis reading as complete
when it is not (A4, A5).

## 15.5 In the viewer

A view mode alongside exec / eng / focus (§7): edges weighted by fan-in, chokepoints
ringed, the longest sync chain highlighted. It is a **viewport control, not a document
edit**, so it stays inside model-dictation exactly as the view presets do.

Hold §8.2's no-carnival rule. Analysis colour is one accent used sparingly on the few
elements that matter, never a heat map across every box.

## 15.6 Why this earns its place

- It gets **more** valuable exactly where the eye fails — past 40 nodes, which Part 11
  currently writes off as out of scope. It is a better answer to that limit than a warning.
- It is the strongest argument for Part 14: spot a chokepoint at the top level, then drill
  into it. Bird's-eye and detail become one workflow rather than two.
- It makes the diagram *load-bearing*. A picture is an opinion; a picture plus derived
  structural facts is something you can argue with.

## 15.7 Cost

| Milestone | Work | Cost |
|---|---|---|
| **M9a** | The six signals as pure functions in `core/analysis/`, with fixtures | 1 day |
| **M9b** | `diagram analyse` CLI + MCP tool, terse output, A1–A5 enforced | 0.5 day |
| **M9c** | Viewer analysis view mode | 0.5 day |

Highest value per day in the project. Slots in after M7 and disturbs nothing.

---

# Part 16 — Distribution

**Status: not a v2 requirement.** Out of scope for M0–M8. This Part records how the engine
reaches a team, and the constraints that shape the build if you want it to get there
cleanly. Two of them — bundling and the dependency list — are cheaper to honour early than
to retrofit.

## 16.1 Why the plugin shape fits

The engine already is what a Claude Code plugin bundles:

- **An MCP server over stdio.** `diagram init` writes `.mcp.json` by hand today; a plugin
  makes that step vanish. Install it and the seven tools are simply there.
- **A skill.** `rules.md` is already installed as `.claude/skills/diagram/SKILL.md` (§4.4).
  Plugins carry skills natively.
- **No credentials.** §1.3 was written as a purity constraint. It turns out to be a
  distribution feature: a tool needing no keys can be rolled out across a team with no
  secret provisioning and no per-developer setup. Most MCP servers cannot say that.
- **A document that lives in git.** `graph.json` is committed (§2.5), so diagrams travel
  with the repo the plugin is installed into.

## 16.2 The supply-chain requirement

Two distinct risks. Conflating them produces the wrong fix.

| | What it is | Scales with |
|---|---|---|
| **Install-time** | Every engineer runs a package manager, fetching hundreds of packages and executing their install scripts | Team size × update frequency |
| **Build-time** | You fetch those packages once, on a machine you control, to produce an artifact | Nothing — it happens once |

Only install-time risk multiplies, and it can be removed entirely: **ship a prebuilt,
bundled `dist/` in the plugin repo.** Installing a plugin is a pure file fetch — no build,
no install step — so a user runs an artifact you built and audited, and never a package
manager.

**THE TRAP.** A plugin that ships a `package.json` WITH a lockfile gets its dependencies
auto-installed into a cache directory. That is convenient in general and exactly wrong
here: it puts package-manager execution back on every machine. So:

> **Ship no `package.json` and no lockfile at the plugin root.** Make the auto-install
> path unreachable rather than merely unused.

That has a consequence for the build. `packages/cli` builds with `tsc`, which COMPILES but
does not BUNDLE — `dist/bin/diagram-mcp.js` still resolves imports from `node_modules` at
runtime. A bundling step (esbuild or rollup) is therefore not a nice-to-have; it is what
makes the no-lockfile shape possible at all. The viewer is already there: Vite bundles
React and elkjs into a single asset, so the browser side has no runtime `node_modules`.

## 16.3 Shrink what gets bundled

The runtime surface is five direct dependencies. Each is a review burden and an attack
surface, and two of them should go.

| Dependency | Verdict |
|---|---|
| `elkjs` | **Keep.** Irreplaceable (§2.3). Pure JS, bundled at build time. |
| `zod` | **Keep.** One source yielding runtime validation, TS types, and the MCP tool JSON Schema (§3.1). Hand-rolling loses `graphPatchJsonSchema()`. |
| `@modelcontextprotocol/sdk` | **Keep for now.** MCP over stdio is newline-delimited JSON-RPC 2.0; a few hundred lines if a zero-dependency server is ever wanted. |
| `commander` | Replaceable in ~100 lines. Earning its keep across eleven commands. Low priority. |
| `chokidar` | **Drop.** It is the only reason a native binary (`fsevents`) is in the tree. §9 watches exactly ONE file; Node's built-in `fs.watch` covers that. |
| `ws` | **Drop — see below.** |

**Replace WebSocket with Server-Sent Events.** Look at what §9 actually does: the server
pushes `{type:'doc'}` and `{type:'error'}` to the browser and the browser sends nothing
back. That is not a WebSocket use case; it is SSE — one-way push over the `http` module
already in use. `EventSource` is built into the browser, so the client dependency is zero,
and **it reconnects natively**, which deletes most of `ws.ts`'s hand-rolled reconnecting
client. This removes a dependency AND a piece of maintained code. It is a simplification,
not a trade.

After both removals: `zod`, the MCP SDK, `commander`, `elkjs` — and **zero native
binaries**, so nothing needs a compile step anywhere.

**Harden what is left.** Build with `npm ci --ignore-scripts` (most real npm attacks
execute through `postinstall`; once `fsevents` is gone nothing in the tree needs install
scripts). Extend `check:no-model-sdk` into a **dependency allowlist** that fails the build
on any new runtime dependency — that check, not good intentions, is what holds the line
in a year when someone adds a "small" package under deadline.

**The honest limit:** you cannot reach zero third-party code. elkjs is 1.4MB of layout
engine you are not going to write. What is achievable is that no user ever *installs*
anything, and that the dependency count is small enough for one person to actually review.
Four is reviewable. The 174 packages a full install pulls today are not.

## 16.4 Shape of the plugin repository

```
diagram-plugin/
├── .claude-plugin/
│   ├── plugin.json          # name, version — bump on every release
│   └── marketplace.json     # the repo is its own marketplace
├── .mcp.json                # command: node ${CLAUDE_PLUGIN_ROOT}/dist/bin/diagram-mcp.js
├── skills/diagram/SKILL.md  # rules.md, verbatim
├── commands/                # /diagram-serve — starts the viewer
└── dist/                    # prebuilt AND bundled. NO package.json. NO lockfile.
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install directory and is valid in an MCP
server's `command`, `args` and `env` — that variable is the pivot the whole no-npm
approach turns on, and it is the FIRST thing to smoke-test (§16.9).

## 16.5 What this changes in the engine

**`diagram init` mostly dissolves.** The `.mcp.json`, the `CLAUDE.md`/`AGENTS.md` block and
the skill file all become the plugin's job. `init` shrinks to what is genuinely
per-project: create `.diagram/`, add the `.gitignore` entries.

That makes a latent problem real: **duplicate rules.** If the plugin ships the rules AND
someone runs `diagram init`, the agent sees two copies which drift across versions. Either
`init` detects the plugin and skips those files, or plugin mode is an explicit flag.
Decide before anyone installs it.

**Tool names change.** Plugin-provided MCP tools are namespaced
`mcp__plugin_<plugin>_<server>__<tool>`. `rules.md` names tools literally — rule 1 says
"CALL `diagram_get` FIRST", rule 11 says "do not call `diagram_get` again". Under plugin
distribution those strings match nothing in the tool list. The agent will likely cope,
since it sees the real names, but rule 11 is the self-correction instruction and is the
last thing that should be quietly weakened. Decide whether the rules should name tools at
all, or describe them by role.

**Path B does not come along.** The `bin/` convention that puts executables on `PATH` is
not intended for marketplace distribution, so a plugin install gives Path A (MCP) cleanly
but leaves the `diagram` CLI unavailable. That costs twice: §4.2's universal fallback for
non-MCP agents stops being free, and `diagram serve` — the thing that puts the diagram on
screen — is a CLI invocation. Ship a bundled slash command that runs
`node ${CLAUDE_PLUGIN_ROOT}/dist/bin/diagram.js serve`. That also fixes the first-run
experience, which is otherwise "the tools work, the agent says it added four nodes, and
nothing appears on screen" — indistinguishable from broken.

## 16.6 Team and enterprise rollout

No install command needed. Committed in the team's repo at `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "team-tools": { "source": { "source": "github", "repo": "your-org/diagram-plugin" } }
  },
  "enabledPlugins": ["diagram@team-tools"]
}
```

Trusting the repo folder registers the marketplace and loads the plugin. Organisation-wide,
the same keys go in managed settings, deployed by administrators to a system path.

For the security review that a team rollout will attract, two org-level controls matter:
**`strictKnownMarketplaces`** allowlists which marketplaces are permitted at all, and
`blockedMarketplaces` denies others. Combined with §16.2's no-lockfile artifact, the story
to a security team is: one allowlisted repository, one reviewed bundle, no package manager,
no credentials, no network.

## 16.7 Versioning, and why pinning matters more here

`version` in `plugin.json`; users receive updates when it is bumped. A marketplace URL can
carry a ref — `...diagram-plugin.git#v1.0.0` — which pins the whole plugin.

**Pinning pins `rules.md`, and `rules.md` is the prompt** (§4.1). In an architecture with
no system prompt, the rules text is the only thing governing how every engineer's agent
draws. The rule 4 rewrite — where one ambiguous sentence produced two contradictory
conventions inside a single document — is the argument for versioning it deliberately
rather than letting it drift per developer.

## 16.8 Release discipline

A committed `dist/` produces diffs nobody can read, which trades one supply-chain problem
for another: "we ship a prebuilt bundle" becomes "we ship a binary nobody can verify."
So the release process is part of the design, not an afterthought:

1. Build from a tagged commit with `npm ci --ignore-scripts`.
2. Commit `dist/` in a separate, clearly-labelled release commit.
3. Provide a **reproducible-build check** so a reviewer can rebuild the tag and confirm the
   committed bundle matches the source.

Without step 3 the artifact is unauditable, and the whole supply-chain argument collapses.

## 16.9 Cost, staging, and what to verify first

**Verify before building anything:** that a plugin with NO root `package.json` still
launches its MCP server from `${CLAUDE_PLUGIN_ROOT}`. Everything in this Part follows from
that one fact. It is a half-hour smoke test and it de-risks the whole Part.

| Milestone | Work | Cost |
|---|---|---|
| **M16a** | Bundle the CLI (esbuild/rollup) so `dist/` is self-contained | 0.5 day |
| **M16b** | Drop `chokidar` for `fs.watch`; replace `ws` with SSE (§16.3) | 1 day |
| **M16c** | Plugin repo: manifest, marketplace, `.mcp.json`, skill, serve command | 0.5 day |
| **M16d** | Resolve the three engine changes in §16.5 (init, tool names, Path B) | 0.5 day |
| **M16e** | Release pipeline with the reproducible-build check | 0.5 day |

**About 3 days**, and M16a and M16b are worth doing regardless of whether the plugin ever
ships — they shrink the runtime surface and delete code.

---

# Part 17 — Observed Systems

**Status: not a v2 requirement.** Out of scope for M0–M8. Depends on Part 15 existing.
Independent of Part 14 — and, if you have to choose one direction after M8, this is the
one with the larger payoff.

## 17.1 The idea

Import the topology a system actually has, and diff it against the topology it was
designed to have. Two documents, one comparison: **as designed** versus **as running**.

## 17.2 The architectural move

The engine has no model in it; the agent supplies the intelligence (§1.3). Do it again:

> **The engine has no network in it; the agent supplies the observation.**

The agent already has the developer's shell. It can run `kubectl get svc -o json`,
`aws ec2 describe-instances`, `istioctl proxy-config`, or dump an OpenTelemetry service
graph — with the developer's own credentials, in the developer's own terminal, exactly as
it already reads `docker-compose.yml`. It hands the engine a FILE.

```bash
diagram observe --from otel-dump.json      # build an observed document
diagram drift                              # compare observed against designed
```

No keys. No network. Works offline. The §1.3 constraint survives completely intact, and
this generalises `diagram scan` (Part 13 item 4) rather than fighting it.

## 17.3 What it buys, ranked honestly

1. **Undocumented coupling.** Edges that exist in reality but not in the design. Every
   incident postmortem contains the sentence "I didn't know X called Y." This finds those
   before the incident. Nothing else on the roadmap has that payoff.
2. **The diagram becomes falsifiable.** Today an architecture diagram is an opinion with no
   truth value. Diffed against reality it becomes a claim that can be wrong — the same
   category shift as comments to types, and the thing that makes the artifact worth
   maintaining at all.
3. **Architectural invariants in CI.** Once you can diff, you can assert: *nothing outside
   `vpc-private` talks to `postgres`*; *no synchronous edge crosses a region boundary*.
   Fail the build. These are fitness functions expressed in a picture the whole team reads
   rather than a config file one person owns.
4. **Part 15's blind spot closes.** `rps`, `p99` and error rates arrive from telemetry
   instead of being guessed, so A5's coverage line goes to near zero and the analysis moves
   from *candidates* to *findings*.
5. **Dead architecture.** Edges in the design with no observed traffic: the service nobody
   decommissioned, the failover path that would fail.

## 17.4 The hard problem: identity resolution

`orders-deployment-7f9b-x4k2`, `orders.prod.svc.cluster.local` and the node `orders` are
the same thing. Establishing that mapping is where the engineering actually is.

It is the same shape as V5's "did you mean" suffix (§3.3), so the instinct and some of the
machinery already exist. Requirements:

- The mapping must be **inspectable and correctable** — stored in the document, not
  guessed afresh each run. `meta` (§3.7) is the natural home: `k8s=orders`, `otel=orders-api`.
- Unmatched observed elements are **reported, never silently dropped**. A node the mapping
  missed is exactly the undocumented coupling you were looking for.

## 17.5 Noise and scale

A real mesh graph is enormous and filthy: sidecars, health checks, DNS, metrics scrapers,
one node per pod. It will blow through the 200-element cap (V8) in a mid-size cluster.

Aggregation and filtering are therefore not polish, they are the feature: collapse
instances to services, drop infrastructure chatter, and make the filter list explicit and
editable rather than hidden in code.

## 17.6 Rules

| # | Rule |
|---|---|
| O1 | Observation NEVER writes the designed document. Drift is reported; a human reconciles. |
| O2 | An unobserved edge is NOT evidence of absence — it may be the quarterly batch or the DR failover. Never auto-delete. |
| O3 | Every observed document records its **window** — "observed over 24h" is a completely different claim from "observed over 5 minutes". State it in the output. |
| O4 | Unmatched observed elements are always listed. Silence about them hides the finding. |
| O5 | The engine reads a FILE. It never opens a network connection, and never accepts a credential (§1.3). |
| O6 | Observed and designed documents are the same schema, so every existing tool — views, analysis, export — works on both without special cases. |

## 17.7 Chaos testing

> **Specified in full in Part 18.** The summary below is kept because it is the argument
> for why Part 17 is worth building at all. Note the split: *predicted* blast radius needs
> only Part 15 and no observation whatsoever — it is half a day of work, not eight.

A good fit, for a sharper reason than "it draws the system". Chaos engineering is bad at
exactly two things, and this addresses both.

**Choosing what to break.** That is the hard part, and Part 15 already outputs a ranked
list. *"postgres is an articulation point isolating 4 nodes"* is not an analysis result, it
is an experiment proposal. Fan-in ranking and articulation points are a chaos backlog,
derived rather than brainstormed.

**Knowing whether the result was surprising.** The design PREDICTS a blast radius —
reachability over synchronous edges from the node being killed. The experiment shows what
actually fell over. **The diff between predicted and actual blast radius is the finding**,
and it is far sharper than "did it stay up?". Two failure modes fall straight out:

- Something failed that the design says should not have → hidden synchronous coupling.
- A **dashed** edge cascaded → an async path was made synchronous. The schema already
  encodes the intent (§4.4 rule 6), so the violation is machine-detectable.

Run the same experiment quarterly and diff the results, and it becomes architectural
regression testing.

**The engine must never execute the experiment.** It is the map and the scoreboard, never
the hand on the switch. Chaos runs need blast-radius limits, abort conditions and an
accountable owner, all of which belong in dedicated tooling. Keep that boundary bright.

## 17.8 Cost and staging

| Milestone | Work | Cost |
|---|---|---|
| **M17a** | Observed-document import from one source (OTel service graph is the richest) | 1.5 days |
| **M17b** | Identity resolution and the mapping stored in `meta` | 2 days |
| **M17c** | Aggregation and noise filtering (§17.5) | 1 day |
| **M17d** | `diagram drift` — the comparison and its terse output | 1 day |
| **M17e** | Architectural invariants as assertions, CI-runnable | 1 day |
| **M17f** | Chaos hooks: predicted blast radius, predicted-vs-actual diff | 1 day |

**Roughly 7–8 days.** M17a–M17d alone deliver the undocumented-coupling finding, which is
most of the value.

## 17.9 Decision gates

1. **Does M8 show the agent drawing a truthful diagram from a codebase?** Drift detection
   compares against the designed document. If the designed document is fiction, the diff is
   noise.
2. **Does Part 15 exist?** Drift without analysis is a list of differences with no ranking.
3. **Can you get one real observed dump?** Before building the importer, export an actual
   service graph from a real system and look at it. Its size and filth decide §17.5's
   design, and no amount of reasoning substitutes for seeing one.

---

# Part 18 — Chaos

**Status: not a v2 requirement.** Out of scope for M0–M8. Split deliberately: §18.3–18.7
(**prediction**) need only Part 15 and are the cheapest high-value item on the roadmap;
§18.8 (**verification**) needs Part 17's observed pipeline.

## 18.1 Why

Chaos engineering is bad at exactly two things, and a structured architecture document
addresses both.

**Choosing what to break.** The experiment itself is easy; deciding which experiment is
worth running is the hard part, and in practice it is done by brainstorm. Part 15 already
emits a ranked list of the things everything else depends on. *"postgres is an articulation
point isolating 4 nodes"* is not an analysis result, it is an experiment proposal.

**Knowing whether the result was surprising.** "Did it stay up?" is a weak question.
"Did exactly the things we predicted would fail, fail?" is a strong one — and it is only
answerable if the prediction was written down first, which is what a design document is.

## 18.2 The split — read this before estimating

| | Answers | Needs | Cost |
|---|---|---|---|
| **Prediction** (§18.3–18.7) | "What breaks if this dies?" and "what should we break first?" | Part 15 only — no telemetry, no observation, no new infrastructure | ~1 day |
| **Verification** (§18.8) | "Did the right things break?" | Part 17's observed pipeline | ~1.5 days |

Prediction is a pure function over the document you already have. It is also the more
compelling demo of the two: *here is what falls over if this dies, ranked*, computed from a
diagram the agent drew ten seconds ago.

## 18.3 Predicted blast radius

**If node X dies, what is at risk?** Everything that depends on X, transitively.

Because edge direction points at the dependency (§4.4 rule 4 — caller to callee), that is
**reverse reachability over synchronous edges**:

```
blastRadius(doc, x) =
  { y : y →* x, following edges BACKWARDS from x,
        traversing ONLY edges whose style is solid (or absent) }
```

Three details carry the weight:

**Dashed edges stop propagation.** That is the entire meaning of asynchronous (§4.4 rule 6):
a queue consumer does not fail synchronously when its producer dies. Traversal halts at a
dashed edge, and the node on the far side is reported as **contained**, not at risk.
Containment is the design's own safety claim, so state it explicitly rather than leaving it
as an absence — it is the thing §18.8 later gets to test.

**Killing a group kills its descendants.** A VPC, region or AZ outage is a single
experiment, and the group hierarchy already expresses it.

**This is NOT the same metric as an articulation point.** Part 15's articulation points are
undirected graph connectivity ("removing this splits the diagram"); blast radius is
directed dependency propagation ("these specific things depend on it"). They usually agree
and sometimes do not, and the difference is informative. Report both; never conflate them.

## 18.4 The experiment backlog

Rank every node by predicted impact to produce a prioritised chaos backlog:

1. Number of at-risk nodes, descending.
2. Tie-break: is it an articulation point (Part 15)?
3. Tie-break: synchronous fan-in.

Exclude entry points — killing the browser client is not an experiment. **Do not exclude
`external` nodes:** a third-party outage is one of the most valuable experiments available
and one of the least often rehearsed.

## 18.5 Rules

| # | Rule |
|---|---|
| C1 | The engine NEVER executes an experiment. It is the map and the scoreboard, never the hand on the switch. Blast-radius limits, abort conditions and an accountable owner belong in dedicated chaos tooling. |
| C2 | Prediction traverses SYNCHRONOUS edges only. A dashed edge stops propagation, and every containment is reported by name. |
| C3 | Report **at risk**, never **will fail**. The document knows nothing of timeouts, retries, circuit breakers or graceful degradation. Overstating this is how a diagram starts lying with authority. |
| C4 | Every prediction and result records the document hash it was computed against. A result whose document has since changed is STALE and must be labelled so, never displayed as current. |
| C5 | Experiments and results NEVER enter `graph.json`. The document holds design meaning only (§1.4, §3.1). They live in `.diagram/chaos/`, which is gitignored by `diagram init`. |
| C6 | A predicted-vs-actual diff always reports BOTH directions (§18.8). Reporting only the surprises you expected defeats the purpose. |

C3 is the one that will be under pressure. A ranked list of "will fail" reads better and is
more likely to be believed; it is also the claim the document cannot support. Hold the line.

## 18.6 Data model

```
<project>/.diagram/chaos/
├── predictions/<node-id>.json     # at-risk set, contained set, doc hash, assumptions
└── results/<experiment-id>.json   # observed failures, doc hash, window, prediction ref
```

Nothing here is geometry and nothing is design meaning, so nothing belongs in the document
(C5). Results reference a prediction rather than embedding it, so a re-run against an
updated architecture is visibly a different comparison.

## 18.7 Surface

`diagram blast-radius <id>` and a `diagram_blast_radius` MCP twin, terse as everything else
(§4.1):

```
blast radius — postgres   (synchronous only; dashed edges stop propagation)
  at risk (4)    auth, orders, api-gateway, web-client
  contained (2)  kafka (async from orders), fulfilment
  articulation   yes — removing it also isolates 4 nodes
  assumptions    11 of 14 nodes carry no retry/timeout metadata; "at risk" is not "will fail"

experiment backlog
  1. api-gateway  11 at risk   articulation point
  2. postgres      4 at risk   articulation point
  3. redis-cache   2 at risk
```

The assumptions line is not padding. It is C3 and Part 15's A5 doing their job: an analysis
that hides its own blind spots is worse than none.

**In the viewer**, an analysis-style view mode (§15.5): ring the target, tint the at-risk
set, and draw the contained boundary at the dashed edges.

Two ways to choose the target, because they answer different questions:

- **Click a node.** *"What happens if THIS dies"* — the question you have while looking at
  the diagram. Clicking again clears it.
- **Cycle the button.** *"What should I break first"* — walks the ranked backlog (§18.4) in
  order, Shift for previous. This is the only mechanism when nothing is worth clicking yet.

**Multi-select.** Toggling several nodes off at once answers *"can we survive losing an
availability zone"*, and it is the strongest argument for having this in a viewer at all: it
turns a static answer into a model you can interrogate. The at-risk set for a set of targets
is the **union** of their individual sets — a node is at risk if any synchronous dependency
dies — and each blast radius is O(n+e), so toggling is free.

**Read §18.11 before trusting a multi-select result.** The union is correct only because the
document cannot express redundancy, which is precisely what multi-select is usually used to
investigate.

Selecting, toggling and clearing are all viewport state. Nothing here writes the document
(§7, §1.6); there is no schema field for "which overlay am I looking at" and there must
never be one — it is a lens, not a design decision.

## 18.8 Verification (needs Part 17)

Run the experiment in real chaos tooling, import the observed state (Part 17), and diff
predicted against actual. **Both directions are findings** (C6):

| Outcome | What it means |
|---|---|
| **Failed but not predicted** | Hidden synchronous coupling — the highest-value finding in this entire document. |
| **A dashed edge cascaded** | An asynchronous path was made synchronous somewhere. The schema already records the intent (§4.4 rule 6), so this is machine-detectable. |
| **Predicted but survived** | Either resilience nobody documented, or the edge is not real — dead architecture (§17.3 item 5). Both are worth knowing. |

Run the same experiment quarterly and diff the results, and this becomes architectural
regression testing: the system's resilience acquires a changelog.

## 18.9 Cost

| Milestone | Work | Cost |
|---|---|---|
| **M18a** | `blastRadius` and backlog ranking as pure functions in `core/analysis/`, with fixtures | 0.5 day |
| **M18b** | `diagram blast-radius` CLI + MCP twin, terse output, C1–C5 enforced | 0.5 day |
| **M18c** | Viewer blast-radius view mode | 0.5 day |
| **M18d** | Predicted-vs-actual diff (needs Part 17) | 1 day |
| **M18e** | Result history and regression over time | 0.5 day |

M18a–M18b is **one day for the whole prediction half**, reusing Part 15's traversal.

## 18.10 Decision gates

1. **Does Part 15 exist?** Prediction reuses its graph traversal and its articulation-point
   computation. Building chaos first means building Part 15 badly, twice.

2. **Is the edge-direction convention actually trustworthy?** *This is the gate that
   matters.* Blast radius is computed entirely from direction: reverse the arrows and the
   prediction is not degraded, it is exactly backwards — and it will be delivered with a
   ranked list and total confidence. This is not hypothetical. The first real document built
   under the pre-rewrite rule 4 had **eight of seventeen labelled edges pointing the wrong
   way**, mixing dependency and data-flow conventions in one diagram. A blast radius
   computed on that document would have named the wrong services, in the wrong order, and
   read as authoritative. Do not build this until M8 has demonstrated that the agent draws
   direction correctly and consistently.

3. **For verification only:** does Part 17 exist, and can chaos experiments actually be run
   safely in your environment? If not, build the prediction half and stop — it stands on its
   own.

## 18.11 Redundancy — the one thing the model cannot express

**Not built. Read this before extending blast radius, because it bounds what every number
in Part 18 means.**

Every edge in the document asserts a **hard dependency**. There is no way to say *X depends
on A **or** B* — two replicas, two availability zones, a primary and a standby. So blast
radius treats losing one replica exactly as it treats losing a sole database.

The consequence is quiet and one-directional: **blast radius over-reports wherever
redundancy exists.** A single-target prediction is already slightly pessimistic. Multi-select
(§18.7) sharpens the error rather than revealing it — you toggle off two replicas, see a
large at-risk set, and get no signal that losing the first one alone was survivable. The
tool answers confidently, and it answers a question you did not ask.

### The minimal model

```ts
export interface GEdge {
  // ...existing fields
  alt?: string;   // edges FROM ONE SOURCE sharing an `alt` tag are alternatives,
                  // not independent hard dependencies
}
```

Semantics, and they are the whole of it: **failure propagates to the source only when every
edge in an `alt` set is killed.** An edge with no `alt` is a hard dependency, exactly as
today, so every existing document keeps its current meaning. The change is additive and
nothing needs migrating.

The tag is scoped **per source node**. `orders → pg-primary` and `orders → pg-replica` both
tagged `db` are alternatives; an edge from a different node tagged `db` is unrelated. Scoping
it globally would silently link services that merely chose the same word.

### Invariants

| # | Rule | Error message |
|---|---|---|
| V18 | An `alt` tag on a single edge from one source is meaningless | `edge "e7" has alt "db" but it is the only edge from "orders" with that tag: alternatives need at least two` |
| V19 | `alt` requires a synchronous edge — an async path already stops propagation (§18.3) | `edge "e9" is dashed and carries alt "db": asynchronous edges already contain failure; drop one` |

### How it actually gets expressed

**This engine's input is a person describing their system in prose.** Redundancy therefore
arrives the same way everything else does — in a sentence — and the design has to make that
sentence sufficient. Nobody is going to hand-edit an `alt` tag.

| What the user says | What the agent emits |
|---|---|
| "postgres has a read replica" | two nodes, both `orders → …` edges tagged `alt: "pg"` |
| "we run three kafka brokers" | three nodes, consumers' edges sharing one `alt` |
| "the api talks to whichever auth instance is up" | the auth instances' inbound edges sharing one `alt` |
| "those two are replicas of each other" | `updateEdge` on the existing edges, adding `alt` |

That last row matters as much as the others. Redundancy is usually **remembered late** —
the diagram gets drawn, someone looks at a blast radius and says "that's not right, those
are replicas". Under the patch model that is one `updateEdge` per edge on a document that
already exists, with no re-drawing and no lost ids (G3). The correction has to be as cheap
as the original claim, or it will not get made.

**Granularity follows D-NODE.** The build plan already decided one node per deployable, so
two replicas are two nodes and `alt` is the right shape. A user who says only "we run
postgres" gets one node, and a blast radius on it correctly means losing the whole store;
`alt` only enters once the instances are drawn separately, which happens exactly when the
user cares about losing one of them.

### The agent rule

> **14. REDUNDANCY IS SOMETHING YOU ARE TOLD, NOT SOMETHING YOU DEDUCE.** When the user says
> two things are replicas, standbys or instances of the same component, tag their edges with
> the same `alt`: they are alternatives, not two dependencies. When you are only reading a
> codebase, do NOT infer it — two connection strings are not evidence of failover. Ask, or
> leave `alt` off.

The asymmetry behind that rule has to stay in the text or an agent will optimise for a
tidier diagram. Over-reporting blast radius is conservative and survivable. **Under-reporting
it because an agent guessed at redundancy hides a real single point of failure**, and the
person reading the diagram has no way to tell the difference. A stated redundancy is a fact
from the person who runs the system; an inferred one is a guess wearing the same clothes.

### What it unlocks

With redundancy modelled, the **pairwise backlog** becomes meaningful: which two simultaneous
failures are worst. At the 200-element cap that is ~20,000 blast-radius computations, each
O(n+e) — milliseconds. It is the question chaos engineering actually wants ranked, and
nothing else in this document answers it.

### Cost

| Milestone | Work | Cost |
|---|---|---|
| **M18f** | `alt` on the schema, V18–V19, rule 14, and blast radius honouring alternatives | 1 day |
| **M18g** | Pairwise backlog ranking | 0.5 day |
