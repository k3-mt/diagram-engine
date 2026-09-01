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

## Installing

**As a Claude Code plugin** — nothing is built or installed on your machine:

```bash
claude plugin marketplace add k3-mt/diagram-engine
claude plugin install diagram@diagram-engine
```

The ten tools, the rules and a `/diagram-serve` command are simply there on next
launch. There is no package manager step, because the plugin ships a prebuilt,
bundled `dist/` and **no `package.json` and no lockfile** — installing it is a pure
file fetch of an artifact that was built and audited once, rather than a build every
engineer runs. `npm run verify:plugin` re-checks that artifact against the source.

For a team, commit this to `.claude/settings.json` and nobody runs an install command
at all:

```json
{
  "extraKnownMarketplaces": {
    "team-tools": { "source": { "source": "github", "repo": "k3-mt/diagram-engine" } }
  },
  "enabledPlugins": ["diagram@team-tools"]
}
```

**From source**, which also gives you the `diagram` CLI:

```bash
npm install
npm run build
npm link              # puts `diagram` on your PATH

cd /path/to/your/project
diagram init          # .mcp.json, .gitignore, agent rules, Claude Code skill
diagram serve         # viewer on http://localhost:4400 — optional, see below
```

`diagram init` is safe to run either way: under a plugin install it detects
`CLAUDE_PLUGIN_ROOT`, writes only what is genuinely per-project (`.diagram/`, the
`.gitignore` block) and skips the MCP config, the rules and the skill the plugin
already provides — so the rules text can never end up on disk twice, drifting.

`diagram serve` is optional from the first patch onwards: a patch that draws something
starts the viewer itself if one is not already up, and says so
(`viewer: started at http://localhost:4400/`). Set `DIAGRAM_NO_AUTOSERVE=1`, or pass
`--no-serve`, to keep that from happening.

**Upgrading a project initialised before auto-serve existed?** Re-run `diagram init`. It
is idempotent, and it adds `.diagram/serve.json` — the machine-local pid and port of your
viewer — to the managed `.gitignore` block, so it does not end up in a commit.

Then start your agent. It picks up the MCP server on next launch and gets ten tools:
`diagram_get`, `diagram_patch`, `diagram_undo`, `diagram_redo`, `diagram_view`,
`diagram_export`, `diagram_check`, `diagram_analyse`, `diagram_blast_radius`,
`diagram_reset`.

Under a plugin install your client namespaces them — `mcp__plugin_diagram_diagram__diagram_get`
and so on — which is why the rules describe tools by role rather than pinning exact names.

**New here?** [TRYING-IT.md](TRYING-IT.md) is a ten-minute first session — install, talk to
your agent, and check its work.

## Two processes, one file

```
agent ──stdio(MCP)──▶ diagram-mcp ──writes──▶ .diagram/graph.json
                                                    │ fs.watch
                                                    ▼
                                              diagram serve ──SSE──▶ browser
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
check     validate; --bindings also resolves every citation against the filesystem
analyse   structural pressure: chokepoints, sync chains, cycles, boundaries
blast-radius   what is at risk if a component dies; no id ranks the experiments
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
            the MCP server, and the viewer's HTTP + SSE host
  viewer/   the browser bundle: ELK layout, crossing/hop geometry,
            the SVG renderer, and headless SVG export
docs/spec.md   the full product and build specification
```

## Development

```bash
npm test                   # 1241 tests
npm run typecheck
npm run check:no-model-sdk # fails if a model SDK or dotenv appears anywhere
npm run build              # both binaries + the viewer bundle
```

All four must pass. Stages 2–5 of the pipeline (view, layout, geometry, render) are pure
functions over fixtures, so almost everything is testable with no agent and no browser.

## Status

Everything in Parts 1–13 of the spec is built and verified: the document core, ELK layout,
crossing detection with hop arcs, the renderer, the viewer server, the full agent surface,
views and export — plus three things the spec originally listed as future directions.

**Structural analysis** (Part 15). `diagram analyse` reports fan-in, shared dependencies,
articulation points, the longest synchronous chain, boundary crossings and synchronous
cycles, and always reports its own coverage — how much of the document carries no
operational data — because an analysis that hides its blind spots is worse than none.

**Blast-radius prediction** (Part 18). `diagram blast-radius <id>` answers what is at risk
if a component dies, computed as reverse reachability over synchronous edges. Dashed edges
stop propagation and the node beyond one is reported *contained* by name. It reports "at
risk", never "will fail" — the document knows nothing of retries or circuit breakers.
Redundancy is expressible: edges from one source sharing an `alt` tag are alternatives, so
losing one replica does not take the caller down.

**Provenance** (§3.8). Nodes and edges carry `bindings` — where a claim was read —
and `diagram check --bindings` resolves every one against the filesystem, including
identifier refs like `terraform=aws_ecs_service.orders`, which it verifies by structured
pattern rather than substring. It exits non-zero on a citation that does not resolve, so it
runs in CI without an agent.

### How that is known

There is a benchmark, not just a test suite. Two reference systems live in `fixtures/` —
one docker-compose and JavaScript, one Terraform and Go — each with a real coupling visible
only in source and a plausible component that does not exist. `scripts/eval.sh` runs an
agent against a sandboxed copy with the answer key withheld and scores node set, edge set,
**edge direction as its own number**, invention, and binding precision.

The second system is held out: it was never used to tune the rules text, so it is the only
score that counts. Over twenty runs it reports direction 1.0, invention 0, binding
precision 1.0, with zero spread.

Direction is scored separately for a reason. An agent can identify every connection
correctly and draw all the arrows backwards, and precision and recall both stay at 1.0.
That happened, and it is why rule 4 was rewritten.

**Distribution** (Part 16). The engine ships as a Claude Code plugin, built by
`npm run build:plugin` into `plugin/` — bundled with esbuild into two self-contained
`.mjs` binaries, carrying no manifest and no lockfile so the auto-install path is
unreachable rather than merely unused. `npm run verify:plugin` is the
reproducible-build check §16.8 requires: a reviewer rebuilds the tag and confirms the
committed bundle matches the source, file by file, or the artifact is unauditable and
the whole supply-chain argument collapses.

Getting there removed two runtime dependencies (§16.3). `chokidar` was the only reason
a native binary was in the tree — and native code cannot be bundled at all, so it did
not merely add review surface, it made the artifact impossible. `ws` was replaced by
Server-Sent Events: the server only ever pushes and the browser never replies, so
`EventSource` does the reconnecting the hand-rolled client used to, and both the
dependency and the code went away.

### Not done

- **The prose benchmark** (BUILD.md Phase 6). Both reference systems are repositories, so
  acceptance G1 — "a 100-word description produces a correct diagram, no follow-up" — is the
  headline criterion that nothing measures yet.
- Binding chips in the viewer's hover panel.
- Deliberately out of scope: the layered canvas (Part 14), observed-vs-designed drift
  (Part 17), chaos *verification* (§18.8), and mouse editing.

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
