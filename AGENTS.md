# AGENTS.md — build and install the diagram engine

**Audience: an agent setting this repository up so a human can use it.** Follow it
top to bottom. Every command below was run against a fresh clone of this branch.

**About the numbers.** Test counts, file counts and byte sizes are quoted as they
were at version 0.1.0, to show you the shape of a healthy result. They move with
every commit and with npm and esbuild versions. Treat *pass/fail* as the gate and
the counts as orientation — do not halt a green build because a number drifted.

This file is about **building the artifact for use**. It is not `BUILD.md`, which is
the builder/critic development loop, and not `docs/spec.md`, which is the product
specification.

---

## 0. What you are building

A local engine that turns prose into architecture diagrams. The agent supplies the
meaning; a layout engine supplies the geometry. There is **no model inside the
engine** and no API key anywhere in it — the intelligence is whatever agent is
already running.

Two deliverables come out of this repository, and you can build either or both:

| Deliverable | What it gives | Who needs it |
|---|---|---|
| **The Claude Code plugin** (`plugin/`) | Ten MCP tools, the authoring rules, a `/diagram-serve` command | Anyone using Claude Code. No npm, no build on their machine. |
| **The `diagram` CLI** | The same engine as a shell command, plus `serve`, `check --bindings`, `analyse` | CI, non-MCP agents, and anyone who wants the command line |

The plugin is the primary distribution. The CLI is how you verify it and how CI
checks citations.

## 1. Prerequisites

- **Node 18 or newer.** The bundles target `node18`. Developed and verified on
  Node 25. No `engines` field is declared, so nothing will stop you on an older
  runtime — it will simply fail later, at run time, with an error that points
  somewhere else. Check first:

  ```bash
  node --version    # must be >= v18
  ```

- **npm 9 or newer** (workspaces are used).
- **git.**
- No API key. No credentials of any kind. If a step ever asks you for one,
  something is wrong.

## 2. Build from source

```bash
git clone https://github.com/k3-mt/diagram-engine.git
cd diagram-engine
REPO=$(pwd)        # later sections need this path; bind it now
npm ci --ignore-scripts
npm run build
```

**Use `npm ci --ignore-scripts`, not `npm install`.** Most real npm attacks execute
through a `postinstall` hook, and nothing in this tree needs install scripts. `ci`
also installs exactly the lockfile rather than resolving fresh.

Two workspaces build in sequence — the CLI first, then the viewer — so expect to
see these two lines partway through, not at the end:

```
bundle: diagram -> dist/bin/diagram.mjs (5095 kB)
bundle: diagram-mcp -> dist/bin/diagram-mcp.mjs (4946 kB)
```

The run ends with Vite's `✓ built in …`.

Within the CLI workspace, `tsc` type-checks and emits, then esbuild inlines every
dependency into two self-contained `.mjs` files. The viewer workspace then builds
the browser bundle with Vite.

**Everything lands under `packages/cli/dist/`** — the `dist/bin/diagram.mjs` in that
log line is relative to the CLI package, not the repository root. In full:
`packages/cli/dist/bin/{diagram,diagram-mcp}.mjs` and `packages/cli/dist/public/`.
There is no `dist/` at the repository root. The Vite "chunks larger than 500 kB" warning is expected
— it is the ELK layout engine, and it is bundled deliberately.

## 3. Verify the build

Four checks, three commands — `npm run check` runs two of them. All four must pass
before you believe anything works.

```bash
npm test         # 1357 passed (47 files)
npm run typecheck
npm run check    # check:no-model-sdk + check:deps
```

```
Test Files  47 passed (47)
     Tests  1357 passed (1357)
check:no-model-sdk OK — no model SDK, no dotenv, anywhere.
check:deps ok
```

`check:no-model-sdk` fails the build if a model SDK or `dotenv` ever appears.
`check:deps` fails on any runtime dependency outside the allowlist — currently
`zod`, `@modelcontextprotocol/sdk`, `elkjs`, `commander`, `react`, `react-dom`.
**Do not widen that allowlist to make a build pass.** It is the thing holding the
line, and `chokidar` and `ws` were removed from it deliberately (see §7).

## 4. Build and check the plugin

```bash
npm run build:plugin     # assembles plugin/ from the built dist
npm run verify:plugin    # re-hashes it against plugin.sha256
```

```
plugin: <repo>/plugin
  9 files, 12.9 MB
  no package.json, no lockfile — install is a pure file fetch
verify-plugin ok — 9 files match plugin.sha256
```

`verify:plugin` is the reproducible-build check. `plugin/` is a **committed**
prebuilt artifact, which is only defensible if a reviewer can rebuild it from source
and confirm it matches — otherwise "we ship a prebuilt bundle" becomes "we ship a
binary nobody can verify". Running steps 2 and 4 from a clean clone and getting
`verify-plugin ok` *is* that audit.

`build:plugin` fails if a `package.json` or lockfile ever appears inside `plugin/`.
That is not tidiness: a plugin shipping a manifest with a lockfile gets its
dependencies auto-installed on every user's machine, which is exactly the
install-time risk this whole shape exists to remove.

**If the hashes differ and you changed nothing**, do not reach for `--write`. The
build is deterministic *because* `npm ci` installs the exact esbuild and vite pinned
in the lockfile, and esbuild's output does not vary with your Node version. So a
mismatch on an unmodified tree means one of three things, in order of likelihood:
you ran `npm install` rather than `npm ci` and picked up a newer bundler; your tree
is not clean (`git status`); or the committed artifact genuinely does not match the
committed source, which is exactly the finding this check exists to surface. Report
it — do not paper over it.

Re-record **only** when you intentionally changed what the plugin contains, and in
the same commit as the change:

```bash
npm run verify:plugin -- --write
```

## 5. Install it

### As a Claude Code plugin (the normal route)

```bash
claude plugin marketplace add k3-mt/diagram-engine
claude plugin install diagram@diagram-engine
```

The repository is its own marketplace: `.claude-plugin/marketplace.json` at the root
points at `./plugin`. Nothing is compiled or downloaded from a registry — the
install is a file fetch of the committed artifact.

To test a local build before pushing, add the working copy by path instead:

```bash
claude plugin marketplace add "$(pwd)"
claude plugin install diagram@diagram-engine
```

Verify it actually connected — an MCP server that fails to start looks identical to
one that is merely absent:

```bash
claude mcp list
# plugin:diagram:diagram: node .../dist/bin/diagram-mcp.mjs - ✔ Connected
```

### As a CLI

```bash
npm link --workspace @diagram-engine/cli    # after npm run build
diagram --version                            # 0.1.0
```

**Must be workspace-scoped.** The root `package.json` is `private` and declares no
`bin`; a bare `npm link` at the root links the root package and puts nothing on your
PATH, silently. The binary belongs to `@diagram-engine/cli`.
`cd packages/cli && npm link` is equivalent. Either form writes into npm's global
prefix, so on a system-managed Node it can fail with `EACCES` — use a user-owned
prefix or a version manager rather than `sudo`.

The plugin does **not** put `diagram` on your PATH — the `bin` convention is not
part of marketplace distribution. Inside Claude Code the `/diagram-serve` command
covers the important case; `npm link` covers the rest.

## 6. Confirm it works, end to end

Do not report success until a diagram has actually been drawn.

**This section needs BOTH routes from §5.** The plugin is what draws the diagram;
the CLI is what inspects it. If you installed only the plugin, substitute
`node $REPO/packages/cli/dist/bin/diagram.mjs` for `diagram` below.

```bash
mkdir -p /tmp/diagram-smoke && cd /tmp/diagram-smoke
claude -p "Draw: an nginx load balancer in front of a Go payments API that reads MySQL and caches in Redis." \
  --permission-mode acceptEdits
```

**`--permission-mode acceptEdits` is required.** A headless `claude -p` grants no
tool permission by default: the patch is declined, the run still exits 0, and you
are left checking an empty `.diagram/` against expectations of four nodes. That
failure reads as "the engine is broken" when nothing is wrong with it.

No agent to hand? Seed the same graph through the CLI alone and skip to the checks:

```bash
cat > patch.json <<'JSON'
{"summary":"nginx in front of a payments api on mysql and redis","ops":[
 {"op":"addNode","node":{"id":"nginx","type":"service","label":"nginx","parent":null}},
 {"op":"addNode","node":{"id":"payments-api","type":"service","label":"Payments API","parent":null}},
 {"op":"addNode","node":{"id":"mysql","type":"database","label":"MySQL","parent":null}},
 {"op":"addNode","node":{"id":"redis","type":"cache","label":"Redis","parent":null}},
 {"op":"addEdge","edge":{"id":"nginx-payments-api","from":"nginx","to":"payments-api","label":"http"}},
 {"op":"addEdge","edge":{"id":"payments-api-mysql","from":"payments-api","to":"mysql","label":"reads"}},
 {"op":"addEdge","edge":{"id":"payments-api-redis","from":"payments-api","to":"redis","label":"caches"}}
]}
JSON
diagram init && diagram patch < patch.json
```

Then check the result from the CLI:

```bash
diagram get          # four nodes, three edges
diagram check        # ok — 4 nodes, 0 groups, 3 edges
diagram analyse      # chokepoints, sync chains, coverage
```

The viewer starts itself on the first patch that draws something; the agent reports
the URL. Open it, or run `diagram serve`, or use `/diagram-serve` inside Claude Code.

**Read the arrows before declaring success.** Edge direction points at the
*dependency*: `payments-api -> mysql` reads as "payments-api reads mysql". An agent
can identify every connection correctly and draw every arrow backwards while
precision and recall both stay at 1.0, which is why direction is scored separately
in the benchmark.

To prove the artifact is genuinely self-contained, run it where no `node_modules`
exists anywhere up the tree:

```bash
cd "$REPO"         # the smoke test above left you in /tmp/diagram-smoke
mkdir -p /tmp/isolated && cp -R packages/cli/dist /tmp/isolated/dist
cd /tmp/isolated && node dist/bin/diagram.mjs --version   # 0.1.0
```

## 7. Traps

Each of these cost real debugging time. They are listed because the failure mode is
misleading, not because the fix is hard.

**The bundles must be `.mjs`.** Node decides ESM-vs-CommonJS by looking up the
directory tree for a `package.json` — and the plugin deliberately has none, so the
extension is the only channel left to declare the format. A `.js` bundle there is
parsed as CommonJS and dies on its own first `import`, or confusingly on the
shebang.

**`chokidar` and `ws` must stay out.** `chokidar` pulls in `fsevents`, a native
`.node` binary that esbuild cannot inline — it does not merely add review surface,
it makes the bundle impossible to produce. `ws` was replaced by Server-Sent Events,
because the server only ever pushes and the browser never replies. Re-adding either
breaks distribution, not just purity.

**A stale binary looks like a broken one.** The bundler clears `dist/bin` before
writing for this reason. If an `npm link` symlink or a plugin's `.mcp.json` points
at a file a rename orphaned, you get an MCP server that appears broken but is merely
old. Check `claude mcp list` — it names the exact path each server runs.

**Open the port the viewer actually printed, not 4400.** The viewer requests 4400
and auto-increments to 4401, 4402… when it is taken (up to 4410). Port 4400 is very
often already held — by your own earlier `diagram serve`, or by a *different user
account* on the same machine — and a stale viewer there serves an older bundle of
the app itself. That looks exactly like your own viewer with features missing: the
diagram is someone else's, and UI added since that bundle was built is absent. It is
a confusing failure precisely because nothing is broken.

Ask a port which document it is showing:

```bash
curl -s http://localhost:4400/__diagram/serve.json
```

A viewer for your document answers with a JSON identity naming the exact
`graph.json` it watches. Anything else — `not found`, or a different document —
means that port is not yours. `ps aux | grep 'diagram serve'` names the owner.

**The plugin cache is keyed by version, and does not refresh in place.** After
bumping the version and rebuilding, an installed plugin keeps serving the old
version directory until it is reinstalled:

```bash
ls ~/.claude/plugins/cache/<marketplace>/<plugin>/    # one dir per version
claude plugin uninstall diagram && claude plugin install diagram@diagram-engine
```

Confirm with `claude mcp list`, which prints the full path each server runs from —
the version is in it.

**Two `diagram` MCP servers can coexist.** A plugin install provides
`plugin:diagram:diagram`; an older `diagram init` may have left a `diagram` entry in
`~/.claude.json` pointing at a global binary. One failing does not mean the other
is broken. `claude mcp list` distinguishes them.

**Tool names are namespaced under a plugin.** They arrive as
`mcp__plugin_diagram_diagram__diagram_get`, not `diagram_get`. The authoring rules
describe tools by role rather than pinning exact names for this reason. If you
allowlist tools explicitly, use the full namespaced form.

**`diagram patch` reads stdin.** `diagram patch file.json` waits on stdin forever
and looks like a hang. Use `diagram patch < file.json`.

**`.gitignore` has a blanket `dist/`,** which would swallow `plugin/dist` and ship a
plugin with no binaries and no warning. There is a `!plugin/dist/` negation. Do not
remove it.

**Set `DIAGRAM_NO_AUTOSERVE=1` in any script of your own that patches**, or a patch
will start a viewer process you did not ask for. This repository's own suite sets it
in `packages/cli/tests/setup.ts`, so `npm test` is already safe — the trap is for
scripts you write.

## 8. Releasing

1. Build from a tagged commit with `npm ci --ignore-scripts`.
2. Commit `plugin/` and `plugin.sha256` together, in a clearly-labelled release
   commit. They must never move separately — a manifest describing a different
   bundle is worse than no manifest.
3. Bump the version in all four `package.json` files — the repository root,
   `packages/core`, `packages/cli`, `packages/viewer` — **and** `CLI_VERSION` in
   `packages/cli/src/index.ts`. (`plugin/` has no manifest to bump; §4 is why.)
   `packages/cli` and `packages/viewer` also pin `@diagram-engine/core` by exact
   version, so those specifiers move in the same commit or `npm install` cannot
   resolve the workspace link. A test asserts they agree, because
   `build:plugin` stamps `plugin.json` and the marketplace entry from
   `packages/cli/package.json`, and that number is what users pin.
4. `claude plugin tag .` cuts a `{name}--v{version}` git tag — `diagram--v0.1.0` —
   and refuses if `plugin.json` and the marketplace entry disagree. Confirm with
   `git tag --list 'diagram--v*'`.

Pinning the plugin pins `packages/core/rules.md`, and **that file is the prompt** —
in an architecture with no system prompt, it is the only thing governing how every
engineer's agent draws. Treat changes to it with the care of a schema migration, and
edit `packages/core/src/rules/load.ts` in the same commit: the two are hand-synced
and a test asserts they are byte-identical.

## 9. Where things are

```
packages/core/     schema, validation, patch application, history, views,
                   the .diagram/ store, and rules.md — no DOM, no network
packages/cli/      the diagram + diagram-mcp binaries, CLI commands, the MCP
                   server, the viewer's HTTP + SSE host
packages/viewer/   the browser bundle: ELK layout, hop geometry, SVG renderer
plugin/            the built, committed plugin artifact — do not hand-edit
scripts/           build-plugin.mjs, verify-plugin.mjs, the eval harness
docs/spec.md       the full specification, including deliberately unbuilt parts
```

`packages/core/rules.md` is surfaced four ways: embedded in the `diagram_patch` tool
description, printed by `diagram rules`, written into `CLAUDE.md`/`AGENTS.md` by
`diagram init`, and installed as the plugin's skill. Changing it changes all four.
