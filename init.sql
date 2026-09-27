-- App role. The starting password matches what scripts/up-db.sh puts into
-- secrets/db_password. rotate.sh does NOT write this value — it always
-- generates a fresh app-<hex> password and overwrites both the role and the file.
CREATE ROLE app_user LOGIN PASSWORD 'marketplace-v1-password';
GRANT CONNECT ON DATABASE marketplace TO app_user;

-- HW #13: app_user is also the role TypeORM migrations run as (via
-- scripts/with-secrets.sh, the real vault path — see its header comment).
-- Postgres 15+ stopped granting CREATE on the public schema to PUBLIC by
-- default, so without this, `npm run migrate` fails with "permission
-- denied for schema public" the moment it tries its first CREATE TABLE —
-- caught by actually running the vault path locally, not assumed.
GRANT CREATE ON SCHEMA public TO app_user;
