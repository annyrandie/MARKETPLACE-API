#!/usr/bin/env bash
# Restore drill: take the most recent scripts/backup.sh dump, restore it
# into a container/volume that did NOT exist a moment ago, and prove the
# data actually came back — count(*) + sum(price_cents) on `products`
# at dump time (read from the .checksum sidecar scripts/backup.sh wrote,
# NOT re-queried from the live DB now — see that file's comment: backup and
# drill can run hours apart, and the live DB may have moved on since) vs.
# the freshly-restored clean copy. A backup nobody has restored is a
# lottery ticket, not a backup.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
LATEST="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST" ]; then
  echo "✗ No backup found in $BACKUP_DIR — run scripts/backup.sh first." >&2
  exit 1
fi

CHECKSUM_FILE="${LATEST}.checksum"
if [ ! -f "$CHECKSUM_FILE" ]; then
  echo "✗ No $CHECKSUM_FILE — this dump predates the checksum sidecar; re-run scripts/backup.sh." >&2
  exit 1
fi

# Milliseconds, not $SECONDS — a drill this small (well under a second) would
# round to "0 s" with a whole-second timer, which isn't a measurement.
# EPOCHREALTIME is bash >= 5; macOS ships bash 3.2, so fall back to perl.
if [ -n "${EPOCHREALTIME:-}" ]; then
  now_ms() { local t="${EPOCHREALTIME/[.,]/}"; echo "${t:0:${#t}-3}"; }
else
  now_ms() { perl -MTime::HiRes -e 'printf("%.0f\n", Time::HiRes::time()*1000)'; }
fi
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }

CHECKSUM_SQL="SELECT count(*) || '|' || coalesce(sum(price_cents), 0) FROM products"

cleanup() {
  # `down -v`, not a hardcoded volume name: the volume's actual name is
  # <project>_pgdata-restore, and <project> is whatever COMPOSE_PROJECT_NAME
  # (or -p) resolves to for this invocation — not necessarily this repo's
  # compose `name:` default. `down -v`, scoped to the `restore` service,
  # asks Compose to resolve and remove that volume itself instead of us
  # guessing its name, so a different project name can't leave orphaned
  # volumes behind for the next drill to collide with.
  docker compose --profile drill down -v restore >/dev/null 2>&1 || true
}
# The drill always tears down its own container+volume on the way out —
# success or failure — so the next run (this one included, re-entered after
# a crash) always starts from a volume that genuinely did not exist before.
trap cleanup EXIT

echo "━━━ 1. Checksum at backup time (from the .checksum sidecar) ━━━"
BEFORE="$(cat "$CHECKSUM_FILE")"
echo "  products before: $BEFORE  (count|sum(price_cents))"

echo "━━━ 2. Clean restore target (profile: drill) ━━━"
cleanup
docker compose --profile drill up -d --wait restore
EMPTY_CHECK="$(docker compose exec -T restore psql -U admin -d marketplace -Atc \
  "SELECT count(*) FROM pg_tables WHERE tablename = 'products'")"
if [ "$EMPTY_CHECK" != "0" ]; then
  echo "✗ Restore target is not empty (products table already exists) — drill would prove nothing." >&2
  exit 1
fi

echo "━━━ 3. pg_restore + checksum ━━━"
T0=$(now_ms)
# --no-owner: the dump's objects are owned by admin/app_user — irrelevant
# here, the restore target just needs the data. --no-acl for the same
# reason: the dump also carries init.sql's `GRANT ... TO app_user`, and that
# role was never created in this disposable restore target (on purpose — a
# drill proves the DATA came back, not that every grant replays byte for
# byte). Without both flags pg_restore fails outright on "role app_user
# does not exist".
docker compose exec -T restore pg_restore -U admin -d marketplace --no-owner --no-acl < "$LATEST"
RESTORE_MS=$(( $(now_ms) - T0 ))
AFTER="$(docker compose exec -T restore psql -U admin -d marketplace -Atc "$CHECKSUM_SQL")"
echo "  products after:  $AFTER"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "MATCH — restored data equals the dump's checksum at backup time ($(secs "$RESTORE_MS")s)"
else
  echo "MISMATCH: before='$BEFORE' after='$AFTER'" >&2
  exit 1
fi
