// npm run demo:crash-relay — side (b), the heart of HW #22: the SERVICE
// write fails. A relay child process publishes the event, gets the
// broker's confirm, and is `kill -9`ed right before `UPDATE published_at`.
// Its Postgres session dies with the transaction open → rollback →
// published_at is still NULL → the next relay pass publishes the SAME row
// again. Two deliveries of one event; the consumer's inbox + natural key
// turn that into one effect. At-least-once delivery + idempotent effect =
// exactly-once result.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkout } from '../checkout';
import { relayOnce, drainOutbox } from './relay';
import { openDemo, waitFor, finish } from './demo-kit';

const RELAY_WORKER = path.resolve(__dirname, 'relay-worker.js');

function runCrashingRelay(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_WORKER, '--once', '--crash-after-publish'], {
      env: process.env,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('crashing relay did not exit within 15s'));
    }, 15000);
    child.on('exit', (_code, signal) => {
      clearTimeout(timer);
      resolve(signal);
    });
  });
}

async function main(): Promise<void> {
  const demo = await openDemo('demo-crash-relay');

  // Move any unrelated backlog (e.g. demo:race's orders) out first, so the
  // crashing relay's batch is exactly this demo's one row.
  await drainOutbox(demo.pool, demo.publishChannel);

  const { orderId } = await checkout(demo.ds, demo.userId, demo.productId, 1, {
    idempotencyKey: `${demo.keyPrefix}${Date.now()}`,
  });

  // 1st publish: the child dies between publish and UPDATE.
  const signal = await runCrashingRelay();
  await waitFor(() => demo.seen.deliveries >= 1, 10000);

  // 2nd publish: a healthy relay pass (in this process). Retried in a loop
  // because the dead child's session may take a moment to be torn down —
  // until then SKIP LOCKED correctly skips the still-locked row.
  const republished = await waitFor(async () => {
    await relayOnce(demo.pool, demo.publishChannel, { batchSize: 50 });
    const { rows } = await demo.pool.query(
      `SELECT published_at IS NOT NULL AS done FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`,
      [orderId],
    );
    return rows[0]?.done === true;
  }, 10000);
  await waitFor(() => demo.seen.deliveries >= 2, 10000);
  await new Promise((r) => setTimeout(r, 300)); // let any further copy surface

  const {
    rows: [{ attempts }],
  } = await demo.pool.query(`SELECT attempts FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`, [
    orderId,
  ]);
  const c = await demo.counts();
  await demo.close();

  finish(
    {
      'relay-killed': signal === 'SIGKILL' ? 1 : 0,
      published: c.published,
      'outbox-attempts': attempts,
      deliveries: demo.seen.deliveries,
      applied: demo.seen.applied,
      duplicates: demo.seen.duplicates,
      effect: c.effect,
      processed: c.processed,
    },
    {
      'relay child really died of SIGKILL': signal === 'SIGKILL',
      'row republished after the crash': republished,
      'published=1': c.published === 1,
      'deliveries>=2': demo.seen.deliveries >= 2,
      'applied=1': demo.seen.applied === 1,
      'effect=1': c.effect === 1,
      'processed=1': c.processed === 1,
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
