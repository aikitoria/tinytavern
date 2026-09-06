#!/bin/sh
# Run as the stack's UID (1000 by default). Never overwrites existing keys.
set -eu
cd "$(dirname "$0")/.."
umask 077
for stack in dev prod; do
  mkdir -p ".secrets/$stack"
  for kind in media proxy; do
    key=".secrets/$stack/$kind.key"
    if [ ! -e "$key" ]; then
      # noclobber prevents concurrent initializers from replacing a key.
      (set -C; openssl rand -hex 32 > "$key")
    fi
    if ! LC_ALL=C grep -Eq '^[a-f0-9]{64}$' "$key"; then
      echo "Invalid signing key: $key" >&2
      exit 1
    fi
  done
done
if [ "${1:-}" = "--media-dirs" ]; then
  mkdir -p data/images data/avatars data-dev/images data-dev/avatars
fi
