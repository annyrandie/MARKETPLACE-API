import type { Pool } from 'pg';
import type { Channel, ConsumeMessage } from 'amqplib';
import { INVOICING_QUEUE } from '../events/topology';
import type { OrderPlacedEvent } from '../events/publisher';

export const CONSUMER_NAME = 'invoicing';

export type DeliveryOutcome = 'applied' | 'duplicate';

export interface InvoicingConsumerOptions {
  prefetch: number;
  /** Called after every handled delivery (post-COMMIT, post-ack) — the
   *  demos count deliveries/applied through this, per their own orders. */
  onDelivery?: (event: OrderPlacedEvent, outcome: DeliveryOutcome) => void;
}

/**
 * The effect of one order.placed delivery, made safe to repeat twice over:
 *
 * - level 2 (inbox): claim (message_id, consumer) in processed_messages
 *   with ON CONFLICT DO NOTHING — 0 rows back means "already processed",
 *   skip the effect.
 * - level 1 (natural key): the effect itself is `INSERT … ON CONFLICT
 *   (order_id) DO NOTHING` — one invoice per order, never a counter a
 *   replay would bump twice. Redundant behind level 2 on purpose: it still
 *   holds if the inbox is ever bypassed (a replay tool, a second consumer
 *   name writing the same table).
 *
 * Both in ONE transaction on one client: a mark in one place and the
 * effect in another (Redis + Postgres, or two Postgres transactions) is
 * the dual write all over again, just moved to the consumer.
 */
export async function handleOrderPlaced(pool: Pool, event: OrderPlacedEvent): Promise<DeliveryOutcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mark = await client.query(
      `INSERT INTO processed_messages (message_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [event.eventId, CONSUMER_NAME],
    );
    let outcome: DeliveryOutcome = 'duplicate';
    if (mark.rowCount === 1) {
      const effect = await client.query(
        `INSERT INTO order_invoices (order_id, user_id, total_cents) VALUES ($1, $2, $3)
         ON CONFLICT (order_id) DO NOTHING`,
        [event.data.orderId, event.data.userId, event.data.totalCents],
      );
      if (effect.rowCount === 1) outcome = 'applied';
    }
    await client.query('COMMIT');
    return outcome;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Manual ack, strictly after the COMMIT above — never before. Returns the
 *  consumer tag so the caller can cancel it. */
export async function runInvoicingConsumer(
  channel: Channel,
  pool: Pool,
  opts: InvoicingConsumerOptions,
): Promise<string> {
  await channel.prefetch(opts.prefetch);
  const { consumerTag } = await channel.consume(
    INVOICING_QUEUE,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      let event: OrderPlacedEvent;
      try {
        event = JSON.parse(msg.content.toString('utf8'));
      } catch {
        channel.reject(msg, false); // unparseable → DLQ, not a requeue loop
        return;
      }
      handleOrderPlaced(pool, event)
        .then((outcome) => {
          channel.ack(msg);
          opts.onDelivery?.(event, outcome);
        })
        .catch((err) => {
          console.error(`[invoicing] ${event.eventId} failed, requeueing:`, err instanceof Error ? err.message : err);
          // Transient DB trouble → try again; x-delivery-limit on the
          // queue dead-letters it if it never succeeds.
          channel.nack(msg, false, true);
        });
    },
    { noAck: false },
  );
  return consumerTag;
}
