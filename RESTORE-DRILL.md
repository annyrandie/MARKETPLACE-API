# Restore drill — HW #15

A backup nobody has restored is a lottery ticket, not a backup. This is the
record of actually restoring one, not just producing one.

## What was run

```bash
docker compose up -d --wait
export DB_HOST=127.0.0.1 DB_PORT=6432 DB_USER=admin DB_PASSWORD=admin-bootstrap-only DB_NAME=marketplace
export SKIP_VAULT=1
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## Result (2026-09-30)

| | |
|---|---|
| Date | 2026-09-30 |
| Dump file | `backups/marketplace_20260930_230705.dump` |
| Dump size | 20 KB (`pg_dump -Fc`, custom format, gzip-compressed) |
| Restore target | `postgres:16-alpine`, fresh container + fresh volume (`marketplace-api-restore-1` / `marketplace-api_pgdata-restore`), created and destroyed by the drill itself |
| Checksum before | `8|1369900` (`count(*)|sum(price_cents)` on `products`) |
| Checksum after | `8|1369900` — **MATCH** |
| Measured restore time (`pg_restore`) | 0.1 s |
| Re-run | Repeated immediately after — same MATCH, same cleanup, no leftover container/volume either time |

```
━━━ 1. Checksum on the live DB (through PgBouncer) ━━━
  products before: 8|1369900  (count|sum(price_cents))
━━━ 2. Clean restore target (profile: drill) ━━━
━━━ 3. pg_restore + checksum ━━━
  products after:  8|1369900
MATCH — restored data equals the live DB by checksum (0.1s)
```

## RTO (Recovery Time Objective)

**Measured, this drill: ~0.1 s for `pg_restore` itself** on a 20 KB dump —
too small to be a realistic production number on its own. The **operational
RTO** — what an on-call person actually experiences recovering this
database — is the sum of steps the drill script automates end to end:

1. Bring up a clean Postgres target (`docker compose up -d --wait restore`)
   — a few seconds for container start + healthcheck, dominated by Postgres
   init, not by data size.
2. `pg_restore --no-owner --no-acl` — **0.1 s** at current data volume;
   scales with data size and index count, not with step 1.
3. Point the app's `DB_URL` at the restored instance and restart it — not
   automated by this drill (out of scope for HW #15), adds the time to edit
   one env var and restart one process.

Honest total for *this* database's current size: **a few seconds**, almost
entirely step 1's container bring-up, not the restore itself. That ratio
inverts as the database grows — a production-sized dump is where
`pg_restore`'s own time, not container startup, would dominate.

## RPO (Recovery Point Objective)

**Up to 24 hours**, by construction: `backup.cron` runs `scripts/backup.sh`
once nightly (`0 3 * * *`). Worst case — a failure at 02:59, one minute
before that night's backup — loses very close to 24 hours of writes. Best
case — a failure at 03:01, one minute after — loses only that minute.
Nightly `pg_dump` is the RPO this HW's backup schedule actually buys;
tightening it further means WAL archiving + point-in-time recovery, not a
more frequent `pg_dump` (lecture 15's physical/`pg_basebackup` track,
deliberately out of scope here — see README's PgBouncer section for why
this HW stayed on the logical-backup side of that line).
