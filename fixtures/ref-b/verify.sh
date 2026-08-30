#!/usr/bin/env bash
# verify.sh — structural check on reference system B (BUILD.md P3-03).
#
#   bash fixtures/ref-b/verify.sh
#
# Checks that B is still shaped the way the gold file and PLANTED.md assume.
# It is parse-only and tool-free by design: `terraform` and `go` are NOT
# installed in this environment and must never be needed. Ground rule R2 —
# reference systems are read as source, never started — so nothing here plans,
# applies, builds or runs anything.
#
# It fails loudly, with the specific reason, if:
#   * a cmd/ binary or a terraform file went missing
#   * the six services drift out of sync between cmd/, Makefile and terraform
#   * plant 1 stops being code-only (a dispatch address leaks into terraform)
#   * plant 2 stops being fictional (an elasticache resource appears, or a
#     binary starts importing internal/platform/cache)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0

fail() { printf 'FAIL  %s\n' "$1" >&2; fails=$((fails + 1)); }
ok()   { printf 'ok    %s\n' "$1"; }

# ---------------------------------------------------------------- preflight
for f in go.mod Makefile README.md PLANTED.md terraform/main.tf deploy/schema.sql; do
  [ -f "$HERE/$f" ] || { printf 'preflight: fixtures/ref-b/%s is missing — B is incomplete\n' "$f" >&2; exit 2; }
done
command -v grep >/dev/null || { echo 'preflight: grep not on PATH' >&2; exit 2; }

SERVICES="ingest-gateway trip-builder geofence-eval fleet-api dispatch maintenance-forecast"

# ------------------------------------------------- six binaries, one module
for s in $SERVICES; do
  [ -f "$HERE/cmd/$s/main.go" ] || fail "cmd/$s/main.go is missing"
  grep -q "\"$s\"" "$HERE/terraform/main.tf" || fail "terraform/main.tf local.services does not list $s"
  grep -q "$s" "$HERE/Makefile" || fail "Makefile SERVICES does not list $s"
done
count="$(find "$HERE/cmd" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
[ "$count" = "6" ] || fail "expected 6 binaries under cmd/, found $count"
[ "$(find "$HERE" -name 'docker-compose*' -o -name 'Chart.yaml' | wc -l | tr -d ' ')" = "0" ] \
  || fail "B must have no compose file and no chart — infrastructure is terraform/ only"
ok "six binaries, no compose file"

# --------------------------------------------------------- one queue, one db
grep -q 'resource "aws_kinesis_stream" "telemetry_frames"' "$HERE/terraform/stream.tf" \
  || fail "the telemetry stream resource is gone from terraform/stream.tf"
streams="$(grep -c 'resource "aws_kinesis_stream" ' "$HERE/terraform/stream.tf")"
[ "$streams" = "1" ] || fail "B must have exactly one queue; found $streams streams"
grep -rq 'resource "aws_sqs_queue"' "$HERE/terraform" && fail "an SQS queue appeared; B has one Kinesis stream and nothing else"
ok "exactly one queue"

# ------------------------------------------ plant 1: coupling is code-only
grep -q 'internal/dispatchclient' "$HERE/internal/maintenance/forecast.go" \
  || fail "plant 1 is gone: internal/maintenance/forecast.go no longer imports dispatchclient"
grep -q 'HoldVehicle' "$HERE/internal/maintenance/forecast.go" \
  || fail "plant 1 is gone: forecast.go no longer calls HoldVehicle"
grep -q 'const DefaultAddr = "dispatch.fleet.internal:9090"' "$HERE/internal/dispatchclient/client.go" \
  || fail "plant 1 weakened: the dispatch address is no longer a code constant"
if grep -rq 'DISPATCH_ADDR\|dispatch.fleet.internal' "$HERE/terraform"; then
  fail "plant 1 broken: a dispatch address leaked into terraform/, so the coupling is no longer code-only"
fi
if grep -n 'maintenance-forecast' "$HERE/terraform/ecs.tf" | grep -qi 'dispatch'; then
  fail "plant 1 broken: the maintenance-forecast task definition now mentions dispatch"
fi
# "code-only" has to mean code-only in PROSE too. deploy/README.md once said in
# plain English that the nightly forecast job calls HoldVehicle, which let an
# agent score G12 — the held-out measurement of "a coupling visible only by
# reading code" — without opening a single .go file. Any non-Go file that puts
# the caller within six lines of the call breaks the plant.
leaks=""
while IFS= read -r f; do
  # PLANTED.md, gold-citations.md and this script are the answer key and are
  # withheld from the agent by scripts/eval/stage.mjs; they are meant to say it.
  case "$f" in
    *.go) continue ;;
    */PLANTED.md|*/gold-citations.md|*/verify.sh) continue ;;
  esac
  if grep -n -i -C6 'HoldVehicle' "$f" 2>/dev/null | grep -qiE 'forecast|nightly|maintenance'; then
    leaks="$leaks $f"
  fi
done <<< "$(grep -rl 'HoldVehicle' "$HERE" 2>/dev/null)"
[ -z "$leaks" ] || fail "plant 1 broken: the caller is named beside HoldVehicle outside Go source:$leaks"
ok "plant 1 is visible only in Go source"

# ---------------------------------------- plant 2: the cache does not exist
[ -f "$HERE/internal/platform/cache/redis.go" ] \
  || fail "plant 2 is gone: internal/platform/cache/redis.go was deleted"
grep -q 'position_cache_endpoint' "$HERE/terraform/variables.tf" \
  || fail "plant 2 weakened: the unused position_cache_endpoint variable is gone"
if grep -rq 'aws_elasticache' "$HERE/terraform"; then
  fail "plant 2 broken: an elasticache resource now exists, so the position cache is real"
fi
users="$(grep -rl 'platform/cache' "$HERE/cmd" "$HERE/internal" | grep -v '/platform/cache/' | grep -v 'handlers.go')"
[ -z "$users" ] || fail "plant 2 broken: a binary now imports platform/cache: $users"
refs="$(grep -rl 'position_cache_endpoint' "$HERE/terraform" | grep -v 'variables.tf')"
[ -z "$refs" ] || fail "plant 2 broken: position_cache_endpoint is now referenced by $refs"
ok "plant 2 is still fictional"

# --------------------------------------------------- the answer key is here
for needle in "Plant 1" "Plant 2" "internal/maintenance/forecast.go:67" "terraform/variables.tf:38"; do
  grep -q "$needle" "$HERE/PLANTED.md" || fail "PLANTED.md no longer documents: $needle"
done
ok "PLANTED.md documents both plants with citations"

# ------------------------------------ the fixture must not announce itself
# go.mod once opened with "Reference system B for the diagram-engine eval rig
# (BUILD.md P3-03)" and was staged verbatim into the agent's cwd on every run:
# it told the agent it was being scored and handed it the repository name to
# search for. Only PLANTED.md and gold-citations.md — both withheld from the
# agent — may say what this tree is for.
selfref="$(grep -rl -iE 'eval rig|eval harness|reference system|BUILD\.md|agent under test|diagram-engine' "$HERE" \
           | grep -v 'PLANTED.md' | grep -v 'gold-citations.md' | grep -v 'verify.sh')"
[ -z "$selfref" ] || fail "the fixture names the rig it belongs to, and every one of these files is staged into the agent's workspace: $selfref"

if [ "$fails" -ne 0 ]; then
  printf '\n%d check(s) failed — reference system B no longer matches PLANTED.md\n' "$fails" >&2
  exit 1
fi
printf '\nreference system B is intact\n'
