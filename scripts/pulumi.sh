#!/usr/bin/env bash
# npm run up / destroy / preview — Pulumi on the LOCAL file backend
# (PULUMI_BACKEND_URL=file://…, no `pulumi login` to anyone's account),
# stack `dev`, passphrase secrets provider. Called through
# scripts/with-secrets.sh, which provides the secret env the program needs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-up}"; shift || true
STACK="${PULUMI_STACK:-dev}"

export PULUMI_BACKEND_URL="${PULUMI_BACKEND_URL:-file://$ROOT/.pulumi}"
case "$PULUMI_BACKEND_URL" in file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;; esac
export PULUMI_SKIP_UPDATE_CHECK=true

cd "$ROOT/infra"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build --silent

pulumi stack select "$STACK" --create --secrets-provider passphrase --non-interactive >/dev/null
case "$ACTION" in
  up)      pulumi up --yes --skip-preview --non-interactive "$@" ;;
  destroy) pulumi destroy --yes --skip-preview --non-interactive "$@" ;;
  preview) pulumi preview --non-interactive "$@" ;;
  *)       pulumi "$ACTION" "$@" ;;
esac
