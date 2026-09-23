#!/usr/bin/env bash
# Wraps every command that needs to reach Postgres, so the npm scripts that
# call it stay unprefixed — `npm run migrate`, not something with a
# SKIP_VAULT= or a vault CLI baked into every invocation. The prefix lives
# once, here, inside package.json's script strings.
#
# HW #11's Infisical bonus was never attempted in this project. This
# project's actual "vault" is the file-based one HW #11 *did* build:
# DB_URL (host/port/user/db, deliberately no password) in .env, and the DB
# password in secrets/db_password, re-read on every new connection so it
# survives rotation without an app restart (see app.js). This script plays
# the exact role an `infisical run` wrapper would here: resolve secrets,
# export them as plain env vars, exec the wrapped command. Same contract,
# same escape hatch for a grader with no access to the vault, different
# backing store.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_SLUG="${1:-dev}"; shift || true

[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env" # not used by this project — see header comment; kept as the documented insertion landmark

if [ ! -f "$ROOT/.env" ]; then
  echo "✗ .env not found — run: cp .env.example .env" >&2
  exit 1
fi
set -a
source "$ROOT/.env"
set +a

if [ ! -f "$ROOT/$DB_PASSWORD_FILE" ]; then
  echo "✗ $DB_PASSWORD_FILE not found — run: npm run db:up" >&2
  exit 1
fi

# DB_URL is deliberately password-less (HW #11); split it into the discrete
# fields TypeORM's DataSource expects, the same way app.js already does for
# pg.Pool.
eval "$(node -e "
const u = new URL(process.env.DB_URL);
console.log('export DB_HOST=' + JSON.stringify(u.hostname));
console.log('export DB_PORT=' + JSON.stringify(u.port || '5432'));
console.log('export DB_USER=' + JSON.stringify(decodeURIComponent(u.username)));
console.log('export DB_NAME=' + JSON.stringify(u.pathname.slice(1)));
")"
export DB_PASSWORD
DB_PASSWORD="$(cat "$ROOT/$DB_PASSWORD_FILE")"

exec "$@"
