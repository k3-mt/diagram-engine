#!/usr/bin/env bash
# Adversarial build loop: builder and critic alternate in fresh sessions.
#   usage: bash scripts/run-loop.sh [max-rounds]
# Normally invoked by scripts/run.sh, which sets TOPOLOGY_PERM_ARGS.
set -uo pipefail

MAX="${1:-60}"
mkdir -p logs

read -r -a PERM <<< "${TOPOLOGY_PERM_ARGS:---permission-mode acceptEdits}"

BUILDER_PROMPT='Read BUILD.md and LEDGER.md. Execute exactly one iteration of the
builder protocol in Part 0 of BUILD.md. Every open question is already answered in
Part 2 — do not stop to ask. A task the critic sent back to partial with a REJECTED
verdict outranks anything still todo. Then stop.'

CRITIC_PROMPT='Read CRITIC.md and follow it exactly. Review the most recent task marked
done with an empty critic column. Do not fix anything.'

work_remains() { grep -qE '\| (todo|partial) \|' LEDGER.md; }

run() {  # run <prompt> <logfile> <turns>
  claude -p "$1" --output-format json --max-turns "$3" "${PERM[@]}" > "$2"
}

STUCK=0

for r in $(seq 1 "$MAX"); do
  N=$(printf '%03d' "$r")
  BEFORE=$(git rev-parse HEAD)
  echo "======== round $r / $MAX ========"

  echo "-- builder --"
  if ! run "$BUILDER_PROMPT" "logs/${N}-build.json" 200; then
    echo "builder exited non-zero. see logs/${N}-build.json"; exit 1
  fi
  git --no-pager log --oneline -1

  echo "-- critic --"
  if ! run "$CRITIC_PROMPT" "logs/${N}-critic.json" 120; then
    echo "critic exited non-zero. see logs/${N}-critic.json"; exit 1
  fi
  git --no-pager log --oneline -1

  # no commits at all this round means the loop is spinning
  if [ "$(git rev-parse HEAD)" = "$BEFORE" ]; then
    STUCK=$((STUCK + 1))
    echo "(no commit this round; stuck=$STUCK)"
    if [ "$STUCK" -ge 3 ]; then
      echo; echo "--- STOPPING: three rounds with no commit ---"; exit 0
    fi
  else
    STUCK=0
  fi

  REJECTS=$(git --no-pager log --oneline -6 | grep -c 'REJECTED' || true)
  if [ "$REJECTS" -ge 3 ]; then
    echo; echo "--- STOPPING: 3 rejections in the last 6 commits ---"
    echo "the builder is producing work that does not survive review. read LEDGER.md."
    exit 0
  fi

  NOCHECK=$(git --no-pager log --oneline -6 | grep -c 'no-check' || true)
  if [ "$NOCHECK" -ge 3 ]; then
    echo; echo "--- STOPPING: 3 no-check verdicts ---"
    echo "the critic is finding nothing to test. that is a critic failure, not a clean"
    echo "bill of health. read CRITIC.md against the tasks it reviewed."
    exit 0
  fi

  if ! work_remains; then echo "done — no tasks remaining."; exit 0; fi
  echo
done

echo "hit round cap ($MAX). re-run scripts/run.sh to continue."
