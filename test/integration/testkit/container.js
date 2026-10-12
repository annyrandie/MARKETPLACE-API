// Один викрик = один СПРАВЖНІЙ Postgres у Docker (postgres:16-alpine,
// testcontainers сам обирає вільний хост-порт і сам прибирає контейнер
// через ryuk, навіть якщо тест упав). Схему будує НЕ hand-rolled DDL, а ті
// самі міграції, якими продакшн-код цього проєкту й будує свою БД
// (src/migrations/*.ts, HW #13/#14) — скомпільовані тим самим `tsc`, що й
// решта src/ (звідси `npm run build &&` у package.json's test:integration).
// Тестує це реальний data layer, а не окрему копію схеми, яка може розійтись
// з тим, що насправді деплоїться.
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '../../../dist/migrations');

/**
 * Every `dist/migrations/*.js` file, in the same order TypeORM's own
 * `migrations: ['dist/migrations/*.js']` glob (src/data-source.ts) applies
 * them — filenames are a fixed-width timestamp prefix, so lexicographic
 * sort already is chronological order. Discovering them by directory
 * listing, rather than naming two specific migration classes here, is the
 * whole point: a HW #17+ migration that `npm run migrate` picks up
 * automatically must not need this file edited too, or the test schema
 * silently drifts from what production actually runs.
 */
function loadMigrationClasses() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      const MigrationClass = Object.values(mod).find((v) => typeof v === 'function');
      if (!MigrationClass) throw new Error(`No migration class exported from ${f}`);
      return MigrationClass;
    });
}

/**
 * TypeORM migration classes only ever call `queryRunner.query(sql, params)`
 * in this project (no other QueryRunner feature is used) — so a plain pg
 * Client wrapped in this one-method shim is a real, if minimal, QueryRunner
 * for the purpose of running them. Avoids pulling in a full TypeORM
 * DataSource (and its own connection pool) just to apply two migrations.
 */
function asQueryRunner(client) {
  return { query: (sql, params) => client.query(sql, params) };
}

async function startPg() {
  const t0 = Date.now();
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const startupMs = Date.now() - t0;
  const uri = container.getConnectionUri();

  // ONE pool for both migrations and the handle returned below — a second,
  // throwaway `new Pool(...).connect()` just for migrations (never `.end()`ed
  // because nothing holds a reference to it) leaves an idle connection open
  // that outlives this function; when `container.stop()` later kills
  // Postgres, that orphaned connection receives "terminating connection due
  // to administrator command" with no error handler listening, and jest
  // reports "Unhandled error" even though every assertion already passed.
  const pool = new Pool({ connectionString: uri });
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[testkit] pool recovered from a dropped connection (${err.code})`);
  });

  const migrationClient = await pool.connect();
  try {
    const runner = asQueryRunner(migrationClient);
    for (const MigrationClass of loadMigrationClasses()) {
      await new MigrationClass().up(runner);
    }
  } finally {
    migrationClient.release();
  }

  // eslint-disable-next-line no-console
  console.log(`[testkit] postgres:16-alpine готовий за ${startupMs} ms -> ${uri}`);

  return {
    container,
    pool,
    uri,
    startupMs,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

module.exports = { startPg };
