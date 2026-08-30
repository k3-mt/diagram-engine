#!/usr/bin/env bash
# scripts/eval.sh — the M8 measurement rig (BUILD.md P3-05 / P3-06, spec Part 10 M8).
#
#   bash scripts/eval.sh --system a                  3 runs, claude -p, eval-a.json
#   bash scripts/eval.sh --system b --runs 20 --jobs 4
#   bash scripts/eval.sh --system a --agent "codex exec"     P3-06 / acceptance G2
#   bash scripts/eval.sh --system a --score-only <doc.json>  score a saved document, no agent
#   bash scripts/eval.sh --system a --score-only <doc.json> --bindings-root <dir>
#   bash scripts/eval.sh --system a --keep                   keep the temp workspaces
#   bash scripts/eval.sh --system a --force                  overwrite an existing eval-a.json
#
# M8 tunes packages/core/rules.md — which in this architecture IS the prompt —
# until an agent reliably produces a TRUTHFUL diagram from a codebase. That is
# unmeasurable without a scored benchmark, so this is the benchmark. It scores
# four numbers per run against fixtures/ref-<system>/gold.json:
#
#   node set   precision + recall of node identity, matched on meaning
#   edge set   precision + recall, direction IGNORED
#   direction  of the edges correctly identified, the fraction pointing the
#              right way — ITS OWN NUMBER (acceptance G9, bar 0.95 on system B)
#   invention  components drawn that are in no gold and are not a documented
#              accepted variant (acceptance G13)
#
#   bindings   precision (of the citations produced, how many RESOLVE against
#              the staged system — acceptance G10, bar 1.0) and coverage (how
#              many produced nodes and edges carry any citation — G11). Two
#              numbers on purpose: precision is honesty, coverage is effort.
#
# plus, per run, whether the planted hidden edge was found (acceptance G12) and
# whether it is cited by a binding that resolves (rules 9 and 15).
#
# -----------------------------------------------------------------------------
# THE ONE PROPERTY THIS SCRIPT EXISTS TO PROTECT: no gold reaches the agent.
# -----------------------------------------------------------------------------
# The answer key lives inside the reference system — fixtures/ref-a/gold.json,
# gold-citations.md and PLANTED.md sit beside docker-compose.yml. So the agent
# is never pointed at the repository:
#
#   1. Each run gets a fresh mktemp -d workspace. The repository is never the
#      agent's cwd, and the repo's own .diagram/ is never touched.
#   2. The reference system is COPIED into that workspace by scripts/eval/stage.mjs,
#      which withholds every answer-key file, then AUDITS the copy in a second,
#      independent pass and aborts if anything on the denylist, any leak marker,
#      or any symlink survives. The audit runs again over the whole workspace
#      after `diagram init`, immediately before the agent is launched.
#   3. The prompt is a fixed constant (scripts/eval/prompt.txt) with one
#      substitution: the staged path. Identical for every run and both systems,
#      because the prompt is a variable we are not measuring.
#   4. The agent process is given no gold path in argv and no gold path in the
#      environment. Scoring happens in THIS script, after the agent has exited.
#   5. The agent runs inside an OS SANDBOX (`sandbox-exec`, macOS) that denies
#      reads of this repository outright, re-allowing only node_modules and the
#      built CLI the MCP server needs. This is the load-bearing mechanism and
#      it is stated correctly here because the previous wording was wrong:
#      `--allowedTools` is a PRE-APPROVAL list, not a sandbox. It removes the
#      permission prompt; it does not stop the Read tool taking an absolute
#      path, and Glob alone finds an answer key by name without being told
#      where the repository is. That was demonstrated live against this rig.
#      The tool flags are still passed — `--disallowedTools` now denies Bash,
#      WebFetch, WebSearch and Task explicitly rather than relying on their
#      absence from the allowlist — but they are defence in depth behind the
#      sandbox, not the guarantee.
#   6. The same sandbox denies the operator's ~/.claude, so the eval agent does
#      not inherit a machine-level CLAUDE.md, user skills or user permission
#      rules. The prompt is meant to be a constant; without this it silently
#      included whatever the operator happened to have written in a personal
#      file, and the milestone's numbers would not reproduce across machines.
#   7. A --agent command supplied by the operator is run inside the same
#      sandbox, but everything else about it is outside this guarantee and the
#      script says so, loudly, when one is passed.
#
# Without a sandbox the script REFUSES to run an agent. `--unconfined` overrides
# that; it prints a warning, and it stamps confined:false into the output so a
# contaminated number can never be mistaken for a clean one.
#
# Runs execute concurrently up to --jobs at a time (default 4). Twenty
# simultaneous agents, each with its own MCP server, is how a laptop produces
# timeouts, and a timed-out run scores as an empty document.
#
# -----------------------------------------------------------------------------
# WHAT THIS RIG DOES NOT MEASURE — read this next to any score it produces.
# -----------------------------------------------------------------------------
#   * WHETHER A CITATION SAYS WHAT THE DOCUMENT CLAIMS. Binding precision (new
#     in P5-02) proves a cited file EXISTS and is long enough for the line
#     cited. It cannot prove the file says what the node or edge claims — that
#     needs a reader. So precision is a floor on honesty, not a ceiling: an
#     agent that cites a real file at random scores 1.0. What it does catch is
#     the invented path, which is the failure mode measured at 2/20 before
#     bindings existed.
#   * GENERALISATION ACROSS FAILURE KIND. A and B are genuinely different
#     systems — different language, different infrastructure statement,
#     different topology, no shared node name — so B tests generalisation across
#     stack and shape. It does not test generalisation across PLANT KIND: both
#     systems' plant 1 is "a hard-coded internal address held in a client
#     module, absent from the deployment manifest", and both systems' plant 2 is
#     "infrastructure the prose tempts you to draw that does not exist". A
#     rules.md tuned on A's two lessons transfers to B by construction. Read B's
#     score as "generalises across stack and topology", never as "generalises
#     across failure mode". A third system, if one is ever built, should plant
#     something of a different kind: a component drawn at the wrong granularity,
#     or a genuinely bidirectional dependency.
#   * WHETHER B HAS HEADROOM. B came back 7/7 perfect on its first real run with
#     untuned rules. n=1 may be luck, but a benchmark already at ceiling cannot
#     show whether an edit to rules.md helped or hurt. Run B ten to twenty times
#     and look at the spread BEFORE treating its number as something to tune
#     against.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEM=""
RUNS=3
JOBS=4
AGENT=""
OUT=""
KEEP=0
FORCE=0
UNCONFINED=0
SCORE_ONLY=""
# Only for --score-only: a normal run resolves citations against its own staged
# copy and needs no flag.
BINDINGS_ROOT=""
BINDINGS_ALT_ROOT=""
TIMEOUT_S=900

usage() { sed -n '2,10p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --system)     SYSTEM="${2:-}"; shift 2 ;;
    --runs)       RUNS="${2:-}"; shift 2 ;;
    --jobs)       JOBS="${2:-}"; shift 2 ;;
    --agent)      AGENT="${2:-}"; shift 2 ;;
    --out)        OUT="${2:-}"; shift 2 ;;
    --score-only) SCORE_ONLY="${2:-}"; shift 2 ;;
    --bindings-root) BINDINGS_ROOT="${2:-}"; shift 2 ;;
    --bindings-alt-root) BINDINGS_ALT_ROOT="${2:-}"; shift 2 ;;
    --timeout)    TIMEOUT_S="${2:-}"; shift 2 ;;
    --keep)       KEEP=1; shift ;;
    --force)      FORCE=1; shift ;;
    --unconfined) UNCONFINED=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "eval.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# --- preflight: fail loudly, and say exactly what is wrong -------------------
case "$SYSTEM" in
  a|b) ;;
  "")  echo "eval.sh: --system is required (a or b)" >&2; exit 2 ;;
  *)   echo "eval.sh: --system must be 'a' or 'b', got '$SYSTEM'" >&2; exit 2 ;;
esac
case "$RUNS" in
  ''|*[!0-9]*) echo "eval.sh: --runs must be a positive integer, got '$RUNS'" >&2; exit 2 ;;
  0)           echo "eval.sh: --runs must be at least 1" >&2; exit 2 ;;
esac
case "$JOBS" in
  ''|*[!0-9]*) echo "eval.sh: --jobs must be a positive integer, got '$JOBS'" >&2; exit 2 ;;
  0)           echo "eval.sh: --jobs must be at least 1" >&2; exit 2 ;;
esac
# The concurrency cap is `wait -n`, which arrived in bash 4.3. macOS ships 3.2
# as /bin/bash. Silently ignoring the cap would put us back where we started —
# 20 agents at once, timeouts, and a mean built out of the runs that survived —
# so say so instead.
if [ "$RUNS" -gt "$JOBS" ] && { [ "${BASH_VERSINFO[0]}" -lt 4 ] || \
     { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 3 ]; }; }; then
  echo "eval.sh: bash $BASH_VERSION has no 'wait -n', so --jobs $JOBS cannot cap $RUNS runs." >&2
  echo "         Run under bash >= 4.3 (brew install bash), or pass --jobs $RUNS and accept" >&2
  echo "         that every run starts at once." >&2
  exit 1
fi

REF="$REPO/fixtures/ref-$SYSTEM"
GOLD="$REF/gold.json"
CLI="$REPO/packages/cli/dist/bin/diagram.js"
[ -d "$REF" ]  || { echo "eval.sh: no reference system at $REF (BUILD.md P3-01/P3-03)" >&2; exit 1; }
[ -f "$GOLD" ] || { echo "eval.sh: no gold file at $GOLD — the critic writes it (BUILD.md P3-04)" >&2; exit 1; }
[ -f "$CLI" ]  || { echo "eval.sh: CLI not built: $CLI is missing. Run 'npm run build' first." >&2; exit 1; }
for f in "$REPO/scripts/eval/stage.mjs" "$REPO/scripts/eval/score.mjs" \
         "$REPO/scripts/eval/aggregate.mjs" "$REPO/scripts/eval/prompt.txt" \
         "$REPO/scripts/eval/config.json"; do
  [ -f "$f" ] || { echo "eval.sh: missing harness file $f" >&2; exit 1; }
done
command -v node >/dev/null || { echo "eval.sh: node is not on PATH" >&2; exit 1; }

# --- never silently destroy an expensive result ------------------------------
# `--score-only` is the cheap command someone runs over and over while
# debugging the scorer; the agent run is the expensive one. They used to write
# to the same default path, so debugging the scorer ate the run. Now:
#   * --score-only writes to STDOUT unless --out names a file;
#   * any mode refuses to overwrite an existing eval-<system>.json without
#     --force, and says when the existing one was generated.
refuse_clobber() {
  local target="$1"
  [ -e "$target" ] || return 0
  [ "$FORCE" -eq 1 ] && return 0
  local when
  when="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).generated??"unknown"))}catch{process.stdout.write("unparseable")}' "$target")"
  echo "eval.sh: $target already exists (generated: $when)." >&2
  echo "         Refusing to overwrite the record of a previous run. Pass --force to replace it," >&2
  echo "         or --out <path> to write somewhere else." >&2
  exit 1
}

# --- scoring only: no agent, no temp project --------------------------------
# The scorer stays testable, and a saved document stays re-scorable, when no
# agent can run in this environment.
if [ -n "$SCORE_ONLY" ]; then
  [ -f "$SCORE_ONLY" ] || { echo "eval.sh: --score-only: no such file: $SCORE_ONLY" >&2; exit 1; }
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/diagram-eval-score.XXXXXX")"
  BR_ARGS=()
  [ -n "$BINDINGS_ROOT" ] && BR_ARGS=(--bindings-root "$BINDINGS_ROOT")
  [ -n "$BINDINGS_ALT_ROOT" ] && BR_ARGS+=(--bindings-alt-root "$BINDINGS_ALT_ROOT")
  node "$REPO/scripts/eval/score.mjs" --doc "$SCORE_ONLY" --gold "$GOLD" \
       --system "$SYSTEM" --run 1 "${BR_ARGS[@]+"${BR_ARGS[@]}"}" > "$WORK/run-1.json" || {
    echo "eval.sh: scoring failed" >&2; rm -rf "$WORK"; exit 1; }
  if [ -z "$OUT" ]; then
    # No file is touched at all unless the operator names one.
    node "$REPO/scripts/eval/aggregate.mjs" --system "$SYSTEM" --out "$WORK/agg.json" \
         --attempted 1 --provenance '{"agent":"none (--score-only)","confined":null}' \
         "$WORK/run-1.json" >/dev/null
    cat "$WORK/agg.json"
    rm -rf "$WORK"
    exit 0
  fi
  refuse_clobber "$OUT"
  node "$REPO/scripts/eval/aggregate.mjs" --system "$SYSTEM" --out "$OUT" \
       --attempted 1 --provenance '{"agent":"none (--score-only)","confined":null}' \
       "$WORK/run-1.json"
  rm -rf "$WORK"
  echo "wrote $OUT (scored 1 saved document, no agent)"
  exit 0
fi

[ -z "$OUT" ] && OUT="$REPO/eval-$SYSTEM.json"
refuse_clobber "$OUT"

# --- confinement --------------------------------------------------------------
# The guarantee, enforced by the OS rather than asserted in a comment.
# BSD mktemp only substitutes Xs at the END of the template: with a ".sb"
# suffix it takes "XXXXXX.sb" literally, and then FAILS with "File exists" on
# every later run once that literal file is on disk — which is what any killed
# run leaves behind. An empty SANDBOX_PROFILE then becomes `sandbox-exec -f ""`,
# the agent never starts, and the run scores as an empty document. Create the
# temp file with the Xs last, then rename.
SANDBOX_PROFILE="$(mktemp "${TMPDIR:-/tmp}/diagram-eval-sandbox.XXXXXX")" || {
  echo "eval.sh: could not create a sandbox profile file" >&2; exit 1; }
mv "$SANDBOX_PROFILE" "$SANDBOX_PROFILE.sb" && SANDBOX_PROFILE="$SANDBOX_PROFILE.sb"
CONFINED=0
if [ "$UNCONFINED" -eq 1 ]; then
  echo "!! --unconfined: the agent can read this repository, including"
  echo "!!   fixtures/ref-$SYSTEM/PLANTED.md and gold.json. Any number produced by this"
  echo "!!   run is contaminated-until-proven-clean and is stamped confined:false."
elif [ "$(uname -s)" = "Darwin" ] && command -v sandbox-exec >/dev/null; then
  # Deny the whole repository, then re-allow only what the CLI and its MCP
  # server actually open. Later rules win in SBPL, so the order matters.
  # Everything the answer key is written in — fixtures/, scripts/eval/,
  # BUILD.md, docs/, packages/*/tests/ — stays denied.
  # `file-read-data`, not `file-read*`: data covers reading a file's contents AND
  # listing a directory, which is everything the answer key could be reached
  # through. Metadata (stat) stays allowed because node resolves its own
  # argv[0] by lstat-ing the path it was invoked through, and denying that
  # stops the CLI before it starts. The residue is that a process can learn
  # whether a path it already guessed exists; it can read nothing and list
  # nothing.
  cat > "$SANDBOX_PROFILE" <<SBPL
(version 1)
(allow default)
(deny file-read-data (subpath "$REPO"))
(allow file-read-data
  (subpath "$REPO/node_modules")
  (subpath "$REPO/packages/cli/dist")
  (subpath "$REPO/packages/cli/node_modules")
  (subpath "$REPO/packages/core/node_modules")
  (subpath "$REPO/packages/viewer/node_modules")
  (literal "$REPO/package.json")
  (literal "$REPO/packages/cli/package.json")
  (literal "$REPO/packages/core/package.json"))
(deny file-read-data (subpath "$HOME/.claude") (literal "$HOME/.claude.json"))
SBPL
  CONFINED=1
else
  echo "eval.sh: no filesystem sandbox available on $(uname -s)." >&2
  echo "         This rig's numbers only mean anything if the agent cannot read the answer" >&2
  echo "         key, and a tool allowlist does not stop it: --allowedTools is a permission" >&2
  echo "         pre-approval, not a jail. Read/Grep/Glob take absolute paths." >&2
  echo "         Run this on macOS (sandbox-exec), or pass --unconfined and accept that the" >&2
  echo "         result is uncontaminated only by the agent's incuriosity." >&2
  rm -f "$SANDBOX_PROFILE"
  exit 1
fi

# --- the agent ---------------------------------------------------------------
DEFAULT_AGENT_BIN="claude"
if [ -z "$AGENT" ]; then
  command -v "$DEFAULT_AGENT_BIN" >/dev/null || {
    echo "eval.sh: '$DEFAULT_AGENT_BIN' is not on PATH." >&2
    echo "         Pass a different agent with --agent, or score a saved document with --score-only <doc.json>." >&2
    exit 1; }
  AGENT_DESC="claude -p (allow Read,Grep,Glob,mcp__diagram; deny Bash,WebFetch,WebSearch,Task)"
else
  echo "!! --agent given: '$AGENT'"
  echo "!! It runs inside the same sandbox, so it still cannot read this repository."
  echo "!! Everything else about it — its own tools, its own config, its own network"
  echo "!! use — is your responsibility, not this script's."
  AGENT_DESC="$AGENT"
fi

PROMPT_TEMPLATE="$(cat "$REPO/scripts/eval/prompt.txt")"
# The two inputs that are not the reference system. If either changes, the
# numbers are not comparable with an earlier run, so both are fingerprinted.
FINGERPRINT="$(cat "$REPO/scripts/eval/prompt.txt" "$REPO/packages/core/rules.md" "$REPO/scripts/eval/config.json" | shasum -a 256 | cut -c1-16)"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/diagram-eval-$SYSTEM.XXXXXX")"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
echo "eval: system $SYSTEM, $RUNS run(s), $JOBS at a time, workspaces under $ROOT"
echo "      confined: $([ "$CONFINED" -eq 1 ] && echo "yes (sandbox-exec)" || echo "NO (--unconfined)")   fingerprint: $FINGERPRINT"

# one_run <n> — everything for one independent run, in its own directory.
# The body is a SUBSHELL, not a brace group: a `return` inside a redirected
# brace group returns from the function, so the status line below it was dead
# code on exactly the failure paths an operator needs to see. A run that fails
# now always prints one line naming its log.
one_run() {
  local n="$1"
  local run="$ROOT/run-$n"
  local ws="$run/workspace"
  local log="$LOGS/run-$n.log"
  mkdir -p "$ws" "$run/bin"

  (
    set -uo pipefail
    echo "=== run $n — system $SYSTEM ==="
    echo "workspace: $ws"

    # 1. stage the reference system with the answer key withheld, then audit.
    node "$REPO/scripts/eval/stage.mjs" "$REF" "$ws/system" || exit 1

    # 2. a fresh project. --root, not the repo: the repo's .diagram/ is never touched.
    node "$CLI" init --root "$ws" || exit 1

    # 3. `diagram` on PATH for the MCP server, via a shim OUTSIDE the workspace
    #    so it is not one of the files the agent can read.
    printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$CLI" > "$run/bin/diagram"
    chmod +x "$run/bin/diagram"

    # 4. re-audit the WHOLE workspace, now that init has written into it. This
    #    is the last gate before the agent starts.
    node "$REPO/scripts/eval/stage.mjs" --audit "$ws" || exit 1

    # 5. the fixed prompt, one substitution.
    local prompt="${PROMPT_TEMPLATE//\{\{SYSTEM_DIR\}\}/./system}"
    echo "  prompt: $prompt"

    # 6. run the agent, cwd = the workspace, inside the sandbox, with a scrubbed
    #    environment: no variable naming the repository, the fixtures or the
    #    gold file is set, and no variable inherited from an outer Claude Code
    #    session either. A hung agent must not hang the harness: the agent runs
    #    in the background with a watchdog, and a killed run is still scored —
    #    an empty document is a real result, not a crash.
    local rc=0
    (
      cd "$ws" || exit 1
      export PATH="$run/bin:$PATH"
      unset DIAGRAM_DIR
      unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID \
            CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SSE_PORT \
            CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN \
            CLAUDE_CODE_BRIDGE_SESSION_ID CLAUDE_PID CLAUDE_EFFORT AI_AGENT
      if [ "$CONFINED" -eq 1 ]; then
        # An empty or missing profile here would become `sandbox-exec -f ""`,
        # which fails to exec and scores as "the agent drew nothing". Refuse.
        if [ -z "$SANDBOX_PROFILE" ] || [ ! -s "$SANDBOX_PROFILE" ]; then
          echo "  sandbox profile missing or empty — refusing to run unconfined" >&2
          exit 70
        fi
        set -- sandbox-exec -f "$SANDBOX_PROFILE"
      else
        set --
      fi
      if [ -n "$AGENT" ]; then
        # shellcheck disable=SC2086
        printf '%s' "$prompt" | "$@" $AGENT &
      else
        "$@" "$DEFAULT_AGENT_BIN" -p "$prompt" \
          --allowedTools "Read,Grep,Glob,mcp__diagram" \
          --disallowedTools "Bash,WebFetch,WebSearch,Task" \
          --permission-mode acceptEdits &
      fi
      apid=$!
      ( sleep "$TIMEOUT_S"; kill -TERM "$apid" 2>/dev/null && echo "  !! agent killed after ${TIMEOUT_S}s" ) &
      wpid=$!
      wait "$apid"; arc=$?
      kill "$wpid" 2>/dev/null
      exit "$arc"
    ) < /dev/null 2>&1 || rc=$?
    echo "  agent exit: $rc"

    # 7. the produced document. `export json` refuses to write an empty
    #    diagram, but an agent that drew nothing is a run that scored zero, not
    #    a crash — dropping it would quietly delete the worst results from the
    #    mean, which is the one direction of bias a rig must not have. So the
    #    empty document is written by hand and scored like any other.
    #
    #    THE EXCEPTION, and it is the opposite bias: if the agent process
    #    itself failed AND produced nothing, the model never answered. Scoring
    #    that as an empty document converts an infrastructure failure into a
    #    measured zero — which is exactly what a broken sandbox profile did,
    #    reporting node.recall 0 across twenty runs of the held-out system and
    #    reading as a total collapse of the score. Such a run is FAILED: it
    #    leaves the means alone and is counted in runsFailed, which the
    #    aggregator already flags against the attempted count.
    #
    #    A non-zero exit WITH a document is still scored. An agent that hit a
    #    turn limit after drawing a good diagram did real work, and discarding
    #    it would be the first bias again, wearing the other hat.
    if ! node "$CLI" export json --dir "$ws/.diagram" --out "$run/produced.json"; then
      if [ "$rc" -ne 0 ]; then
        echo "  agent exited $rc and produced no diagram — FAILED, not scored as zero" >&2
        exit 71
      fi
      echo "  no diagram was produced — scoring an empty document"
      printf '{"schemaVersion":1,"title":"Untitled","direction":"RIGHT","nodes":[],"groups":[],"edges":[],"collapsed":[]}\n' \
        > "$run/produced.json"
    fi

    # 8. score. Gold is read HERE, in the harness, after the agent has exited.
    #    --bindings-root is the STAGED COPY, $ws/system: the tree the agent was
    #    actually pointed at. Never $REF — the fixture holds the answer key and
    #    the agent has never seen it, so citations resolved against it would be
    #    scored against files that were not there to read. The workspace still
    #    exists at this point; it is removed after every run has been scored.
    #
    #    --bindings-alt-root is $ws, the agent's cwd, because "repo-relative"
    #    has two honest readings here: the prompt says `./system`, so an agent
    #    may write `web/nginx.conf` or `system/web/nginx.conf` and both name
    #    the same real file it read. The first smoke run wrote the second
    #    spelling for all 25 of its citations; scoring against the system
    #    directory alone reported precision 0.0 for perfect provenance. Both
    #    roots are inside this run's own temp tree, so nothing the agent could
    #    not read becomes resolvable. See score.mjs, TWO ROOTS.
    node "$REPO/scripts/eval/score.mjs" --doc "$run/produced.json" --gold "$GOLD" \
         --system "$SYSTEM" --run "$n" --bindings-root "$ws/system" \
         --bindings-alt-root "$ws" > "$run/score.json" || exit 1
    echo "  scored -> $run/score.json"
  ) > "$log" 2>&1
  local status=$?
  echo "run $n: $([ $status -eq 0 ] && echo ok || echo FAILED) — log: $log"
  return $status
}

# --- run them, at most --jobs at a time, one log each -------------------------
running=0
pids=()
for n in $(seq 1 "$RUNS"); do
  one_run "$n" &
  pids+=($!)
  running=$((running + 1))
  if [ "$running" -ge "$JOBS" ]; then
    wait -n 2>/dev/null || true
    running=$((running - 1))
  fi
done
failed=0
for p in "${pids[@]}"; do wait "$p" || failed=$((failed + 1)); done

SCORES=()
for n in $(seq 1 "$RUNS"); do
  [ -f "$ROOT/run-$n/score.json" ] && SCORES+=("$ROOT/run-$n/score.json")
done
if [ "${#SCORES[@]}" -eq 0 ]; then
  echo "eval.sh: no run produced a score. Logs are in $LOGS (kept)." >&2
  exit 1
fi

PROVENANCE="$(node -e '
const [agent, confined, fp, host] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  _what: "what was measured, so two operators can tell whether they measured the same thing",
  agent,
  confined: confined === "1",
  confinement: confined === "1" ? "sandbox-exec: this repository denied except node_modules and the built CLI; ~/.claude denied" : "NONE (--unconfined): the agent could read the answer key",
  inputsFingerprint: fp,
  inputsFingerprintOver: ["scripts/eval/prompt.txt", "packages/core/rules.md", "scripts/eval/config.json"],
  host,
}));' "$AGENT_DESC" "$CONFINED" "$FINGERPRINT" "$(uname -s)")"

node "$REPO/scripts/eval/aggregate.mjs" --system "$SYSTEM" --out "$OUT" \
     --attempted "$RUNS" --provenance "$PROVENANCE" "${SCORES[@]}" || exit 1
echo
echo "wrote $OUT — ${#SCORES[@]}/$RUNS run(s) scored, $failed failed"

rm -f "$SANDBOX_PROFILE"
if [ "$KEEP" -eq 1 ]; then
  echo "workspaces kept: $ROOT"
else
  cp -R "$LOGS" "${OUT%.json}-logs" 2>/dev/null
  rm -rf "$ROOT"
  echo "logs: ${OUT%.json}-logs"
fi
exit 0
