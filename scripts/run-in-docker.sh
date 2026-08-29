#!/usr/bin/env bash
# Run the whole build inside a container. This is where --unattended is sane.
#
#   bash scripts/run-in-docker.sh              60 rounds
#   bash scripts/run-in-docker.sh --rounds 80
#   bash scripts/run-in-docker.sh --shell      drop into the container instead
#
# Auth: uses a token from `claude setup-token` on the host. Your ~/.claude is
# never mounted, so nothing running inside can read or exfiltrate your
# credentials file. The token is scoped and you can revoke it.
set -euo pipefail

ROUNDS=60
SHELL_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rounds) ROUNDS="$2"; shift 2 ;;
    --shell)  SHELL_ONLY=1; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin not found"; exit 1; }

for f in docs/spec.md BUILD.md BOOTSTRAP.md CRITIC.md \
         scripts/run.sh scripts/run-loop.sh \
         scripts/check-no-model-sdk.mjs scripts/check-deps.mjs \
         .docker/Dockerfile .docker/compose.yml; do
  [ -f "$f" ] || { echo "missing: $f"; exit 1; }
done

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is dirty. commit or stash first."; exit 1
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  cat <<'MSG'
CLAUDE_CODE_OAUTH_TOKEN is not set.

On the host, once:

    claude setup-token

then export the value it prints:

    export CLAUDE_CODE_OAUTH_TOKEN=<token>

Do not mount ~/.claude instead. A long unattended run with permissions
disabled can read anything inside the container, and a token you can
revoke is a much smaller thing to hand it than your credentials file.
MSG
  exit 1
fi

export HOST_UID="$(id -u)" HOST_GID="$(id -g)" ROUNDS

echo "building image..."
docker compose -f .docker/compose.yml build

if [ "$SHELL_ONLY" -eq 1 ]; then
  exec docker compose -f .docker/compose.yml run --rm build bash
fi

echo "starting build: $ROUNDS rounds, unattended."
echo "follow along with: tail -f logs/*.json  (from another terminal)"
echo
docker compose -f .docker/compose.yml run --rm build
RC=$?

echo
echo "container exited ($RC). commits landed on your host via the bind mount:"
git --no-pager log --oneline -20
exit $RC
