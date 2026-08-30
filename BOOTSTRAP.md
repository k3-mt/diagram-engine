# BOOTSTRAP — set up the build loop against this existing repository

This repository already contains a substantial amount of the code. Your job this session
is to survey what exists, reconcile it honestly against the plan, install the build
harness, and write `LEDGER.md`.

**You are not building anything this session.** No features, no fixes, no refactors, no
renames. If you find a bug, write it down and leave it.

---

## Inputs

Read all four before doing anything.

- `docs/spec.md` — the product requirements document
- `BUILD.md` — the protocol, ground rules, decisions, task list, acceptance criteria
- `CRITIC.md` — the adversarial reviewer's instructions
- this file

If any is missing or at a different path, stop and ask.

---

## Constraints for this session

| # | Rule |
|---|---|
| B1 | **Do not modify any existing source file.** Create new files only. You may append to `.gitignore` and to the `scripts` block of the root `package.json`. |
| B2 | **Do not rename anything.** No rename task exists; the binary is `diagram` and the document directory is `.diagram/`. |
| B3 | **Do not delete anything**, including code that looks dead or duplicated. Record it. |
| B4 | **Do not mark a task `done` because the code looks right.** `done` requires that you constructed a verify command, ran it, and saw exit 0, this session. |
| B5 | **Do not fix a guard violation.** It is a finding. Open task P0-02. |
| B6 | If unsure whether something is complete, it is not. Mark it `partial` and say why. |

---

## Step 1 — Survey

Record, do not judge. Everything goes under `## Findings` in the ledger you write later.

1. Package manager, test runner, build tooling, Node version. Read the lockfile — do not
   assume npm.
2. Every workspace or package, and what is in each.
3. Every **runtime** dependency (the `dependencies` field, not `devDependencies`) across
   every `package.json`.
4. Every existing npm script and what it actually runs.
5. Which test files exist, and whether the suite passes right now. Run it. Record the
   result verbatim, including failures.
6. Whether a document directory exists and whether a graph document has been committed.

---

## Step 2 — Install the harness

The files `scripts/check-no-model-sdk.mjs`, `scripts/check-deps.mjs` and
`scripts/run-loop.sh` are supplied with this bootstrap. Confirm they are present, and
that `run-loop.sh` is executable. If any is missing, stop and ask rather than writing
your own.

Then:

**2a. Root scripts.** These are already present in the root `package.json`. Confirm
they run and record the output; do not add duplicates or suffixed variants:

```
"check":              "npm run check:no-model-sdk && npm run check:deps",
"check:no-model-sdk": "node scripts/check-no-model-sdk.mjs",
"check:deps":         "node scripts/check-deps.mjs"
```

If any name is taken, suffix yours and record the conflict.

**2b. The dependency allowlist.** Open `scripts/check-deps.mjs`. Its allowlist is seeded
with the eight packages the spec expects. Add any runtime dependency this repo already
uses that is legitimately needed, and list **every addition** under `## Findings` with one
line each saying what the package is for. That list is a human review item, not a decision
you get to make silently. Do not add anything banned by R1.

**2c. `CLAUDE.md`.** If one exists, append a section; do not replace it. It must say: read
`BUILD.md` first, then restate ground rules R1–R9 compactly.

**2d. `.gitignore`.** Append only what is missing: `logs/`, `.diagram/history/`,
`.diagram/errors.txt`, `out.svg`.

---

## Step 3 — Run the guards

`npm run check`. Record the exact output.

If either fails, **do not fix it.** Add task `P0-02` to the ledger with the violations
listed. A failing `check:no-model-sdk` is an acceptance criterion G8 failure and must
clear before anything else proceeds.

---

## Step 4 — Reconcile the task list

For every task in Part 4 of `BUILD.md`, decide a status. Be strict; this is the part that
matters.

1. Find the code in this repo corresponding to the task, if any.
2. Work out the verify command **for this repo**. The `verify` column assumes the layout
   in spec §2.4 and your paths and test runner may differ. Translate it. Record the
   translation. If you cannot construct a runnable command, the task is `partial` with
   reason "no verify command".
3. Run it.

| Status | Meaning |
|---|---|
| `done` | code exists, verify command exits 0, you ran it this session |
| `partial` | code exists but verify fails, is absent, or covers less than the task asks |
| `todo` | nothing meaningful exists |
| `blocked` | cannot proceed and you have said why in the ledger |

Mark **P3-04 as `todo`** regardless of what exists. The gold files are written by the
critic role, never the builder — an agent grading its own answer key makes every later
score meaningless. If gold files already exist and were not written by the critic,
mark it `partial` and say so.

For every `partial`, write one specific line under `## Findings`. "validate.ts implements
V1–V8; V9–V13 absent; error strings lack the did-you-mean suffix" is useful. "validation
incomplete" is not.

**These four pass casual inspection while being wrong. Check them properly:**

- **P1-07** ELK flattening. Does T8 exist, and does it assert spec §5.3's 2px boundary
  claim, or is it a smoke test? A wrong parent offset does not crash.
- **P1-11** hop arcs. Are **both** sweep directions tested? A one-direction test passes on
  a build where every left-travelling arc dents downward.
- **P1-02** validation. Are the error strings the exact ones in spec §3.3, including the
  "did you mean" suffixes on V3 and V5? Those strings are the agent's self-correction
  contract.
- **P1-14** entity sizing. Does `fieldRowWidth` measure exactly the terms the renderer
  draws, in order? Spec §5.1 records two past bugs there; neither crashed.

---

## Step 5 — Record what the plan does not cover

Under `## Findings`, in a subsection headed "Not in the plan", list anything substantial
in the repo that no task in Part 4 accounts for. For each: path, what it does, and one of
`keep` / `needs a task` / `looks dead`.

This is the other direction of the reconciliation, and it is why a human reads the ledger.

---

## Step 6 — Write `LEDGER.md`

Exactly the format in Part 3 of `BUILD.md`. Every task from Part 4 gets a row, plus P0-02
if you opened it. The `critic` column is `-` throughout. The `commit` column is `-` for
anything not verified against a specific commit.

Copy the decisions table from Part 2 of `BUILD.md` into `## Decisions` verbatim. Those
questions are closed.

Seed `## Log` with one line per task you marked `done`, naming the verify command you ran.

---

## Step 7 — Commit and report

```
git checkout -b build
git add -A
git commit -m "bootstrap: audit, harness, ledger"
```

Nothing outside the files this document told you to create should appear in that diff. If
something else did, say so.

Then report in plain text, at most fifteen lines:

1. Counts by status: done / partial / todo / blocked.
2. The first three tasks the loop will pick up, in order.
3. Guard results: pass or fail, with the violation count.
4. Allowlist additions you made.
5. The single thing you are least confident about in this audit.

Then stop. Do not begin task work.
