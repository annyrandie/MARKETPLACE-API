#!/usr/bin/env bash
# Rotates app_user's DB password WITHOUT restarting the app.
#
# Order matters:
#   1. ALTER ROLE in Postgres (the new value becomes truth);
#   2. update the secret file right after (new connections pick up the fresh
#      password from here — see the `password` function in app.js);
#   3. kill app_user's OLD connections — proving the next request opens a
#      brand new connection, already with the new password.
#
# There's a millisecond-scale window between 1 and 2 where a new connection
# with the old password would fail. Production secret managers (AWS Secrets
# Manager rotation, Vault's database engine) close that window with two
# alternating users: while user_a is live, rotate user_b — no window at all.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

NEW_PASSWORD="app-$(openssl rand -hex 8)"

echo "1. ALTER ROLE in Postgres…"
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE app_user WITH PASSWORD '${NEW_PASSWORD}';" >/dev/null

echo "2. Updating the secret file…"
# Atomic: write to a temp file, then rename. `>` alone truncates in place —
# a connection reading the file at the exact wrong moment would see a
# partial (possibly empty) password. `mv` on the same filesystem is a single
# atomic rename, so a reader always sees either the whole old file or the
# whole new one, never something in between.
printf '%s' "${NEW_PASSWORD}" > secrets/db_password.tmp
mv secrets/db_password.tmp secrets/db_password

echo "3. Closing app_user's old connections…"
docker compose exec -T db psql -U admin -d marketplace -tA \
  -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app_user';"

[ -f .env ] && source .env

echo "Done: new password ${NEW_PASSWORD:0:6}… is now in both the DB and the file."
echo "The app did NOT restart — check: curl -s localhost:${PORT:-3000}/health"
