// npm run queue:worker — the order-email BullMQ worker as its own process.
// Upserts the digest scheduler on every boot (upsert: N restarts still
// leave ONE scheduler) and closes gracefully on SIGTERM/SIGINT, so an
// in-flight job finishes instead of being left to the stalled-job check.
import { createStateRedis, createWorkerRedis, readMemoryConfig } from './connections';
import { createOrderEmailQueue, createOrderEmailWorker, upsertDigestScheduler } from './order-email.queue';

const DIGEST_EVERY_MS = Number(process.env.DIGEST_EVERY_MS ?? 60 * 60 * 1000);
const CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY ?? 5);

async function main(): Promise<void> {
  const queueRedis = createStateRedis();
  const { policy } = await readMemoryConfig(queueRedis);
  if (policy !== null && policy !== 'noeviction') {
    // BullMQ prints its own warning too — but refusing to start is louder
    // than a log line nobody reads.
    throw new Error(`REDIS_QUEUE_URL points at a box with maxmemory-policy=${policy}; the queue needs noeviction`);
  }

  const queue = createOrderEmailQueue(queueRedis);
  await upsertDigestScheduler(queue, DIGEST_EVERY_MS);

  const worker = createOrderEmailWorker(createWorkerRedis(), { concurrency: CONCURRENCY });
  worker.on('completed', (job, result) => console.error(`DONE ${job.name} ${job.id}: ${result}`));
  worker.on('failed', (job, err) =>
    console.error(`FAIL ${job?.name} ${job?.id} (attempt ${job?.attemptsMade}/${job?.opts.attempts}): ${err.message}`),
  );
  console.error(`order-email worker up (concurrency=${CONCURRENCY}, digest every ${DIGEST_EVERY_MS}ms)`);

  const stop = async () => {
    await worker.close();
    await queue.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((err) => {
  console.error('queue-worker failed:', err);
  process.exit(1);
});
