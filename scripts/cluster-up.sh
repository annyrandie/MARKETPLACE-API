#!/usr/bin/env bash
# npm run cluster:up — create the kind cluster (idempotent) and load the
# images into it. Re-run after every image rebuild: `kind load` is what
# makes a host-built image exist inside the node.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${KIND_CLUSTER:-marketplace}"
APP_IMAGE="${IMAGE:-marketplace-api:hw28}"
DB_IMAGE="postgres:16-alpine"

docker image inspect "$APP_IMAGE" >/dev/null 2>&1 || { echo "✗ $APP_IMAGE not built — run: npm run image:build" >&2; exit 1; }
docker image inspect "$DB_IMAGE" >/dev/null 2>&1 || docker pull -q "$DB_IMAGE"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "cluster $CLUSTER already exists"
else
  kind create cluster --config "$ROOT/k8s/kind-config.yaml" --name "$CLUSTER" --wait 120s
fi
# Not `kind load docker-image`: with Docker Desktop's containerd image
# store, a pulled image is a multi-platform index whose OTHER platforms'
# layers were never downloaded, and kind imports with --all-platforms →
# "content digest …: not found". Saving just this machine's platform into
# an archive and loading that works on both image stores.
PLATFORM="linux/$(docker version --format '{{.Server.Arch}}')"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for img in "$APP_IMAGE" "$DB_IMAGE"; do
  docker save --platform "$PLATFORM" -o "$TMP/image.tar" "$img"
  kind load image-archive "$TMP/image.tar" --name "$CLUSTER"
  echo "loaded $img ($PLATFORM) into $CLUSTER"
done
kubectl config use-context "kind-$CLUSTER" >/dev/null
echo "node memory: $(docker stats --no-stream --format '{{.MemUsage}}' "$CLUSTER-control-plane")"
