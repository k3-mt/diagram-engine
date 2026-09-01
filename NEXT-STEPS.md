# NEXT-STEPS — pick this up later

Written mid-task, at the point work was paused. Everything below is either
**unfinished** or **unverified**. Nothing here is committed.

**Branch:** `distribution-plugin` (pushed, tracking `origin/distribution-plugin`)
**Last commit:** `57589cb` — *Part 16: ship the engine as a Claude Code plugin, at 0.1.0*

---

## Working tree state right now

```
 M README.md                              # adds a pointer to AGENTS.md
 M scripts/eval/stage.mjs                 # repoName() bug fix — see A below
 M packages/cli/tests/eval-harness.test.ts# its test
?? AGENTS.md                              # new, the agent build guide
?? NEXT-STEPS.md                          # this file
```

Do not lose the `stage.mjs` fix — it is a real bug fix, not documentation.

---

## A. The `repoName()` fix (done, needs committing)

`scripts/eval/stage.mjs` derived its "leak marker" from the **basename of the
checkout directory** and matched it as a plain substring. So the test suite's
result depended on what you named your clone: cloning into `~/fresh` failed ten
tests, because `fixtures/ref-a/.../auth-client.js` contains the word "refresh",
and "refresh" contains "fresh".

Fixed by deriving the marker from `package.json`'s `name` — the repository's actual
identity, identical on every machine — falling back to the directory name only if
the manifest cannot be read.

**Verified:** all 1357 tests pass in a clone at `.../fresh` that previously failed
ten. This was found by cloning the pushed branch fresh and running the documented
build; it does not reproduce in the normal `diagram-engine` directory.

---

## B. AGENTS.md — finish the review loop

`AGENTS.md` is a build-and-install guide written for an agent to ingest: exact
commands, expected output, verification steps, and a traps section.

It has been through **two** adversarial review passes (a fresh agent given only the
file, asked to find what would block someone following it literally). Round-one and
round-two fixes are already applied. Remaining work:

1. ~~Verify the CLI-only seed snippet in §6 actually runs.~~ **Done.** Run exactly
   as printed in a clean directory: `ok — +4 nodes, +3 edges`, then
   `diagram check` → `ok — 4 nodes, 0 groups, 3 edges`, matching what the guide
   claims.

2. **Run a third audit pass** the same way, and fix anything that survives:
   ```bash
   mkdir -p /tmp/audit3 && cp AGENTS.md /tmp/audit3/ && cd /tmp/audit3
   claude -p "Read AGENTS.md — a build guide for a repo you have NOT cloned. List ONLY remaining concrete problems that would block or mislead an agent following it literally. Be terse. If sound, say so plainly."
   ```

3. **Full verification before committing:**
   ```bash
   npm test && npm run typecheck && npm run check && npm run verify:plugin
   ```

4. **Commit** `AGENTS.md`, `README.md`, `scripts/eval/stage.mjs` and its test. The
   stage.mjs change is a bug fix and deserves saying so in the message, separately
   from the documentation.

---

## C. Outstanding from the distribution work

**The install command does not work yet for anyone else.**
`claude plugin marketplace add k3-mt/diagram-engine` resolves the repository's
**default branch**, which is still `master`. Until `distribution-plugin` is merged,
that command finds no marketplace manifest. Either merge it, or tell early testers
to use the local-path form.

**No release tag.** §16.7's pinning story wants one on the release commit:
```bash
claude plugin tag .                    # cuts diagram--v0.1.0, validates the manifests agree
git tag --list 'diagram--v*'
```

**The release commit is not split.** §16.8 asks for `plugin/` (12.9 MB of bundle) in
its own clearly-labelled commit, so the source diff stays reviewable. It went in
with everything else because a single commit was requested. To split later:
`git reset --soft HEAD~1`, then stage `plugin/` + `plugin.sha256` separately.

**The plugin is installed on this machine, user-scope, pointing at the local repo**
— not at GitHub. To test the real fetch path, remove it first:
```bash
claude plugin uninstall diagram
claude plugin marketplace remove diagram-engine
```

**`master` is untouched.** PR: https://github.com/k3-mt/diagram-engine/pull/new/distribution-plugin

---

## D. Known, deliberately not done

- The prose benchmark (BUILD.md Phase 6). Both reference systems are repositories,
  so acceptance G1 — "a 100-word description produces a correct diagram, no
  follow-up" — is still measured by nothing.
- Binding chips in the viewer's hover panel.
- The rule 1 rewrite ("CALL diagram_get FIRST" → "READ THE DIAGRAM FIRST") has
  **not** been re-benchmarked. It is one character shorter and role-based rather
  than naming a tool, so the compact-rules budget absorbed it — but `rules.md` is
  the prompt, and `scripts/eval.sh` is what would prove the change harmless. Worth
  a run against both reference systems before tagging a release anyone depends on.
