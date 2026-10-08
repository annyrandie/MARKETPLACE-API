#!/usr/bin/env bash
# Logical backup: pg_dump -Fc, run INSIDE the `db` container, not through
# PgBouncer and not via whatever pg_dump happens to be on the host's PATH.
#
# Two separate reasons, not one:
#  - Version skew: pg_dump's archive format isn't guaranteed compatible
#    across major versions. A host-installed pg_dump (whatever version a
#    dev machine or grader happens to have) can emit a format pg_restore on
#    this project's postgres:16 can't read. Running it inside the same
#    image `db` runs guarantees dump and restore always agree.
#  - PgBouncer transaction mode itself: pg_dump issues session-level SET
#    commands before opening its snapshot transaction. Under pool_mode =
#    transaction those SETs and the transaction that follows aren't
#    guaranteed to land on the same backend connection — the exact "what
#    transaction mode breaks" hazard documented in README. A backup tool is
#    the one place here where that risk isn't worth taking, so it talks to
#    `db` directly, same as scripts/rotate.sh's admin operations already do.
#
# Reads DB_USER/DB_NAME from process.env the same way every other
# DB-touching npm script in this project does (see scripts/with-secrets.sh's
# header comment) — `bash scripts/with-secrets.sh dev bash scripts/backup.sh`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${DB_USER:?DB_USER is not set — run via: bash scripts/with-secrets.sh dev bash scripts/backup.sh}"
: "${DB_NAME:?}"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}_${STAMP}.dump"

# Checksum captured right alongside the dump, from the same `db` connection,
# not re-read later by the drill. A nightly backup.sh and a morning
# restore-drill.sh are hours apart — if the drill re-queried the *live* DB
# for "before", any write in between (a new order, another demo run) would
# read back as a false MISMATCH on a dump that was perfectly fine. The
# sidecar freezes what this dump actually contains, at the moment it was
# taken.
CHECKSUM="$(docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc \
  "SELECT count(*) || '|' || coalesce(sum(price_cents), 0) FROM products")"
echo "$CHECKSUM" > "${OUT}.checksum"

docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Backup created: $OUT (${SIZE})"
