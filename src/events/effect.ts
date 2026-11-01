import { Pool } from 'pg';

/**
 * Self-contained on purpose — no dependency on `npm run migrate` having
 * been run first (the demo scripts are meant to work from a bare
 * `docker compose up -d --wait`, see README's Grading section). Called
 * once at the start of every entry point in this module; `IF NOT EXISTS`
 * makes repeated calls free. `ADD COLUMN IF NOT EXISTS` on top of that so
 * a table left over from an earlier shape of this file still ends up
 * correct instead of silently missing a column `countDeliveries` below
 * depends on.
 */
export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_order_events (
      event_id    text PRIMARY KEY,
      order_id    text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Deliberately separate from the table above: this one records EVERY
  // delivery, duplicates included — it exists only so the demo scripts
  // can prove a redelivery actually happened (`deliveries >= 2`), not to
  // participate in the dedup decision itself (that's effect's job, and
  // only effect's).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_event_deliveries (
      id          bigserial PRIMARY KEY,
      event_id    text NOT NULL,
      order_id    text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE order_event_deliveries ADD COLUMN IF NOT EXISTS order_id text');
}

export async function logDelivery(pool: Pool, eventId: string, orderId: string): Promise<void> {
  await pool.query('INSERT INTO order_event_deliveries (event_id, order_id) VALUES ($1, $2)', [eventId, orderId]);
}

/**
 * The idempotent effect itself, expressed as the natural key it is —
 * `INSERT ... ON CONFLICT (event_id) DO NOTHING` — not `UPDATE ... SET
 * qty = qty - 1`, which a duplicate delivery would happily apply twice.
 * Returns true only for the delivery that actually inserted the row; a
 * later duplicate gets `false` back, not an error and not a second row.
 * Survives a consumer restart because it lives in Postgres, not in a
 * `Set` in the process's own memory (a dedup table that dies with the
 * process it runs in isn't a dedup table).
 */
export async function applyEffectOnce(pool: Pool, eventId: string, orderId: string): Promise<boolean> {
  const result = await pool.query(
    'INSERT INTO processed_order_events (event_id, order_id) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
    [eventId, orderId],
  );
  return (result.rowCount ?? 0) > 0;
}

// Both tables carry `order_id` verbatim (unlike `event_id`, which is
// `order.placed:<orderId>` — a demo's own orderId prefix, e.g.
// "demo-publish:...", only ever appears as a SUBSTRING of event_id, not
// at its start) — matching on order_id's own, unprefixed value is what
// makes a plain `LIKE '<prefix>%'` correct here.
export async function countEffect(pool: Pool, orderIdPrefix: string): Promise<number> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM processed_order_events WHERE order_id LIKE $1', [
    `${orderIdPrefix}%`,
  ]);
  return rows[0].n;
}

export async function countDeliveries(pool: Pool, orderIdPrefix: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM order_event_deliveries WHERE order_id LIKE $1',
    [`${orderIdPrefix}%`],
  );
  return rows[0].n;
}

/** Each demo "сам приводить стан до чистого" (requirement #7) — this is
 *  that step, scoped by this run's own orderId prefix so it never touches
 *  another demo's rows. */
export async function resetDemoState(pool: Pool, orderIdPrefix: string): Promise<void> {
  await pool.query('DELETE FROM processed_order_events WHERE order_id LIKE $1', [`${orderIdPrefix}%`]);
  await pool.query('DELETE FROM order_event_deliveries WHERE order_id LIKE $1', [`${orderIdPrefix}%`]);
}
