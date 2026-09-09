#!/usr/bin/env bash
set -euo pipefail

if (( $# )); then
  echo 'Usage: scripts/run-isolated-tests.sh (always runs the complete suite)' >&2
  exit 2
fi

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
container="tinytavern-tests-$$"
compose=(docker compose -p "$container" -f "$repo_dir/tests/compose.yml")
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! docker image inspect tinytavern-server-dev >/dev/null 2>&1; then
  "${compose[@]}" build tests
fi
"${compose[@]}" run --rm --no-deps --name "$container" tests
