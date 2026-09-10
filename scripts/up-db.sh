#!/usr/bin/env bash
# Brings up Postgres and prepares the secret file. Safe to re-run: if the
# container/volume already existed (so init.sql did not re-run), it
# re-aligns the role's password with whatever is currently in the secret
# file — this is exactly the step you need after `docker compose down -v`,
# which resets Postgres to init.sql's password while the file may still hold
# a rotated one.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p secrets
[ -f secrets/db_password ] || printf 'marketplace-v1-password' > secrets/db_password

docker compose up -d --wait
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE app_user WITH PASSWORD '$(cat secrets/db_password)';" >/dev/null

echo "Postgres is ready on :5433. Now, in another terminal:"
echo "  npm start                 # app on :3000"
echo "  curl -s localhost:3000/health"
echo "  bash rotate.sh             # rotate the password"
echo "  curl -s localhost:3000/health   # still works, same process, higher uptime"
