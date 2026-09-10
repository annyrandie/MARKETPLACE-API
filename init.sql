-- App role. The starting password matches what scripts/up-db.sh puts into
-- secrets/db_password. rotate.sh does NOT write this value — it always
-- generates a fresh app-<hex> password and overwrites both the role and the file.
CREATE ROLE app_user LOGIN PASSWORD 'marketplace-v1-password';
GRANT CONNECT ON DATABASE marketplace TO app_user;
