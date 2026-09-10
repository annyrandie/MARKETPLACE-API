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
printf '%s' "${NEW_PASSWORD}" > secrets/db_password

echo "3. Closing app_user's old connections…"
docker compose exec -T db psql -U admin -d marketplace -tA \
  -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app_user';"

echo "Done: new password ${NEW_PASSWORD:0:6}… is now in both the DB and the file."
echo "The app did NOT restart — check: curl -s localhost:3000/health"
