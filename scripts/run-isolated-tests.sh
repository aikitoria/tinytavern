#!/usr/bin/env bash
set -euo pipefail
if (( $# )); then
  echo 'Usage: scripts/run-isolated-tests.sh (always runs the complete suite)' >&2
  exit 2
fi
exec "$(dirname -- "${BASH_SOURCE[0]}")/run-in-container.sh" test
