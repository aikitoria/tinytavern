#!/usr/bin/env bash
set -euo pipefail

if (( $# != 0 )); then
  echo 'Usage: scripts/deploy.sh (deploys dev and prod)' >&2
  exit 2
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Use a certificate identity for local HTTPS checks without installation-specific addresses.
deploy_host=${DEPLOY_HOST:-$(openssl x509 -in certs/cert.pem -noout -ext subjectAltName |
  sed -nE 's/.*(DNS:|IP Address:)([^,[:space:]]+).*/\2/p')}
if [[ -z $deploy_host ]]; then
  echo 'Set DEPLOY_HOST to a hostname or IP covered by certs/cert.pem.' >&2
  exit 1
fi
if [[ $deploy_host == *:* && $deploy_host != \[*\] ]]; then
  deploy_host="[$deploy_host]"
fi

logs=$(mktemp -d /tmp/tinytavern-deploy.XXXXXX)
cleanup() {
  local status=$?
  local pending
  mapfile -t pending < <(jobs -pr)
  if (( ${#pending[@]} )); then
    kill "${pending[@]}" 2>/dev/null || true
    wait "${pending[@]}" 2>/dev/null || true
  fi
  if (( status == 0 )); then
    rm -rf -- "$logs"
  else
    echo "Deployment failed; build logs: $logs" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

./scripts/init-caddy.sh --media-dirs

echo 'Building dev and prod concurrently...'
docker compose -f docker-compose.yml build > "$logs/prod.log" 2>&1 &
prod_build=$!
docker compose -f docker-compose.dev.yml build server client caddy-dev > "$logs/dev.log" 2>&1 &
dev_build=$!
build_failed=0
wait "$prod_build" || build_failed=1
wait "$dev_build" || build_failed=1
if (( build_failed )); then
  tail -n 40 "$logs/prod.log" "$logs/dev.log" >&2
  exit 1
fi

# Both builds must succeed before touching live containers. Serialize Compose mutations.
echo 'Deploying production...'
docker compose -f docker-compose.yml up -d --no-build tinytavern caddy-prod
echo 'Deploying development...'
docker compose -f docker-compose.dev.yml up -d --no-build --force-recreate server client caddy-dev

check_https() {
  local name=$1 port=$2 path=$3 status
  status=$(curl --silent --show-error --fail --noproxy '*' \
    --cacert certs/cert.pem --connect-to "$deploy_host:$port:127.0.0.1:$port" \
    --connect-timeout 2 --max-time 5 --retry 15 --retry-delay 1 --retry-max-time 45 --retry-all-errors \
    --output /dev/null --write-out '%{http_code}' "https://$deploy_host:$port$path")
  echo "$name: HTTP $status"
  [[ $status == 200 ]]
}

check_https 'Production frontend' 5487 /
check_https 'Production API' 5487 /api/auth/status
check_https 'Development frontend' 5173 /
check_https 'Development API' 5173 /api/auth/status
docker compose -f docker-compose.yml ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
echo 'Dev and prod deployed successfully.'
