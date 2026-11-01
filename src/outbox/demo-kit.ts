// Shared plumbing for HW #22's three demos. Each demo gets its own `tag`,
// and every row it creates is reachable from that tag (its own buyer and
// product, its own Idempotency-Key prefix) — so "bring state back to
// clean" (requirement #6) deletes exactly the previous run of THIS demo,
// never seed data or another demo's rows.
import 'reflect-metadata';
import type { Pool } from 'pg';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import AppDataSource from '../data-source';
import { createDbPool } from '../events/db';
import { connectBroker } from '../events/connection';
import { assertTopology, INVOICING_QUEUE } from '../events/topology';
import { runInvoicingConsumer, CONSUMER_NAME } from './invoicing.consumer';

export interface Demo {
  pool: Pool;
  ds: typeof AppDataSource;
  publishChannel: ConfirmChannel;
  userId: string;
  productId: string;
  keyPrefix: string;
  /** deliveries / applied as seen by the in-process consumer, for THIS
   *  demo's buyer only (the relay may also move unrelated backlog). */
  seen: { deliveries: number; applied: number; duplicates: number };
  counts(): Promise<Record<'orders' | 'outbox' | 'published' | 'effect' | 'processed' | 'stock', number>>;
  close(): Promise<void>;
}

export const PRODUCT_STOCK = 10;

async function reset(pool: Pool, emailLike: string, keyLike: string, productMarker: string): Promise<void> {
  const users = `SELECT id FROM users WHERE email LIKE $1`;
  const orders = `SELECT id FROM orders WHERE user_id IN (${users})`;
  await pool.query(`DELETE FROM order_invoices WHERE user_id IN (${users})`, [emailLike]);
  await pool.query(`DELETE FROM processed_messages WHERE message_id IN (SELECT 'order.placed:' || id FROM (${orders}) o)`, [
    emailLike,
  ]);
  await pool.query(`DELETE FROM outbox WHERE payload->'data'->>'userId' IN (SELECT id::text FROM users WHERE email LIKE $1)`, [
    emailLike,
  ]);
  await pool.query(`DELETE FROM idempotency_keys WHERE user_id IN (${users}) OR key LIKE $2`, [emailLike, keyLike]);
  await pool.query(`DELETE FROM job_queue WHERE payload->>'userId' IN (SELECT id::text FROM users WHERE email LIKE $1)`, [
    emailLike,
  ]);
  await pool.query(`DELETE FROM order_items WHERE order_id IN (${orders})`, [emailLike]);
  await pool.query(`DELETE FROM orders WHERE user_id IN (${users})`, [emailLike]);
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [emailLike]);
  await pool.query(`DELETE FROM products WHERE description = $1`, [productMarker]);
}

export async function openDemo(tag: string): Promise<Demo> {
  const pool = createDbPool();
  const emailLike = `outbox-${tag}-%@example.test`;
  const keyPrefix = `${tag}:`;
  const productMarker = `outbox demo fixture: ${tag}`;
  await reset(pool, emailLike, `${keyPrefix}%`, productMarker);

  await AppDataSource.initialize();

  const runId = Date.now();
  const {
    rows: [user],
  } = await pool.query(
    `INSERT INTO users (email, full_name, balance_cents) VALUES ($1, 'Outbox Demo Buyer', 1000000) RETURNING id::text AS id`,
    [`outbox-${tag}-${runId}@example.test`],
  );
  const {
    rows: [product],
  } = await pool.query(
    `INSERT INTO products (name, description, price_cents, stock) VALUES ($1, $2, 2500, $3) RETURNING id::text AS id`,
    [`Outbox demo product (${tag})`, productMarker, PRODUCT_STOCK],
  );

  const connection: ChannelModel = await connectBroker();
  connection.on('error', (err) => console.error('[broker connection]', err.message));
  // Consumer side declares topology (the relay never does) and starts
  // from an empty queue, so leftovers of a crashed earlier run can't
  // count toward this one.
  const consumeChannel = await connection.createChannel();
  await assertTopology(consumeChannel);
  await consumeChannel.purgeQueue(INVOICING_QUEUE);
  const publishChannel = await connection.createConfirmChannel();

  const seen = { deliveries: 0, applied: 0, duplicates: 0 };
  await runInvoicingConsumer(consumeChannel, pool, {
    prefetch: 10,
    onDelivery: (event, outcome) => {
      if (event.data.userId !== user.id) return;
      seen.deliveries += 1;
      if (outcome === 'applied') seen.applied += 1;
      else seen.duplicates += 1;
      console.error(`${outcome.toUpperCase()} ${event.eventId}`);
    },
  });

  return {
    pool,
    ds: AppDataSource,
    publishChannel,
    userId: user.id,
    productId: product.id,
    keyPrefix,
    seen,
    async counts() {
      const q = async (sql: string, params: unknown[]) => Number((await pool.query(sql, params)).rows[0].n);
      const byUser = `payload->'data'->>'userId' = $1`;
      return {
        orders: await q(`SELECT count(*) AS n FROM orders WHERE user_id = $1`, [user.id]),
        outbox: await q(`SELECT count(*) AS n FROM outbox WHERE ${byUser}`, [user.id]),
        published: await q(`SELECT count(*) AS n FROM outbox WHERE ${byUser} AND published_at IS NOT NULL`, [user.id]),
        effect: await q(`SELECT count(*) AS n FROM order_invoices WHERE user_id = $1`, [user.id]),
        processed: await q(
          `SELECT count(*) AS n FROM processed_messages
            WHERE consumer = $2
              AND message_id IN (SELECT 'order.placed:' || id FROM orders WHERE user_id = $1)`,
          [user.id, CONSUMER_NAME],
        ),
        stock: await q(`SELECT stock AS n FROM products WHERE id = $1`, [product.id]),
      };
    },
    async close() {
      await connection.close();
      await AppDataSource.destroy();
      await pool.end();
    },
  };
}

/** Poll until `done()` or the deadline — a stalled run fails loudly with
 *  its numbers instead of hanging. Returns whether `done()` became true. */
export async function waitFor(done: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return done();
}

/** Print key=number lines, check the invariant, exit accordingly. */
export function finish(summary: Record<string, number>, invariant: Record<string, boolean>): never {
  for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);
  const broken = Object.entries(invariant)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  if (broken.length > 0) {
    console.error(`✗ invariant violated: ${broken.join(', ')}`);
    process.exit(1);
  }
  console.error('✓ invariant holds');
  process.exit(0);
}
