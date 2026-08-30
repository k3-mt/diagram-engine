# Topology — build plan

**Companion to:** `docs/spec.md` (the product requirements document)
**Mutable state:** `LEDGER.md`
**Critic instructions:** `CRITIC.md`

Two agents alternate. A **builder** does one task per session. A **critic** then tries
to prove that task wrong, in a fresh session, with no access to the builder's reasoning.
Neither role ever runs long enough to lose the thread, because all state lives in
`LEDGER.md` on disk.

---

## Part 0 — Builder protocol

Read this at the start of every builder session.

1. Read `LEDGER.md`. Pick the next task, in this priority order:
   1. any task the critic set to `partial` with a `REJECTED` verdict
   2. any task marked `partial`
   3. the first `todo` task whose dependencies are all `done`

   **A rejected task outranks everything.** Moving on and leaving rejected work behind
   is the exact failure the critic exists to prevent.

2. Every open question is already answered in Part 2. Do not stop to ask. If a task
   genuinely cannot proceed, mark it `blocked` with the reason and move to the next one.

3. Re-read the sections of `docs/spec.md` named in the task's `spec` column.
   Work from the document, not from memory of it.

4. Implement that task. Only that task.

5. Run the task's verify command. If it fails, fix and re-run. After three failed
   attempts, set the task to `blocked`, write what you tried and what failed into the
   ledger, and move on to the next task rather than exiting.

6. Run `npm test && npm run check`. Both green before you commit.

7. `git commit -m "<task-id>: <one line>"`. One task, one commit.

8. Update `LEDGER.md`: set the status, clear the `critic` column, append a log line with
   the task id, the commit SHA, and anything surprising. The log line is the only window
   a later session has into this one. "Implemented P1-02" is a wasted line.

9. Stop. Do not start the next task.

**Session hygiene.** One task per session, unless it is marked `small`, in which case up
to three. When context passes half full, finish, commit, update the ledger, exit.

---

## Part 1 — Ground rules

| # | Rule |
|---|---|
| R1 | **No model provider code.** No `openai`, no `@anthropic-ai/sdk`, no `dotenv`, no API key handling, no HTTP client to a model provider. `npm run check:no-model-sdk` enforces it. |
| R2 | **No network in the engine.** The engine reads and writes files. Anything that opens a socket is a separate binary with a separate threat model. This applies to the fixtures too: reference systems are read as source, never started. |
| R3 | **No new runtime dependency** without a gate. `npm run check:deps` is the line. Widening the allowlist is a human decision. |
| R4 | **Never persist geometry.** No x, y, width, height, waypoint or path in any committed document. (spec §1.4) |
| R5 | **The document holds design claims only.** No runtime state, no health, no timestamps, no "last checked". A binding says where a node came from, never what it is doing. |
| R6 | **Do not skip a gate.** |
| R7 | **Do not mark a task done on partial work.** Leave it `partial`, log what is finished, exit. |
| R8 | **Tests before implementation** where the task says so. P1-07 and P3-04 both pass a wrong build otherwise. |
| R9 | **Never edit `BUILD.md` or `docs/spec.md`.** They change by human decision only. If the plan is wrong, say so in the ledger. |

---

## Part 2 — Decisions, already made

These were open questions. They are now answers. Do not re-open them, do not ask about
them, do not stop for them. Copy this table into `## Decisions` in `LEDGER.md` verbatim.

| id | question | answer |
|---|---|---|
| **D-NODE** | Is a node a service or a deployable? | **One node per deployable.** Group deployables into services with a `GGroup`. A node that maps to three deployments cannot carry one identity, and the grouping is free. |
| **D-STATUS** | What does a binding assert? | **Provenance only.** A binding says which file the node was read out of. It never asserts anything about a running system. |
| **D-SCOPE** | Does anything connect to live infrastructure? | **No.** No collector, no poller, no listener, no status, no network. See Part 6. |

### Stopping conditions

There are no human gates. The loop stops only on failure:

| Condition | Meaning |
|---|---|
| A task fails its verify command three times | recorded `blocked` in the ledger; the loop moves to the next task and continues |
| Three `REJECTED` critic verdicts in six commits | the builder is producing work that does not survive review; stop and leave it for a human |
| Three `no-check` verdicts | the critic has stopped finding anything to test; that is a critic failure, not a clean build |
| P4-03 cannot reach the direction bar in eight tuning rounds | a real quality failure; Phase 5 computes over edge direction and is worthless without it |

Everything else runs through.

---

## Part 3 — Ledger format

`LEDGER.md` is the only file the agents write outside of source and tests.

```markdown
# Ledger

## Decisions
| id | question | answer |
|---|---|---|
| D-NODE | service or deployable? | one node per deployable; group into services |
| D-STATUS | what does a binding assert? | provenance only; never runtime state |
| D-SCOPE | anything live? | no. no collector, poller, listener, status or network |

## Tasks
| id | status | commit | critic |
|---|---|---|---|
| P1-07 | done | a3f9c21 | passed 4c1e88 |
| P1-11 | partial | 9b2d40 | REJECTED 7ea119 — left-travelling sweep untested |
| P1-12 | todo | - | - |

## Findings
(from bootstrap and from critic runs: partial work, code the plan does not cover,
guard violations, anything a human should read)

## Log
- P1-07 (a3f9c21) — two-pass flatten. T8 asserts the 2px boundary claim, passes.
- P1-07 critic (4c1e88) — added T8b, sibling-to-sibling edge inside one group.
  Pins spec §5.3's claim that the edge container is the lowest common ancestor.
```

Statuses: `todo`, `partial`, `in-progress`, `done`, `blocked`.
Critic verdicts: `passed <sha>`, `REJECTED <sha> — <reason>`, `no-check`, or `-`.

Never delete a row. Never delete a log line.

---

## Part 4 — Task list

`small` means up to three per session. `spec` names the sections to re-read.
`verify` must be a command that exits 0, never a judgement call. The verify commands
below assume the layout in spec §2.4 — translate them to this repo's actual paths and
test runner, and record the translation in the ledger.

### Phase 0 — Harness

| id | task | spec | verify |
|---|---|---|---|
| P0-01 | Confirm the harness: both guards run, `npm test` runs, `scripts/run-loop.sh` is executable. `small` | Part 1 | `npm run check && npm test` |
| P0-02 | Resolve any guard violation found at bootstrap. Inserted by bootstrap only if one exists. | R1, R3, spec §1.5 G8 | `npm run check` |

### Phase 1 — Document core, layout, geometry, renderer, agent surface

| id | task | spec | verify |
|---|---|---|---|
| P1-01 | Zod schemas: `graph.ts`, `patch.ts`, `jsonSchema.ts` | §3.1, §3.2 | `npm test -w packages/core` |
| P1-02 | `validate.ts`, V1–V13, **the exact error strings** including the "did you mean" suffixes on V3 and V5 | §3.3 | `npm test -w packages/core` |
| P1-03 | `apply.ts` atomic, `history.ts`, `ids.ts` with the three coercion cases | §3.4, §3.5 | `npm test -w packages/core` |
| P1-04 | `store/`: tmp+rename write, `.lock` with 2s stale timeout, history directory | §2.5 | `npm test -w packages/core` |
| P1-05 | Six fixtures: empty, flat-3, nested-2-deep, cross-boundary, cyclic-groups (must fail), duplicate-id (must fail) | §10 M1 | `npm test -w packages/core` |
| P1-06 | `measure.ts` cached text measurement, `toElk.ts` with per-container options | §5.1, §5.2 | `npm test -w packages/viewer` |
| P1-07 | **Write test T8 first.** Then `fromElk.ts`, the two-pass flattening | §5.3, §6.8 | `npm test -w packages/viewer -- flatten` |
| P1-08 | `worker.ts` with request-id staleness handling | §5.4 | `npm test -w packages/viewer` |
| P1-09 | Debug renderer: grey rects, straight polylines, all six fixtures load | §10 M2 | `npm test -w packages/viewer -- pipeline` |
| P1-10 | `segments.ts`, `crossings.ts`. Tests T1, T5, T6, T7, T9 | §6.1, §6.2 | `npm test -w packages/viewer -- crossings` |
| P1-11 | `hops.ts`, cluster merging and arc insertion. Tests T2, T3, T4. **Both sweep directions.** | §6.3–§6.5 | `npm test -w packages/viewer -- hops` |
| P1-12 | `corners.ts`, `path.ts`. Rounding after hops, with the guard | §6.6 | `npm test -w packages/viewer` |
| P1-13 | Renderer: theme, icons, `GroupRect`, `NodeBox`, `EdgePath`, z-order, label halos, viewport, status bar | §8.1–§8.4 | `npm test -w packages/viewer -- render` |
| P1-14 | `EntityBox`, field rows, crow's-foot markers, `sizeEntity`, `fieldRowWidth` | §3.6, §5.1, §8.5 | `npm test -w packages/viewer -- entitySizing` |
| P1-15 | Hover inspection panel: HTML sibling of the svg, `pointer-events: none`, edge flipping | §3.7, §8.6 | `npm test -w packages/viewer -- views` |
| P1-16 | `serve`: static host, file watch, push on change, invalid-file handling, port fallback | §9 | `npm test -w packages/cli -- serve` |
| P1-17 | MCP server: stdio, seven tools, terse text results, rules embedded in the patch tool description | §4.1 | `npm test -w packages/cli -- mcp` |
| P1-18 | CLI twins for all seven tools, plus `check` and `rules`. Exit 1 with errors on stderr | §4.2 | `npm test -w packages/cli -- Commands` |
| P1-19 | `init`: creates the document directory, gitignore entries, agent config | §4.4, §16.5 | `npm test -w packages/cli -- init` |
| P1-20 | `deriveView` with edge merging and internal-edge dropping. Three presets across all three surfaces | §7 | `npm test -w packages/core -- derive` |
| P1-21 | SVG export from viewer and CLI. PNG at 2× via canvas | §10 M7 | `npm test -w packages/viewer -- svgExport` |

### Phase 2 — Rename

P2-01 (rename Scribe to Topology) was DROPPED by human decision: the spec names the
`diagram_*` tools throughout and R9 forbids editing it, so a rename would leave the spec
and the code permanently disagreeing. The binary stays `diagram` and the document
directory stays `.diagram/`. P2-02 remains, and still belongs before Part 16: plugin
namespacing renames every tool, and rule 11 currently names one literally.

| id | task | spec | verify |
|---|---|---|---|
| P2-02 | Rewrite `rules.md` to describe tools by role rather than by literal name, so plugin namespacing cannot break rule 11 | §16.5, §16.7 | `npm test -w packages/core -- rules` |

### Phase 3 — Test rig

This is what makes Phase 4 measurable. **Two reference systems, not one.** System A is
what the rules get tuned against; system B is held out and is the only score that counts.
Without a hold-out, tuning `rules.md` against a single system produces 98% there and 60%
on real repositories, and nothing in the loop would notice.

| id | task | spec | verify |
|---|---|---|---|
| P3-01 | Reference system A in `fixtures/ref-a/`: docker-compose with web, api-gateway, auth, orders, postgres, redis, kafka, fulfilment-worker. **Never started, only read.** | new | `docker compose -f fixtures/ref-a/docker-compose.yml config` exits 0 |
| P3-02 | Plant two things in A and document them in `fixtures/ref-a/PLANTED.md`: (a) the worker calls auth to validate tokens, visible only by reading the code; (b) a plausible-looking load balancer that does **not** exist, to catch invention. Both test agent rules 8 and 9. | new | `PLANTED.md` describes both |
| P3-03 | Reference system B in `fixtures/ref-b/`: a **different shape** — no compose file, a Terraform directory plus a Go monorepo, six services, one queue, two planted items of its own. B must not resemble A. | new | `PLANTED.md` describes both plants |
| P3-04 | **CRITIC ROLE WRITES THE GOLD FILES.** `fixtures/ref-a/gold.json` and `fixtures/ref-b/gold.json`. Every node and every edge must carry a `file:line` citation in an adjacent `gold-citations.md`. The builder may not write or edit these. | new | every edge in each gold file has a citation that resolves |
| P3-05 | Eval harness `scripts/eval.sh --system a\|b --runs N`: runs an agent against the reference repo with a fixed prompt, scores node set / edge set / **edge direction as its own number** / binding precision against gold, writes `eval-<system>.json` | new | `./scripts/eval.sh --system a --runs 3` produces results |
| P3-06 | Harness runs against a second, non-MCP agent | §1.5 G2 | `./scripts/eval.sh --agent <other> --runs 3` |

### Phase 4 — Rules hardening

Automated, with the hold-out doing the work a human reviewer used to do.

| id | task | spec | verify |
|---|---|---|---|
| P4-01 | Baseline both systems: `./scripts/eval.sh --system a --runs 20` and `--system b --runs 20`. Record every incorrect edge, with its label and both endpoints, in the ledger. Do not edit `rules.md` yet. | §10 M8 | both baselines committed |
| P4-02 | Tuning loop, max **eight** rounds. Each round: read the incorrect edges from A only, make one targeted edit to `rules.md`, re-run A at 20 and B at 20. **Keep the edit only if A improves and B does not regress by more than 2 points.** Otherwise revert it and try a different edit. Log every accepted and reverted edit with both scores. | §10 M8, §18.10 | `scripts/eval.sh` history shows monotonic B |
| P4-03 | Assert on the **held-out** system: `./scripts/eval.sh --system b --runs 20` reports direction ≥ 0.95. If eight rounds did not reach it, stop the run and write why. | §18.10 | direction ≥ 0.95 on system B |

**Why B is the only number that counts.** Everything in Phase 5 computes over edge
direction. A blast radius on a reversed graph is not degraded, it is exactly inverted, and
it arrives ranked and confident. The first real document built under the pre-rewrite rule 4
had eight of seventeen labelled edges pointing the wrong way. Tuning against the system you
are measured on would hide exactly that.

### Phase 5 — Provenance and analysis

Nothing here connects to anything. A **binding** is a recorded reference to a file the
agent actually read — `repo=services/orders/`, `compose=orders-api`,
`terraform=aws_ecs_service.orders`. It is a string in the document and, in the viewer, a
link that opens that file. It is spec §4.1's `### Meta` section made checkable: it turns
agent rule 9, cite what you found, from a hope into something you can grep.

There is no collector, no live status, no dashboard, no network.

| id | task | spec | verify |
|---|---|---|---|
| P5-01 | `GBinding` on `GNode`: schema, V14–V17, `### Bindings` section in the get-table, present only when the document uses it | new; pattern from §3.7, §4.1 | `npm test -w packages/core -- bindings` |
| P5-02 | Agent rule 13, never invent a binding. Add a binding-precision score to the eval harness | new | `./scripts/eval.sh --system b --runs 10` reports binding precision 1.0 |
| P5-03 | Binding chips in the hover panel, each opening the referenced file. `small` | §8.6 | `npm test -w packages/viewer -- bindings` |
| P5-04 | Analysis: the six signals as pure functions in `core/analysis/`, with fixtures | §15.2 | `npm test -w packages/core -- analysis` |
| P5-05 | `diagram analyse` CLI + MCP twin, terse output, A1–A5 enforced | §15.3, §15.4 | `npm test -w packages/cli -- analyse` |
| P5-06 | Viewer analysis view mode | §15.5 | `npm test -w packages/viewer -- analysis-view` |
| P5-07 | `blastRadius` and backlog ranking as pure functions, with fixtures | §18.3, §18.4 | `npm test -w packages/core -- blast` |
| P5-08 | `diagram blast-radius` CLI + MCP twin, C1–C5 enforced | §18.5, §18.7 | `npm test -w packages/cli -- blast` |
| P5-09 | Viewer blast-radius view mode | §18.7 | `npm test -w packages/viewer -- blast-view` |

**P5-09 is the end of the build.** After it, Part 5's acceptance criteria are the
remaining work.

#### New invariants for P5-01

| # | Rule | Error message |
|---|---|---|
| V14 | `source` matches the slug regex and is on the known list | `binding source "Compose" on node "orders": use lowercase, one of repo, compose, terraform, k8s-manifest, package` |
| V15 | No duplicate `source` on one node | `node "orders" has two "compose" bindings: a node maps to one entry per source` |
| V16 | `ref` is a repo-relative path or identifier, never a URL | `binding ref on "orders" must be a repo-relative path, not a URL` |
| V17 | Max 8 bindings per node | `node "orders" has 9 bindings, max 8` |

#### New agent rule for P5-02

> **13. NEVER INVENT A BINDING.** Record a binding only when you have opened the file and
> read the identifier out of it. If you have not seen it, leave it out. An invented
> binding is a citation to a source that does not say what you claim, which is worse than
> no citation at all.

### Phase 6 — The prose benchmark

Phase 3 built a rig that points an agent at a **repository** and scores what it draws. That
measures the harder, adjacent problem. It is not the product.

The product is spec §1.2: you talk, the diagram builds beside you. Codebase reading is one
input to that, and §1.3 presents it as an advantage rather than the core case. **G1 — "a
100-word description produces a correct diagram, no follow-up" — is the headline acceptance
criterion and the only one nothing measures**, because both reference systems are
repositories, not paragraphs.

Dictation is strictly easier than inference: the facts are stated rather than discovered.
So the existing scores are evidence for it, not a substitute. The failures differ.

| id | task | spec | verify |
|---|---|---|---|
| P6-01 | Prose fixtures in `fixtures/prose/`: at least six ~100-word descriptions covering a plain system, an explicit boundary, a stated async path, a stated redundancy, an underspecified one, and one whose obvious reading is wrong | §1.5 G1 | each fixture is one file with the prose and nothing else |
| P6-02 | **A second agent writes each gold independently from the prose alone.** Disagreement between two faithful readings means the prose is ambiguous — that is a finding about the fixture, not the model | §1.5 G1 | every gold validates; disagreements recorded |
| P6-03 | Multi-turn correction fixtures: an initial description, then a correction ("actually those two are replicas", "the worker reads from the queue, not the other way round"). Scores whether the agent emits `updateEdge` rather than redrawing, and whether turn-1 ids survive | §1.5 G3, §18.11 | ids from turn 1 present in the turn-2 document |
| P6-04 | `scripts/eval.sh --prose <name>`, reusing `score.mjs` — node set, edge set, direction, invention — with **one turn** enforced, since G1's claim is "no follow-up" | §1.5 G1 | `--prose` produces the same four numbers |
| P6-05 | An **ambiguity** score: on an underspecified fixture the correct behaviour is to leave the gap or ask, never to fill it. This is G13's analogue for dictation and is the failure a user actually meets | §1.5 G1, rule 8 | an invented element on an underspecified fixture scores as invention |

**Why P6-02 is worth the second agent.** In Phase 3 the reason was that a builder must not
grade its own answer key. Here it is different and better: the prose IS the specification, so
two independent faithful readings should agree. Where they do not, the paragraph is
ambiguous — and an ambiguous fixture measures the reader, not the tool.

**P6-05 is the one to get right.** In a repository the temptation is a plausible component
that is not there; the planted absence catches that. In dictation the temptation is *filling
a gap in what the user said*, and nothing currently measures whether the agent asks, omits,
or quietly invents. That is the failure a user notices first.

---

## Part 5 — Acceptance

The build is done when every line passes.

| # | Goal | Measure |
|---|---|---|
| G1 | Prose to first diagram in one turn | a 100-word description produces a correct diagram, no follow-up |
| G4 | Layout is stable | adding one leaf node moves nothing else by more than 20% of canvas width |
| G5 | Crossings unambiguous | every crossing renders a hop arc, zero flat overlaps |
| G6 | Fast enough to think in | tool call to repainted canvas under 400ms |
| G8 | Zero secrets | `npm run check:no-model-sdk` passes |
| **G9** | Direction is trustworthy | ≥95% correct direction over 20 runs on the **held-out** system B |
| **G10** | Bindings are earned | every binding points at a path that exists; binding precision 1.0 on both systems |
| **G11** | Provenance is complete | every node in both reference runs carries a binding whose chip opens the right file |
| **G12** | Coupling is found by reading | both planted hidden edges appear, in A and in B, having been visible only in the code |
| **G13** | Invention is resisted | neither planted non-existent component appears, across 20 runs on each system |
| **G14** | Analysis states its blind spots | `analyse` reports coverage — how many nodes carry no metadata — on every run |

G12 and G13 are the demo, and they are opposites: find what is really there, refuse what
is not. Both are checkable because the answers were planted.

---

## Part 6 — Out of scope

Do not start these. If a task appears to need one, stop and open a gate.

- **Part 14, the layered canvas.** Bindings replace most of it. "Dive into the node" now
  resolves to another system's view, and that system already built and maintains that
  layer. This also avoids §14.4, the hardest unsolved problem in the spec.
- **Part 17, observed systems and drift.** Nothing is deployed and nothing is connected,
  so there is no running topology to import or diff against. Bindings still record where
  a node came from; they do not resolve against anything live.
- **Any collector, poller, listener or status indicator.** Ground rules R2 and R5. If a
  task appears to need one, the task is wrong.
- **Chaos verification (§18.8).** Prediction is a pure function over the document and
  stays in Phase 5. Verification needs a running system.
- **Mouse editing.** (§1.6)
- **Plugin distribution (Part 16).** After acceptance is green, not before.
