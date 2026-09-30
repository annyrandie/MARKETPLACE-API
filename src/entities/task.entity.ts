import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type TaskStatus = 'pending' | 'done';

// A durable job queue, not an in-memory one — checkout() inserts a row here
// in the SAME transaction as the order (so a post-processing task can never
// exist for an order that didn't actually commit, and never fail to exist
// for one that did). src/demo-workers.ts drains it via
// `FOR UPDATE SKIP LOCKED`, which is the whole reason this is a table and
// not, say, an array in the process.
@Entity('job_queue')
export class Task {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 50, name: 'kind' })
  kind: string;

  @Column({ type: 'jsonb', name: 'payload' })
  payload: Record<string, unknown>;

  @Index()
  @Column({ type: 'varchar', length: 20, name: 'status', default: 'pending' })
  status: TaskStatus;

  // Should end at exactly 1 for every task once a worker pool has drained
  // the queue — that's the "processed exactly once" proof SKIP LOCKED is
  // supposed to deliver. >1 means two workers claimed the same row.
  @Column({ type: 'int', name: 'processed_count', default: 0 })
  processedCount: number;

  @Column({ type: 'varchar', length: 50, name: 'worker_id', nullable: true })
  workerId: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt: Date | null;
}
