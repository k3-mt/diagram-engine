# LEDGER

Mutable build state. Append only; do not rewrite history.

## Phase 4 — Rules hardening (M8)

### P4-01 — baseline, 20 runs each system

Commit `da877ab`. `rules.md` untouched (as M7 left it, inputs fingerprint
`4202c2d8735b0d18`).

| metric | A | B |
|---|---|---|
| node.precision | 0.8889 (spread 0) | 0.9885 (min 0.9231) |
| node.recall | 1.0000 | 0.9885 (min 0.9231) |
| edge.precision | 1.0000 | 1.0000 |
| edge.recall | 1.0000 | 0.9906 (min 0.9375) |
| **direction.accuracy** | **1.0000** (spread 0) | **1.0000** (spread 0) |
| invention.count | **1.00** (min 1, max 1) | 0.15 (min 0, max 1) |
| type.accuracy | 1.0000 | 1.0000 |
| G12 hidden edge found / right way / cited | 20 / 20 / 1 | 20 / 20 / 0 |
| G13 planted absence drawn | **20/20 — FAIL** | 0/20 — pass |

Incorrect edges at baseline: **none on either system.** Direction was already
1.0000 with zero spread; edge.precision 1.0000 on both. The only incorrect
edges recorded anywhere are the two that hang off the invented node on A
(`edge-lb -> web`, `edge-lb -> api-gateway`), which the scorer counts as
unresolvable rather than reversed.

The live defect is therefore **invention, not direction**: every A run draws
`edge-lb` (`edge-lb.sparrow.internal`, type `external`) — the planted absence.
B's residual invention (`in-vehicle-units`, 3/20) is a naming variant of the
real `vehicle-units` node, not a hallucination, and is not a target.

### P4-02 — tuning loop

**Round 1 — ACCEPTED.** One targeted edit: rules 8 and 9 rewritten together.

- Rule 8 was `DO NOT INVENT … Only what was described or what you actually
  found in the codebase.` That last clause *licensed* the failure: the agent
  did find `edge-lb.sparrow.internal` in the codebase — in `ops/README.md:25`.
  Naming "a load balancer, a CDN, or monitoring" as bad examples did not stop
  it, 20 times out of 20.
- Rule 8 now states a positive test instead of a list of bad examples:
  `A MENTION IS NOT A COMPONENT. Draw a box only where a file defines one — a
  compose service, a terraform resource, a manifest, a package. A hostname in a
  README or a comment is prose; text saying a box is another team's or is not
  deployed here settles it. Note it on the node it fronts, do not draw it.`
- Rule 9 was compressed to pay for it (`cite the file each node and edge came
  from. Do not guess at connections.`), keeping `compactRules()` under its
  3000-character cap: **2980 -> 2995**. The cap was not raised.

| metric | A base | A r1 | B base | B r1 |
|---|---|---|---|---|
| node.precision | 0.8889 | **1.0000** | 0.9885 | 0.9792 |
| node.recall | 1.0000 | 1.0000 | 0.9885 | **0.8808** |
| edge.precision | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| edge.recall | 1.0000 | 1.0000 | 0.9906 | **0.9031** |
| direction.accuracy | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| invention.count | 1.00 | **0.00** | 0.15 | 0.25 |
| G13 absence drawn | 20/20 | **0/20** | 0/20 | 0/20 |
| G12 cited to source | 1/20 | **18/20** | 0/20 | 1/20 |

A improved exactly as intended and G13 went clean, but **B regressed 10.8
points on node.recall and 8.8 on edge.recall** — far past the 2-point tolerance
in P4-02. Cause, read off the runs rather than guessed: the missing nodes are
`fleet-console` (17/20) and `vehicle-units` (14/20), with their edges
`fleet-console -> fleet-api` and `vehicle-units -> ingest-gateway`. Both are
*clients* — an operator's browser UI and the in-vehicle telematics devices.
Neither is a compose service, a terraform resource, a manifest entry or a
package, so the new rule's definition test told the agent to leave them out.
The edit fixed invention by outlawing a legitimate node kind.

Verdict: **round 1 rejected as written** — the diagnosis (the licensing clause
"or what you actually found in the codebase") was right, the enumerated
definition test was too narrow. Carried into round 2 rather than reverted whole.

**Round 2 — ACCEPTED.** Same diagnosis, narrower instrument. The enumeration
of file kinds is dropped; what stays is the mention-is-not-a-component test and
an explicit carve-out for clients:

    8. DO NOT INVENT: A MENTION IS NOT A COMPONENT. A hostname in a
       README or a comment is prose, not a box; text saying a box is
       another team's or is not deployed here settles it — note it on the
       node it fronts, do not draw it. A browser, app or device the
       system serves is still a node, though no file deploys it.

`compactRules()` 2987 characters, cap 3000, not raised.


Round 2 measured, both systems, fingerprint `e8a97cda64bb3982`:

| metric | A base | A r2 | B base | B r2 | B delta |
|---|---|---|---|---|---|
| node.precision | 0.8889 | **1.0000** | 0.9885 | 0.9885 | 0 |
| node.recall | 1.0000 | 1.0000 | 0.9885 | 0.9885 | 0 |
| edge.precision | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0 |
| edge.recall | 1.0000 | 1.0000 | 0.9906 | 0.9906 | 0 |
| **direction.accuracy** | 1.0000 | **1.0000** | 1.0000 | **1.0000** | 0 |
| invention.count | 1.00 | **0.00** | 0.15 | 0.15 | 0 |
| type.accuracy | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0 |
| G12 found / direction / cited | 20/20/1 | 20/20/**18** | 20/20/0 | 20/20/**4** | +4 |
| G13 absence drawn | 20/20 | **0/20** | 0/20 | **0/20** | 0 |

Decision rule from P4-02 — keep if A improves and B regresses by no more than
2 points. A improved (invention 1.00 -> 0.00, node.precision +11.1 points) and
B moved by exactly zero on every metric. **Kept.** Both `packages/core/rules.md`
and the `RULES_MD` constant in `packages/core/src/rules/load.ts` carry the
round-2 text; `compactRules()` is 2987 characters against the unchanged
3000-character cap.

Rounds used: 2 of 8. Loop stopped because both acceptance gates it could move
(G13 on A, G9 on B) are satisfied and no incorrect edge remains on either
system. B's residual `invention.count` of 0.15 is 3 runs naming the real
`vehicle-units` node `in-vehicle-unit(s)` — a name the fixture's alias list
does not carry. It is a scoring-config gap, not a hallucination, and
`fixtures/` and `scripts/eval/` are out of bounds for this milestone.

One harness note for whoever runs this next: killing an eval mid-flight leaves
`$TMPDIR/diagram-eval-sandbox.XXXXXX.sb` behind, and the next run's `mktemp`
then fails, the sandbox profile path comes out empty, and all 20 runs score as
empty documents (node.recall 0, every precision `absent`). The first B round-2
attempt died that way and was discarded and re-run; `rm` the stale file first.
No fix was made — `scripts/eval.sh` is not editable in M8.

### P4-03 — assertion on the held-out system

`bash scripts/eval.sh --system b --runs 20 --jobs 4` -> `direction.accuracy`
mean **1.0000**, min 1, max 1, spread 0, over 20/20 scored runs, 0 failed,
confined. **Bar (>= 0.95) met.** See `docs/m8-report.md`.
