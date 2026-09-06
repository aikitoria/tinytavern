#!/bin/sh
set -eu
# Keep secrets in mounted files rather than Compose interpolation or image layers.
TINYTAVERN_PROXY_TOKEN=$(cat /secrets/proxy.key)
export TINYTAVERN_PROXY_TOKEN
CADDY_ALLOWED_IPS=$(printf '%s' "${TINYTAVERN_IP_ALLOWLIST:-0.0.0.0/0,::/0}" | tr ',' ' ')
export CADDY_ALLOWED_IPS
exec caddy "$@"
