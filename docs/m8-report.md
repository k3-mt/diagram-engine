# M8 — rules hardening: report

Spec Part 10 M8; BUILD.md Phase 4 (P4-01, P4-02, P4-03). One file was tuned —
`packages/core/rules.md`, with its byte-for-byte twin `RULES_MD` in
`packages/core/src/rules/load.ts`. Nothing else was touched: `fixtures/`,
`scripts/eval.sh`, `scripts/eval/`, `docs/spec.md`, `BUILD.md` and every test
are unchanged, and the `compactRules()` size cap of 3000 characters was not
raised (the compacted text went 2980 -> 2987).

**Verdict: M8 passes.** `direction.accuracy` on the held-out system B is
**1.0000** (min 1, max 1, spread 0) over 20/20 scored runs, 0 failed — against
a bar of 0.95. G12 and G13 both pass on **both** systems, which was not true at
baseline. Two of the eight allowed tuning rounds were used.

Read the numbers with the caveat in §5: the gate this milestone is judged on was
already at ceiling before tuning began. The work M8 actually did was to close
G13, which was failing 20 runs out of 20.

---

## 1. Baseline (P4-01)

Commit `da877ab`, rules text as M7 left it, inputs fingerprint
`4202c2d8735b0d18`. 20 runs per system, 4 at a time, each in a fresh temp
workspace under `sandbox-exec` with the answer key withheld.

| metric | system A (tuning) | system B (hold-out) |
|---|---|---|
| node.precision | 0.8889 (spread 0) | 0.9885 (min 0.9231) |
| node.recall | 1.0000 | 0.9885 (min 0.9231) |
| edge.precision | 1.0000 | 1.0000 |
| edge.recall | 1.0000 | 0.9906 (min 0.9375) |
| **direction.accuracy** | **1.0000** (spread 0) | **1.0000** (spread 0) |
| invention.count | **1.00** (min 1, max 1) | 0.15 (min 0, max 1) |
| type.accuracy | 1.0000 | 1.0000 |
| G12 hidden edge: found / right way / cited to source | 20 / 20 / 1 | 20 / 20 / 0 |
| G13 planted absence drawn | **20/20 — FAIL** | 0/20 — pass |

**Incorrect edges at baseline: none, on either system.** Direction was already
perfect and `edge.precision` was 1.0000 on both. The only bad edges anywhere
were the two hanging off an invented node on A (`edge-lb -> web`,
`edge-lb -> api-gateway`), which the scorer counts as unresolvable rather than
reversed.

So the live defect was invention, not direction. Every A run drew `edge-lb`
(label `edge-lb.sparrow.internal`, type `external`) — the component
`fixtures/ref-a/PLANTED.md` plants precisely so that drawing it fails G13.

## 2. Round 1 — rejected as written

**Diagnosis.** Old rule 8 ended `Only what was described or what you actually
found in the codebase.` That clause *licensed* the failure: the agent did find
`edge-lb.sparrow.internal` in the codebase — in `ops/README.md:25`. Naming "a
load balancer, a CDN, or monitoring" as bad examples did not stop it, 20 times
out of 20. Rule 8 named the exact failure and lost to a hostname.

**Edit.** Replace the list of bad examples with a positive test — a box is drawn
only where a file *defines* one (a compose service, a terraform resource, a
manifest, a package) — plus the disproof the README itself states: text saying a
box is another team's or is not deployed here settles it. Rule 9 was compressed
to pay for the characters.

| metric | A base | A r1 | B base | B r1 |
|---|---|---|---|---|
| node.precision | 0.8889 | **1.0000** | 0.9885 | 0.9792 |
| node.recall | 1.0000 | 1.0000 | 0.9885 | **0.8808** |
| edge.recall | 1.0000 | 1.0000 | 0.9906 | **0.9031** |
| direction.accuracy | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| invention.count | 1.00 | **0.00** | 0.15 | 0.25 |
| G13 absence drawn | 20/20 | **0/20** | 0/20 | 0/20 |
| G12 cited to source | 1/20 | **18/20** | 0/20 | 1/20 |

A improved exactly as intended and G13 went clean — but **B lost 10.8 points of
node recall and 8.8 of edge recall**, five times the 2-point tolerance in
P4-02. Cause, read off the runs rather than guessed: the missing nodes are
`fleet-console` (17/20) and `vehicle-units` (14/20) with their edges
`fleet-console -> fleet-api` and `vehicle-units -> ingest-gateway`. Both are
**clients** — an operator's browser UI and the in-vehicle telematics devices.
Neither is a compose service, a terraform resource, a manifest entry or a
package, so the new definition test told the agent to leave them out.

The edit cured invention by outlawing a legitimate kind of node. Rejected. The
diagnosis was carried into round 2; the instrument was not.

## 3. Round 2 — accepted, and final

Same diagnosis, narrower instrument: drop the enumeration of file kinds, keep
the mention-is-not-a-component test, and carve out clients explicitly.

```
8. DO NOT INVENT: A MENTION IS NOT A COMPONENT. A hostname in a
   README or a comment is prose, not a box; text saying a box is
   another team's or is not deployed here settles it — note it on the
   node it fronts, do not draw it. A browser, app or device the
   system serves is still a node, though no file deploys it.

9. IF READING A CODEBASE, cite the file each node and edge came from.
   Do not guess at connections.
```

Fingerprint `e8a97cda64bb3982`, 20 runs per system, 0 failed, confined.

| metric | A base | A r2 | B base | **B r2 (final)** | B delta |
|---|---|---|---|---|---|
| node.precision | 0.8889 | **1.0000** | 0.9885 | 0.9885 (min 0.9231, spread 0.0769) | 0 |
| node.recall | 1.0000 | 1.0000 | 0.9885 | 0.9885 (min 0.9231, spread 0.0769) | 0 |
| edge.precision | 1.0000 | 1.0000 | 1.0000 | 1.0000 (spread 0) | 0 |
| edge.recall | 1.0000 | 1.0000 | 0.9906 | 0.9906 (min 0.9375, spread 0.0625) | 0 |
| **direction.accuracy** | 1.0000 | **1.0000** (spread 0) | 1.0000 | **1.0000 (min 1, max 1, spread 0)** | 0 |
| invention.count | 1.00 | **0.00** (spread 0) | 0.15 | 0.15 (min 0, max 1) | 0 |
| type.accuracy | 1.0000 | 1.0000 | 1.0000 | 1.0000 (spread 0) | 0 |

P4-02's rule is: keep the edit only if A improves and B regresses by no more
than 2 points. A improved (invention 1.00 -> 0.00, node precision +11.1 points,
every A metric now 1.0000 with zero spread) and **B moved by exactly zero on
every metric**. Kept.

The loop stopped at 2 rounds of 8 because there is nothing left on either
system that an edit to the rules can move: no reversed edge, no missing edge on
A, no invented component on either.

## 4. G12 and G13

**G13 — invention is resisted.** *Passes on both systems.*

| | baseline | final |
|---|---|---|
| A: `edge-lb` / ingress / TLS terminator drawn | 20/20 | **0/20** |
| B: the position cache (Redis / ElastiCache) drawn | 0/20 | **0/20** |

This is the milestone's real result. A's failure was deterministic — every run,
same node — and it is now deterministically absent.

B's residual `invention.count` of 0.15 is **not** invention. All three hits are
one node: the agent draws the real component and calls it `in-vehicle-unit(s)`
where gold calls it `vehicle-units`, a spelling the fixture's alias list does not
carry. `score.mjs` predicts this double-charge itself (a correct-but-unusual name
scores as a miss *and* an invention). B's true invented-component count is 0/20.
The fix belongs in `scripts/eval/config.json`, which M8 may not edit.

**G12 — coupling is found by reading.** *Passes on both systems.*

| | baseline | final |
|---|---|---|
| A: `fulfilment-worker -> auth` found / correct direction / cited to source | 20 / 20 / 1 | 20 / 20 / **18** |
| B: `maintenance-forecast -> dispatch` found / correct direction / cited to source | 20 / 20 / 0 | 20 / 20 / **4** |

The gate was already met; what moved is the *evidence* behind it. Rule 9's
citation clause went from ~2% compliance to 18/20 on A and 4/20 on B. Note that
citation is document-level in schema v1 — `GEdge` has no note, meta or binding
field, so per-edge provenance is unmeasurable until `GBinding` lands in P5-01 /
P5-02. The harness reports this as evidence, not as a gate, and so does this
report.

## 5. What this number does and does not certify — and Part 18

`direction.accuracy` was **1.0000 with zero spread on both systems before any
tuning**. `scripts/eval.sh` warned of exactly this in its own header: a
benchmark already at ceiling cannot show whether an edit helped or hurt. Three
consequences, stated plainly:

1. The direction gate carried no gradient during M8. What steered both rounds
   was `invention.count` and the G13 flag on A. Direction was used as a
   *regression guard* — it had to stay at 1.0000 on B, and it did, in both
   rounds — not as an optimisation target.
2. The metric itself is not vacuous. The Phase 4 verification pass scored a
   deliberately reversed document against `gold-a` and got `direction.accuracy`
   0 with all 12 edges listed as reversed, so edge matching is
   orientation-insensitive and direction really is scored separately, as
   designed. The instrument works; this benchmark has no headroom left on it.
3. Direction is scored only over edges present in *both* documents — an edge
   never drawn is never tested for direction. So quote it with recall beside it:
   on B, direction 1.0000 **at** edge recall 0.9906.

**For Part 18 (§18.10 gate 2), the answer is yes, with one qualification.**
Blast radius is computed entirely from edge direction; reverse the arrows and
the prediction is not degraded but exactly inverted, and it arrives ranked and
confident. The gate asks whether the direction convention is trustworthy. Over
40 scored runs across two systems and two different stacks, every matched edge
pointed the right way — including both planted hidden edges, found by reading
source and oriented correctly 40 times out of 40. Gate 2 is met and Part 18's
prediction half is unblocked on this evidence.

The qualification is about *generalisation*, and it belongs in the record.
`eval.sh`'s header says A and B plant the same two kinds of trap — a hard-coded
internal address in a client module, and infrastructure the prose tempts you to
draw that does not exist. B therefore demonstrates that the rules generalise
across stack and topology (docker-compose + JavaScript vs Terraform + Go), and
**not** that they generalise across failure mode. A third reference system
planting a different kind of error — wrong granularity, or a genuinely
bidirectional dependency — is what would turn "direction is 1.0000" into
"direction is trustworthy in the wild". Recommended before Part 18 ships
predictions to anyone.

## 6. Known trade in the accepted text

The old rule 8 opened `Four services described means four services drawn.` That
sentence governs prose-to-diagram (acceptance G1) and the eval never exercises
it — the harness prompt always points at a repository. It was dropped to buy
characters under the 3000-cap, and its work is now carried by the surviving
`DO NOT INVENT` headline plus rule 9. This is the one place where an unmeasured
behaviour paid for a measured one; anyone who sees invention creep back in a
prose-first flow should look here first, and should expect to remove text
elsewhere rather than raise the cap.

`compactRules()` is now 2987 of 3000 characters — 13 characters of headroom. The
next edit to the rules is a substitution, not an addition.

## 7. Provenance

| file | fingerprint | what it is |
|---|---|---|
| `eval-a.json`, `eval-b.json` | `4202c2d8735b0d18` | P4-01 baseline |
| `eval-a-r1.json`, `eval-b-r1.json` | `ff7e73bec5cbd342` | round 1, rejected |
| `eval-a-r2.json`, `eval-b-r2.json` | `e8a97cda64bb3982` | round 2, accepted — the final numbers |

The fingerprint is the harness's sha256 over `scripts/eval/prompt.txt` +
`packages/core/rules.md` + `scripts/eval/config.json`, so each pair is provably
A and B measured against the same rules text. These files are gitignored by
`.gitignore` (`eval-*.json`); the numbers that matter are reproduced in full
here and in `LEDGER.md`, both of which are committed.

Harness note: killing an eval mid-flight leaves
`$TMPDIR/diagram-eval-sandbox.XXXXXX.sb` behind; the next run's `mktemp` then
fails, the sandbox profile path comes out empty, and all 20 runs score as empty
documents. One B round-2 attempt died that way, was discarded, and was re-run
clean. `scripts/eval.sh` is not editable in M8, so this is recorded rather than
fixed.
