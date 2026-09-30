// ≥2 workers (Promise-based, one process) drain a batch of tasks from
// job_queue via `FOR UPDATE SKIP LOCKED`. Each task is processed exactly
// once — SKIP LOCKED means a worker that finds every unclaimed row already
// locked moves on instead of queueing behind it, so no two workers can ever
// grab the same row.
import 'reflect-metadata';
import AppDataSource from './data-source';
import { Task } from './entities/task.entity';
import { sleep } from './lib/concurrency';

const TASK_COUNT = 40;
const WORKER_COUNT = 4; // ≥ 2, required by the assignment
const SIMULATED_WORK_MS = 30;

/** One claim-and-process cycle, scoped to THIS run's own task ids so a
 *  concurrent demo:race (or a previous demo:workers run's leftovers)
 *  never gets mixed into the count. */
async function claimOne(workerId: string, taskIds: string[]): Promise<'processed' | 'empty'> {
  return AppDataSource.transaction(async (manager) => {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT id FROM job_queue
       WHERE status = 'pending' AND id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [taskIds],
    );
    if (rows.length === 0) return 'empty';

    const taskId = rows[0].id;
    await sleep(SIMULATED_WORK_MS); // the "work" — held for the whole transaction, same as the lock

    await manager.query(
      `UPDATE job_queue
       SET status = 'done', processed_count = processed_count + 1, worker_id = $2, processed_at = now()
       WHERE id = $1`,
      [taskId, workerId],
    );
    return 'processed';
  });
}

async function worker(workerId: string, taskIds: string[], counts: Map<string, number>): Promise<void> {
  // An 'empty' result means "nothing UNLOCKED right now", not "queue is
  // done" — a few consecutive empties (everyone else still mid-task) are
  // expected. Only conclude the queue is drained after checking for real.
  let consecutiveEmpty = 0;
  for (;;) {
    const result = await claimOne(workerId, taskIds);
    if (result === 'processed') {
      consecutiveEmpty = 0;
      counts.set(workerId, (counts.get(workerId) ?? 0) + 1);
      continue;
    }
    consecutiveEmpty += 1;
    const remaining: Array<{ count: string }> = await AppDataSource.query(
      `SELECT count(*) FROM job_queue WHERE status = 'pending' AND id = ANY($1::bigint[])`,
      [taskIds],
    );
    if (Number(remaining[0].count) === 0) return; // actually empty — done
    if (consecutiveEmpty > 20) {
      // Should never trigger — if it does, tasks are still pending but this
      // worker has given up seeing them (stuck lock, bug, etc). Surfacing
      // that as a thrown error (not a quiet return) is the whole point: a
      // silent return here would exit 0 while work is left undone.
      throw new Error(
        `${workerId}: gave up after ${consecutiveEmpty} empty polls with pending tasks still remaining`,
      );
    }
    await sleep(10);
  }
}

async function main(): Promise<void> {
  await AppDataSource.initialize();

  const taskRepo = AppDataSource.getRepository(Task);
  const tasks = await taskRepo.save(
    Array.from({ length: TASK_COUNT }, (_, i) => taskRepo.create({ kind: 'demo.work', payload: { n: i } })),
  );
  const taskIds = tasks.map((t) => t.id);

  console.log(`Seeded ${TASK_COUNT} tasks, ${SIMULATED_WORK_MS}ms of simulated work each.`);
  console.log(`Ideal parallel time: ${(TASK_COUNT / WORKER_COUNT) * SIMULATED_WORK_MS}ms · sequential: ${TASK_COUNT * SIMULATED_WORK_MS}ms`);

  const counts = new Map<string, number>();
  const start = Date.now();
  await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_, i) => `worker-${i + 1}`).map((id) => worker(id, taskIds, counts)),
  );
  const elapsedMs = Date.now() - start;

  const doubleProcessedRows: Array<{ count: string }> = await AppDataSource.query(
    `SELECT count(*) FROM job_queue WHERE id = ANY($1::bigint[]) AND processed_count <> 1`,
    [taskIds],
  );
  const doubleProcessed = Number(doubleProcessedRows[0].count);

  const distribution = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([w, n]) => `${w}=${n}`)
    .join(', ');

  console.log(`Distribution: ${distribution}`);
  console.log(`Processed twice (or not exactly once): ${doubleProcessed}`);
  console.log(`Elapsed: ${elapsedMs}ms (sequential estimate: ${TASK_COUNT * SIMULATED_WORK_MS}ms)`);

  const sequentialEstimateMs = TASK_COUNT * SIMULATED_WORK_MS;
  const ok = doubleProcessed === 0 && elapsedMs < sequentialEstimateMs;

  await AppDataSource.destroy();

  if (!ok) {
    console.error('✗ Invariant violated — either a task was processed more than once, or workers gave no parallel speedup.');
    process.exit(1);
  }
  console.log(`✓ Every task processed exactly once, across ${WORKER_COUNT} workers, faster than sequential.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
