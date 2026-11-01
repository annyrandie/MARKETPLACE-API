import type { Pool } from 'pg';
import type { ConfirmChannel } from 'amqplib';
import { EXCHANGE } from '../events/topology';

export interface RelayOptions {
  batchSize: number;
  /** demo:crash-relay only — runs after the broker confirmed the batch and
   *  BEFORE `UPDATE published_at`: the exact gap that crash lives in. */
  afterPublish?: (ids: string[]) => Promise<void> | void;
}

interface OutboxRow {
  id: string;
  type: string;
  payload: { eventId: string };
}

/**
 * One relay pass: SELECT … FOR UPDATE SKIP LOCKED → publish → UPDATE
 * published_at, in that order, all inside ONE transaction on ONE pooled
 * client (`pool.connect()`, never `pool.query('BEGIN')` — that would send
 * BEGIN and COMMIT down two different connections).
 *
 * - SKIP LOCKED, not a bare FOR UPDATE: a second relay instance skips the
 *   rows this one holds instead of queueing behind it, so N relays
 *   actually work in parallel; the lock is what keeps them from
 *   publishing the same row at the same time.
 * - `published_at IS NULL`, not "id > last seen": a bigserial id is taken
 *   at nextval() but the row only becomes visible at COMMIT, so a lower id
 *   can show up AFTER a higher one was already relayed — a cursor on id
 *   would skip it forever.
 * - ORDER BY created_at, id is only the order rows are PICKED in — with
 *   several relays and SKIP LOCKED it's not a delivery-order guarantee.
 * - publish BEFORE marking: a crash in between publishes the row again on
 *   the next pass (a duplicate — the consumer's inbox absorbs it). The
 *   other order would mark first and lose the event on a failed publish,
 *   and a loss can't be deduplicated back into existence.
 */
export async function relayOnce(pool: Pool, channel: ConfirmChannel, opts: RelayOptions): Promise<number> {
  const client = await pool.connect();
  let ids: string[] = [];
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, type, payload
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at, id
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [opts.batchSize],
    );
    ids = rows.map((r) => r.id);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    for (const row of rows) {
      // routing key = the event type; payload goes out exactly as
      // checkout() stored it — the relay never re-shapes the contract.
      channel.publish(EXCHANGE, row.type, Buffer.from(JSON.stringify(row.payload)), {
        contentType: 'application/json',
        persistent: true,
        messageId: row.payload.eventId,
      });
    }
    // A plain publish only means "handed to our socket"; the confirm is
    // the broker saying it has the messages. Only then is marking safe.
    await channel.waitForConfirms();

    await opts.afterPublish?.(ids);

    await client.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1)`, [ids]);
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A failed publish is NOT proof nothing reached the broker (the
    // confirm itself could be what got lost) — the rows stay unpublished
    // and go out again next pass; the consumer dedups. Count the try so a
    // row that keeps failing is visible, outside the rolled-back tx.
    if (ids.length > 0) {
      await pool.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1)`, [ids]).catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Relay until nothing is left to pick — what the demos call between
 *  "write the order" and "count what arrived". */
export async function drainOutbox(pool: Pool, channel: ConfirmChannel, batchSize = 50): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await relayOnce(pool, channel, { batchSize });
    total += n;
    if (n === 0) return total;
  }
}
