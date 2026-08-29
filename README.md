# diagram-engine

A local engine that turns prose into architecture diagrams, driven by the coding agent
you are already running.

You install it into a project, run one command to open a viewer in your browser, and then
talk to Claude Code (or Codex, Cursor, Zed, or anything that speaks MCP) as normal. The
diagram builds itself in the window beside you.

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
└───────────────────────────────┘  └───────────────────────────────┘
```

## No API keys. Ever.

This project ships no key handling, no `ANTHROPIC_API_KEY`, no HTTP client to any model
provider, no `.env` with a secret in it. **There is no model in the engine at all.**

The intelligence is whatever you are already running and already paying for. The engine is
a tool the agent picks up, the way it picks up `git` or `grep`. A CI check fails the build
if a model SDK or `dotenv` ever appears in a `package.json`.

That is not only a purity constraint. It means the agent that has just read your
`docker-compose.yml` is the thing drawing the diagram — so *"diagram our infrastructure"*
is a real instruction rather than a prompt you hand-write. And when a patch is rejected,
the agent reads the validation errors and fixes its own mistake on the next call, so the
whole retry subsystem simply does not exist.

## The core principle

**The model never emits coordinates.**

| Stage | Produces |
|---|---|
| Agent | **meaning** — nodes, types, containment, edges |
| Layout engine (ELK) | **geometry** — x, y, width, height, waypoints |
| Renderer | **pixels** — SVG paths, hop arcs, labels |

Language models are good at pulling structure out of prose and bad at spatial packing.
Layout engines are the reverse. The document on disk contains no geometry of any kind.

## Quick start

```bash
npm install
npm run build

cd /path/to/your/project
diagram init          # .mcp.json, .gitignore, agent rules, Claude Code skill
diagram serve         # viewer on http://localhost:4400
```

Then start your agent. It picks up the MCP server on next launch and gets seven tools:
`diagram_get`, `diagram_patch`, `diagram_undo`, `diagram_redo`, `diagram_view`,
`diagram_export`, `diagram_reset`.

The package is not published yet, so `diagram` must be on your `PATH` — `npm link` from
this repo, or install it globally.

## Two processes, one file

```
agent ──stdio(MCP)──▶ diagram-mcp ──writes──▶ .diagram/graph.json
                                                    │ chokidar
                                                    ▼
                                              diagram serve ──ws──▶ browser
```

The MCP process lives and dies with your agent session; the viewer should not. Putting the
document on disk decouples them completely — restart your agent and the viewer keeps
showing the diagram. `graph.json` is meant to be committed to git, so diagrams travel with
the repo.

## The CLI

Every MCP tool has a CLI twin, so an agent that can only run shell commands can drive the
engine too. Both surfaces run through the same code path and an integration test asserts
they produce byte-identical output.

```
init      install the engine into a project
get       print the diagram as a compact text table
patch     apply a GraphPatch from stdin or a file
undo      redo      step through history
view      exec | eng | focus <id>   — set which groups are collapsed
serve     the viewer, with live reload
export    write json or svg
import    replace the document from a JSON file
check     validate; exit 1 with the problems on stderr
rules     print the agent rules (--erd for ERD mode)
mcp       run the MCP server on stdio
reset     clear the diagram (requires --confirm; undoable)
```

Exit `0` on success, `1` on validation failure with errors on stderr.

## Views

Three audiences, one document. Views derive by collapsing groups — never by re-prompting,
and never by a model turn.

| View | Shows |
|---|---|
| **exec** | every top-level boundary collapsed to one box |
| **eng** | everything open |
| **focus `<id>`** | one group open, siblings shut |

Collapsing merges edges: three edges from inside `vpc-private` to `api-gateway` become one,
labelled `×3`. The viewer's view buttons are a **local override** — they change what you
see and never write to the document.

## Repository layout

```
packages/
  core/     schema, validation (V1–V13), patch application, history,
            views, the .diagram/ store, and rules.md — no DOM, no network
  cli/      the `diagram` and `diagram-mcp` binaries, the CLI commands,
            the MCP server, and the viewer's HTTP + WebSocket host
  viewer/   the browser bundle: ELK layout, crossing/hop geometry,
            the SVG renderer, and headless SVG export
docs/spec.md   the full product and build specification
```

## Development

```bash
npm test                   # 691 tests
npm run typecheck
npm run check:no-model-sdk # fails if a model SDK or dotenv appears anywhere
npm run build              # both binaries + the viewer bundle
```

All four must pass. Stages 2–5 of the pipeline (view, layout, geometry, render) are pure
functions over fixtures, so almost everything is testable with no agent and no browser.

## Status

Milestones M0–M7 are built and verified end to end: document core, ELK layout, crossing
detection with hop arcs, the themed renderer, the viewer server, the full agent surface,
and views plus export.

**M8 — rules hardening — is the remaining milestone.** It is twenty varied sessions across
at least two different agents, logging every rejected patch and every ID coercion, and
fixing `rules.md` rather than the code unless a real bug appears.

`docs/spec.md` also carries five specified but unbuilt directions: the layered canvas
(Part 14), structural analysis of bottlenecks and chokepoints (Part 15), packaging as a
Claude Code plugin (Part 16), importing observed topology from a running system to diff
against the design (Part 17), and chaos blast-radius prediction (Part 18). Each has
explicit decision gates, and all of them gate on M8.

## A note on the rules

`packages/core/rules.md` is not documentation — in an architecture with no system prompt,
**that text is the prompt.** It is surfaced four ways: embedded in the `diagram_patch` tool
description, printed by `diagram rules`, written into `CLAUDE.md`/`AGENTS.md` by
`diagram init`, and installed as a Claude Code skill.

It is also hand-synced with an embedded constant in `packages/core/src/rules/load.ts`
(because `tsc` never copies `.md` into `dist/`, and a path-based read would fail once
installed). A test asserts they are byte-identical, so drift fails the suite. **Edit both.**

Treat changes to that file with the care you would give a schema migration. Rule 4 once
read *"edge direction is the direction of the request or data flow"* — self-contradictory
for a read, since the request goes one way and the data comes back the other. It produced
two opposite conventions inside a single document, and eight of seventeen labelled edges
pointed the wrong way before it was caught.
