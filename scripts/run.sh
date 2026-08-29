#!/usr/bin/env bash
# Topology — build the whole thing. One command, walk away.
#
#   bash scripts/run.sh              supervised: prompts for tool use
#   bash scripts/run.sh --unattended no prompts. run this inside a container.
#   bash scripts/run.sh --rounds 80  raise the round cap (default 60)
#
# Stops only on failure: a stuck builder, a stuck critic, or a real quality bar
# that was not met. There are no human gates.
set -uo pipefail

ROUNDS=60
UNATTENDED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --unattended) UNATTENDED=1; shift ;;
    --rounds) ROUNDS="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

for f in docs/spec.md BUILD.md BOOTSTRAP.md CRITIC.md \
         scripts/check-no-model-sdk.mjs scripts/check-deps.mjs scripts/run-loop.sh; do
  [ -f "$f" ] || { echo "missing: $f"; exit 1; }
done
command -v claude >/dev/null || { echo "claude not on PATH"; exit 1; }
command -v git    >/dev/null || { echo "git not on PATH"; exit 1; }
chmod +x scripts/run-loop.sh
mkdir -p logs

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty. commit or stash first so the diff is readable."; exit 1
fi

PERM_ARGS=(--permission-mode acceptEdits
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm:*),Bash(node:*),Bash(git:*),Bash(npx:*),Bash(docker:*),Bash(./scripts/*)")
if [ "$UNATTENDED" -eq 1 ]; then
  PERM_ARGS=(--dangerously-skip-permissions)
  echo "!! unattended mode: no permission prompts. only sane inside a container."
fi
export TOPOLOGY_PERM_ARGS="${PERM_ARGS[*]}"

START=$(date +%s)

if [ ! -f LEDGER.md ]; then
  echo "======== bootstrap ========"
  claude -p "Read BOOTSTRAP.md and follow it exactly. Do not begin task work." \
    --output-format json --max-turns 200 "${PERM_ARGS[@]}" \
    > logs/000-bootstrap.json || { echo "bootstrap failed. see logs/000-bootstrap.json"; exit 1; }
  [ -f LEDGER.md ] || { echo "bootstrap did not write LEDGER.md"; exit 1; }
  echo
  echo "--- ledger written ---"
  sed -n '/^## Tasks/,/^## Findings/p' LEDGER.md | grep -cE '\| (done|partial|todo|blocked) \|' \
    | xargs -I{} echo "{} tasks recorded"
  echo
else
  echo "LEDGER.md exists — resuming."
fi

bash scripts/run-loop.sh "$ROUNDS"
RC=$?

MINS=$(( ($(date +%s) - START) / 60 ))
echo
echo "======== finished after ${MINS}m ========"
git --no-pager log --oneline "-$(( ROUNDS * 2 ))" 2>/dev/null | head -40
echo
grep -cE '\| done \|'    LEDGER.md | xargs -I{} echo "done:    {}"
grep -cE '\| partial \|' LEDGER.md | xargs -I{} echo "partial: {}"
grep -cE '\| todo \|'    LEDGER.md | xargs -I{} echo "todo:    {}"
grep -cE '\| blocked \|' LEDGER.md | xargs -I{} echo "blocked: {}"
echo
echo "read the Findings and Log sections of LEDGER.md."
exit $RC
