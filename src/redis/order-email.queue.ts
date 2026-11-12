import { Job, Queue, Worker, type DefaultJobOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { OrderPlacedEvent } from '../events/publisher';

// Work that has no business inside the HTTP request: the order
// confirmation email for HW #22's order.placed event, plus a periodic
// digest. Lives on the QUEUE Redis box (noeviction) — on the LRU box a
// waiting job could simply be evicted.
export const ORDER_EMAIL_QUEUE = 'order-email';
export const CONFIRMATION_JOB = 'order-confirmation';
export const DIGEST_JOB = 'pending-orders-digest';
export const DIGEST_SCHEDULER_ID = 'pending-orders-digest';

export const ORDER_EMAIL_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 4,
  // 500ms, 1s, 2s (each ±50%): a flapping SMTP gets room to recover, and
  // jitter keeps a batch that failed together from retrying together.
  backoff: { type: 'exponential', delay: 500, jitter: 0.5 },
  // NOT `true`: a removed job no longer counts as a duplicate, so jobId
  // dedup would silently stop working. Keep completed jobs well past the
  // window a duplicate can arrive in (the relay's redelivery is seconds;
  // a day is generous), and bounded by count.
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface ConfirmationJobData {
  orderId: string;
  userId: string | null;
  totalCents: number;
  /** demo:queue only — fail this many attempts first (a flaky SMTP). */
  simulateFailures?: number;
}

/** jobId from the event's own id: the relay is at-least-once (HW #22), so
 *  the same order.placed can arrive twice — and two add()s with one jobId
 *  are one job. BullMQ forbids ':' in custom ids, hence the swap. */
export function confirmationJobId(event: OrderPlacedEvent): string {
  return `confirm-${event.eventId.replace(/:/g, '-')}`;
}

export function createOrderEmailQueue(connection: Redis, prefix?: string): Queue {
  return new Queue(ORDER_EMAIL_QUEUE, { connection, prefix, defaultJobOptions: ORDER_EMAIL_JOB_OPTIONS });
}

export function enqueueOrderConfirmation(queue: Queue, event: OrderPlacedEvent, extra: Partial<ConfirmationJobData> = {}) {
  const data: ConfirmationJobData = {
    orderId: event.data.orderId,
    userId: event.data.userId,
    totalCents: event.data.totalCents,
    ...extra,
  };
  return queue.add(CONFIRMATION_JOB, data, { jobId: confirmationJobId(event) });
}

/** upsert, not add: re-running this on every boot updates the one
 *  scheduler in place instead of stacking a new one per restart. */
export function upsertDigestScheduler(queue: Queue, everyMs: number) {
  return queue.upsertJobScheduler(
    DIGEST_SCHEDULER_ID,
    { every: everyMs },
    { name: DIGEST_JOB, data: {}, opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
  );
}

export interface ProcessorHooks {
  /** Called at the start of every execution (incl. retries). */
  onAttempt?: (job: Job) => void;
}

export async function processOrderEmail(job: Job, hooks: ProcessorHooks = {}): Promise<string> {
  hooks.onAttempt?.(job);
  switch (job.name) {
    case CONFIRMATION_JOB: {
      const data = job.data as ConfirmationJobData;
      // attemptsMade = attempts that already FAILED before this one
      if (job.attemptsMade < (data.simulateFailures ?? 0)) {
        throw new Error(`SMTP 503 (simulated), attempt ${job.attemptsMade + 1}`);
      }
      // a real mailer goes here; the side effect must be idempotent on
      // job.id (a worker can die after sending, before completing)
      return `confirmation for order ${data.orderId} sent to user ${data.userId}`;
    }
    case DIGEST_JOB:
      return `digest at ${new Date().toISOString()}`;
    default:
      throw new Error(`unknown job ${job.name}`);
  }
}

/** The worker needs a `maxRetriesPerRequest: null` connection
 *  (createWorkerRedis) — see connections.ts. */
export function createOrderEmailWorker(connection: Redis, opts: { prefix?: string; concurrency?: number; hooks?: ProcessorHooks } = {}) {
  return new Worker(ORDER_EMAIL_QUEUE, (job) => processOrderEmail(job, opts.hooks), {
    connection,
    prefix: opts.prefix,
    concurrency: opts.concurrency ?? 5,
  });
}
