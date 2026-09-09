#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )); then
  echo 'Usage: scripts/run-in-container.sh check|format|format:check|build|install|test' >&2
  exit 2
fi
action=$1
case "$action" in
  check|format|format:check|build|install|test) ;;
  *) echo "Unknown container task: $action" >&2; exit 2 ;;
esac
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
container="tinytavern-task-$action-$$"
container=${container//:/-}
temporary=$(mktemp -d)
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage=tools
network=none
command=(bun --bun run "$action")
if [[ $action == install ]]; then
  stage=server-base
  network=bridge
  command=(bun install)
elif [[ $action == format ]]; then
  command=(sh -c 'bun --bun run format && mkdir -p /app/.task-output && tar --exclude=./.task-output --exclude=./node_modules --exclude="*/node_modules" --exclude=./client/dist -cf /app/.task-output/formatted.tar .')
fi
# Cached builds only inspect manifests. Use the immutable image ID if another checkout builds too.
if ! image=$(docker build --quiet --target "$stage" -f "$repo_dir/Dockerfile" "$repo_dir" 2>"$temporary/build.log"); then
  cat "$temporary/build.log" >&2
  exit 1
fi
docker create --name "$container" --init --user 1000:1000 --network "$network" \
  --tmpfs /tmp:mode=1777 --workdir /app "$image" "${command[@]}" >/dev/null
# No host mounts, including source, node_modules, databases, keys or deployment files.
tar -C "$repo_dir" --exclude=.git --exclude=.codex --exclude=.agents \
  --exclude=node_modules --exclude=data --exclude=data-dev --exclude='.env*' \
  --exclude=.secrets --exclude=certs --exclude=./client/dist -cf - . \
  | docker cp -a - "$container:/app"
docker start --attach "$container"
case "$action" in
  install) docker cp "$container:/app/bun.lock" "$repo_dir/bun.lock" ;;
  format)
    docker cp "$container:/app/.task-output/formatted.tar" "$temporary/formatted.tar"
    tar --no-same-owner -xf "$temporary/formatted.tar" -C "$repo_dir"
    ;;
  build) docker cp "$container:/app/client/dist" "$repo_dir/client/" ;;
esac
