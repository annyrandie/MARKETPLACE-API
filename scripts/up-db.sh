#!/usr/bin/env bash
# Brings up Postgres and prepares the secret file. Safe to re-run: if the
# container/volume already existed (so init.sql did not re-run), it
# re-aligns the role's password with whatever is currently in the secret
# file — this is exactly the step you need after `docker compose down -v`,
# which resets Postgres to init.sql's password while the file may still hold
# a rotated one.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -f .env ]; then
  echo "✗ .env not found — run: cp .env.example .env" >&2
  exit 1
fi
set -a
source .env
set +a

mkdir -p secrets
[ -f secrets/db_password ] || printf 'marketplace-v1-password' > secrets/db_password

# The compose port mapping and the app's DB_URL must agree — derive one from
# the other instead of hardcoding the port a second time here.
DB_HOST_PORT="$(node -e "console.log(new URL(process.env.DB_URL).port || 5432)")"
export DB_HOST_PORT

docker compose up -d --wait
docker compose exec -T db psql -U admin -d marketplace \
  -c "ALTER ROLE app_user WITH PASSWORD '$(cat secrets/db_password)';" >/dev/null

echo "Postgres is ready on :${DB_HOST_PORT}. Now, in another terminal:"
echo "  npm start                 # app on :${PORT:-3000}"
echo "  curl -s localhost:${PORT:-3000}/health"
echo "  bash rotate.sh             # rotate the password"
echo "  curl -s localhost:${PORT:-3000}/health   # still works, same process, higher uptime"
