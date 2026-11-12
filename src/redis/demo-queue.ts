// npm run demo:queue — BullMQ on the noeviction box: retries with
// exponential backoff + jitter, jobId dedup, and a job scheduler.
//
// 1. CONFIG GET on the queue connection → queue-noeviction;
// 2. the same order.placed event enqueued twice (what an at-least-once
//    relay does) → added=2, queued=1;
// 3. upsertJobScheduler called twice (a "restart") → still one scheduler;
// 4. the worker starts: the confirmation job fails twice (flaky SMTP),
//    succeeds on attempt 3; the scheduler fires every SCHEDULE_MS.
// Runs under its own Redis key prefix and obliterates it before and after
// — it never touches the real `order-email` queue.
import type { Job } from 'bullmq';
import { finish, waitFor } from '../outbox/demo-kit';
import { toOrderPlacedEvent } from '../outbox/order-placed.event';
import { createStateRedis, createWorkerRedis, readMemoryConfig } from './connections';
import {
  CONFIRMATION_JOB,
  DIGEST_JOB,
  DIGEST_SCHEDULER_ID,
  confirmationJobId,
  createOrderEmailQueue,
  createOrderEmailWorker,
  enqueueOrderConfirmation,
  upsertDigestScheduler,
} from './order-email.queue';

const PREFIX = 'bull-demo';
const SIMULATED_FAILURES = 2;
const SCHEDULE_MS = 500;
const MIN_SCHEDULED_RUNS = 3;
const TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  const queueRedis = createStateRedis();
  const workerRedis = createWorkerRedis();
  const queue = createOrderEmailQueue(queueRedis, PREFIX);
  await queue.obliterate({ force: true });

  const mem = await readMemoryConfig(queueRedis);
  console.error(`queue box: maxmemory-policy=${mem.policy}`);

  const event = toOrderPlacedEvent({
    id: '900001',
    userId: '42',
    productId: '7',
    quantity: 1,
    totalCents: 2500,
    createdAt: new Date(),
  });
  const jobId = confirmationJobId(event);

  let summary: Record<string, number>;
  const seen = { attempts: 0, completed: 0, scheduledRuns: 0 };
  let worker: ReturnType<typeof createOrderEmailWorker> | undefined;
  try {
    // 2. at-least-once upstream: the same event, twice
    const first = await enqueueOrderConfirmation(queue, event, { simulateFailures: SIMULATED_FAILURES });
    const second = await enqueueOrderConfirmation(queue, event, { simulateFailures: SIMULATED_FAILURES });
    const queued = await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized', 'active');
    console.error(`add #1 → ${first.id}, add #2 → ${second.id}`);

    // 3. two boots, one scheduler
    await upsertDigestScheduler(queue, SCHEDULE_MS);
    await upsertDigestScheduler(queue, SCHEDULE_MS);
    const schedulers = (await queue.getJobSchedulers()).length;

    // 4. worker
    worker = createOrderEmailWorker(workerRedis, {
      prefix: PREFIX,
      hooks: {
        onAttempt: (job: Job) => {
          if (job.id === jobId) {
            seen.attempts += 1;
            console.error(`attempt ${seen.attempts} of ${job.id}`);
          }
        },
      },
    });
    worker.on('failed', (job, err) => job?.id === jobId && console.error(`  failed: ${err.message}`));
    worker.on('completed', (job) => {
      if (job.name === CONFIRMATION_JOB && job.id === jobId) seen.completed += 1;
      if (job.name === DIGEST_JOB) seen.scheduledRuns += 1;
    });

    const started = Date.now();
    await waitFor(() => seen.completed >= 1 && seen.scheduledRuns >= MIN_SCHEDULED_RUNS, TIMEOUT_MS);
    console.error(`observed for ${Date.now() - started}ms`);

    summary = {
      'queue-noeviction': mem.policy === 'noeviction' ? 1 : 0,
      added: 2,
      'same-job': first.id === second.id ? 1 : 0,
      queued,
      schedulers,
      attempts: seen.attempts,
      completed: seen.completed,
      'scheduled-runs': seen.scheduledRuns,
    };
  } finally {
    await queue.removeJobScheduler(DIGEST_SCHEDULER_ID).catch(() => {});
    await worker?.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await queueRedis.quit();
    await workerRedis.quit();
  }

  finish(summary, {
    'queue box is noeviction': summary['queue-noeviction'] === 1,
    'jobId dedup: two adds, one job': summary.queued === 1 && summary['same-job'] === 1,
    'upsert keeps one scheduler': summary.schedulers === 1,
    'retried, then completed once': summary.attempts === SIMULATED_FAILURES + 1 && summary.completed === 1,
    'scheduler fired repeatedly': summary['scheduled-runs'] >= 2,
  });
}

main().catch((err) => {
  console.error('demo:queue failed:', err);
  process.exit(1);
});
