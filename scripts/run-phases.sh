#!/usr/bin/env bash
# Phase-parallel build driver.
#
#   bash scripts/run-phases.sh                    2 builders at a time, 60 rounds
#   bash scripts/run-phases.sh -j 4 --rounds 40
#   bash scripts/run-phases.sh --unattended       no prompts; only sane in a container
#   bash scripts/run-phases.sh --stub             plumbing test, spawns no agents
#
# WHY BASH AND NOT THE WORKFLOW TOOL
# ----------------------------------
# The Workflow tool needs interactive approval; a headless `claude -p` run with
# --permission-mode acceptEdits comes back with "Review dynamic workflow before
# running" and does nothing. Whether --dangerously-skip-permissions lifts that
# was never verified, and an unattended overnight run is the wrong place to find
# out. So the fan-out lives here, where the control flow is deterministic and
# testable with --stub.
#
# THE PARALLELISM RULE
# --------------------
# Tasks within one phase of BUILD.md are independent; phases are not. So this
# runs up to -j builders concurrently inside a phase, waits for the phase to
# drain, then moves on. Each builder works in its own git worktree so two agents
# editing the same tree cannot collide; worktrees are merged back one at a time,
# and a merge conflict sends that task back to the queue for a serial retry
# rather than failing the run.
#
# Critics run serially against the merged branch. They commit test files, they
# are cheap, and serialising them keeps the ledger's critic column coherent.
set -uo pipefail

J=2
ROUNDS=60
UNATTENDED=0
STUB=0
while [ $# -gt 0 ]; do
  case "$1" in
    -j)           J="$2"; shift 2 ;;
    --rounds)     ROUNDS="$2"; shift 2 ;;
    --unattended) UNATTENDED=1; shift ;;
    --stub)       STUB=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WORKTREES="$ROOT/.worktrees"
mkdir -p logs "$WORKTREES"

for f in LEDGER.md BUILD.md CRITIC.md docs/spec.md; do
  [ -f "$f" ] || { echo "missing: $f — run scripts/run.sh once to bootstrap"; exit 1; }
done
if [ "$STUB" -eq 0 ]; then
  command -v claude >/dev/null || { echo "claude not on PATH"; exit 1; }
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty. commit or stash first."; exit 1
fi

PERM=(--permission-mode acceptEdits
      --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(node:*),Bash(git:*),Bash(npx:*),Bash(docker:*),Bash(./scripts/*)")
[ "$UNATTENDED" -eq 1 ] && PERM=(--dangerously-skip-permissions)

BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "base branch: $BASE_BRANCH   parallel: $J   rounds: $ROUNDS   stub: $STUB"

# ---------------------------------------------------------------- ledger reads

# Rows look like: | P3-01 | todo | - | - |
ledger_rows() { grep -oE '^\| *P[0-9]+-[0-9]+ *\| *[a-z-]+ *\|' LEDGER.md | tr -d '|' ; }

# Tasks that still need building, earliest phase first. `partial` outranks
# `todo` exactly as BUILD.md Part 0 requires.
ready_tasks() {
  local phase="$1"
  { ledger_rows | awk '$2=="partial"{print $1}' | grep -E "^P${phase}-" || true
    ledger_rows | awk '$2=="todo"{print $1}'    | grep -E "^P${phase}-" || true
  } | awk '!seen[$0]++'
}

phases_with_work() {
  ledger_rows | awk '$2=="todo"||$2=="partial"{print $1}' \
    | sed -E 's/^P([0-9]+)-.*/\1/' | sort -un
}

work_remains() { [ -n "$(phases_with_work)" ]; }

# ------------------------------------------------------------------ one builder

# build_one <task-id> — runs in a worktree, leaves a branch, never touches $ROOT
build_one() {
  local task="$1"
  local wt="$WORKTREES/$task"
  local branch="build/$task"
  local log="logs/${task}-build.json"

  rm -rf "$wt"
  git worktree remove --force "$wt" 2>/dev/null
  git branch -D "$branch" 2>/dev/null
  git worktree add -q -b "$branch" "$wt" "$BASE_BRANCH" || return 1

  # A worktree has no node_modules and npm would reinstall per task. Point every
  # workspace at the ones already installed in the main tree.
  ln -s "$ROOT/node_modules" "$wt/node_modules" 2>/dev/null
  for p in core cli viewer; do
    [ -d "$ROOT/packages/$p/node_modules" ] &&
      ln -s "$ROOT/packages/$p/node_modules" "$wt/packages/$p/node_modules" 2>/dev/null
  done

  if [ "$STUB" -eq 1 ]; then
    ( cd "$wt" && echo "stub $task" >> "STUB-$task.txt" \
      && git add -A && git commit -q -m "$task: stub" ) || return 1
    echo "{\"stub\":\"$task\"}" > "$log"
    return 0
  fi

  local prompt="Read BUILD.md and LEDGER.md. Execute exactly one iteration of the builder
protocol in Part 0 of BUILD.md, for task ${task} and no other task. Every open question is
already answered in Part 2 — do not stop to ask. You are in a git worktree on branch
${branch}; commit here as normal. Then stop."

  ( cd "$wt" && claude -p "$prompt" --output-format json --max-turns 200 "${PERM[@]}" ) > "$log"
}

# merge_one <task-id> — fast-forward or merge the task branch back onto the base.
# Returns 1 on conflict so the caller can requeue the task for a serial retry.
merge_one() {
  local task="$1"
  local branch="build/$task"
  git rev-parse --verify -q "$branch" >/dev/null || return 2   # nothing committed
  [ "$(git rev-list --count "$BASE_BRANCH..$branch")" -eq 0 ] && return 2
  if git merge --no-edit -q "$branch" 2>>logs/merge.log; then
    echo "  merged  $task"
    return 0
  fi
  git merge --abort 2>/dev/null
  echo "  CONFLICT $task — requeued for serial retry"
  return 1
}

cleanup_worktree() {
  local task="$1"
  git worktree remove --force "$WORKTREES/$task" 2>/dev/null
  git branch -D "build/$task" 2>/dev/null
}

# ------------------------------------------------------------------ one critic

critic_round() {
  local n="$1"
  [ "$STUB" -eq 1 ] && { echo "  (stub: no critic)"; return 0; }
  local prompt='Read CRITIC.md and follow it exactly. Review the most recent task marked
done with an empty critic column. Do not fix anything.'
  claude -p "$prompt" --output-format json --max-turns 120 "${PERM[@]}" \
    > "logs/${n}-critic.json"
}

# ----------------------------------------------------------------------- driver

STUCK=0
SAME=0
LAST_BATCH=""
SERIAL_RETRY=()

for r in $(seq 1 "$ROUNDS"); do
  work_remains || { echo "no tasks remaining."; break; }

  PHASE="$(phases_with_work | head -1)"
  N="$(printf '%03d' "$r")"
  BEFORE="$(git rev-parse HEAD)"

  QUEUE=()
  while IFS= read -r line; do [ -n "$line" ] && QUEUE+=("$line"); done < <(ready_tasks "$PHASE")
  if [ "${#SERIAL_RETRY[@]}" -gt 0 ]; then
    QUEUE=("${SERIAL_RETRY[@]}" "${QUEUE[@]}")
    SERIAL_RETRY=()
  fi
  [ "${#QUEUE[@]}" -eq 0 ] && { echo "phase $PHASE has no runnable task"; break; }

  BATCH=("${QUEUE[@]:0:$J}")
  echo "======== round $r/$ROUNDS — phase $PHASE — ${BATCH[*]} ========"

  PIDS=()
  for t in "${BATCH[@]}"; do
    build_one "$t" & PIDS+=("$!")
  done
  for pid in "${PIDS[@]}"; do wait "$pid"; done

  for t in "${BATCH[@]}"; do
    merge_one "$t"
    case $? in
      1) SERIAL_RETRY+=("$t") ;;
      2) echo "  no commit  $t" ;;
    esac
    cleanup_worktree "$t"
  done

  # A merge can pass while the merged whole does not. This is the gate that a
  # per-task verify command cannot see.
  if [ "$STUB" -eq 0 ]; then
    if ! npm test >/dev/null 2>&1 || ! npm run check >/dev/null 2>&1; then
      echo "  !! suite or guards red after merge — stopping for a human"
      git --no-pager log --oneline -"${#BATCH[@]}"
      exit 1
    fi
  fi

  # A builder that commits code but forgets to update the ledger leaves its task
  # `todo`, so the queue hands back the same batch forever while commits keep
  # landing and STUCK never fires. Block the batch instead of burning the night
  # on it; `blocked` is exactly what BUILD.md Part 0 step 5 asks for.
  if [ "${BATCH[*]}" = "$LAST_BATCH" ]; then
    SAME=$((SAME + 1))
  else
    SAME=1; LAST_BATCH="${BATCH[*]}"
  fi
  if [ "$SAME" -ge 3 ]; then
    echo "  !! ${BATCH[*]} unchanged after 3 rounds — marking blocked"
    for t in "${BATCH[@]}"; do
      sed -i.bak -E "s/^(\| *${t} *\| *)(todo|partial)( *\|)/\1blocked\3/" LEDGER.md
    done
    rm -f LEDGER.md.bak
    git add LEDGER.md
    git commit -q -m "loop: blocked ${BATCH[*]} — 3 rounds with no status change"
    SAME=0; LAST_BATCH=""
  fi

  echo "-- critic --"
  critic_round "$N"

  if [ "$(git rev-parse HEAD)" = "$BEFORE" ]; then
    STUCK=$((STUCK + 1))
    echo "(no commit this round; stuck=$STUCK)"
    [ "$STUCK" -ge 3 ] && { echo "--- STOPPING: three rounds with no commit ---"; exit 0; }
  else
    STUCK=0
  fi

  REJECTS=$(git --no-pager log --oneline -6 | grep -c 'REJECTED' || true)
  [ "$REJECTS" -ge 3 ] && { echo "--- STOPPING: 3 rejections in the last 6 commits ---"; exit 0; }
  NOCHECK=$(git --no-pager log --oneline -6 | grep -c 'no-check' || true)
  [ "$NOCHECK" -ge 3 ] && { echo "--- STOPPING: 3 no-check verdicts ---"; exit 0; }
  echo
done

git worktree prune
echo "======== finished ========"
git --no-pager log --oneline -20
for s in done partial todo blocked; do
  c=$(grep -cE "\| $s \|" LEDGER.md 2>/dev/null); c=${c:-0}
  printf '%-8s %s\n' "$s:" "$c"
done
