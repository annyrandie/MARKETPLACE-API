import type { Channel, ConsumeMessage } from 'amqplib';
import { Pool } from 'pg';
import { QUEUE } from './topology';
import { applyEffectOnce, logDelivery } from './effect';
import { OrderPlacedEvent } from './publisher';

export interface ConsumeOptions {
  /**
   * prefetch × time-to-process-one-message must stay well under
   * RabbitMQ's stock 30-minute consumer_timeout — see README for this
   * project's own number and why. The library default is 0 (no limit at
   * all: the first subscribed consumer on a prefetch of 0 claims the
   * whole queue, every other consumer starves) — this field has no
   * default here on purpose, so a caller can't forget to decide it.
   */
  prefetch: number;
  /** demo:dlq — detect a poison message and reject it instead of applying
   *  the effect, landing it in the DLQ via x-dead-letter-exchange. */
  isPoison?: (data: Record<string, unknown>) => boolean;
  /** demo:duplicate — simulate a process crash AFTER the effect commits
   *  but BEFORE the ack goes out, so RabbitMQ redelivers an event whose
   *  effect has already happened once. */
  crashAfterEffect?: boolean;
  /** Stop after this many messages have been delivered (demo scripts
   *  only — omit for a real long-running consumer). */
  stopAfter?: number;
}

export interface ConsumeSummary {
  delivered: number;
  effect: number;
  acked: number;
  rejected: number;
}

/**
 * The manual-ack consumer at the center of this whole HW: `noAck: false`,
 * and the `ack()` call happens strictly AFTER the effect has been
 * applied, never before — that ordering is the entire difference between
 * "work can vanish" (ack too early, then crash) and "work can duplicate"
 * (ack too late), and it's deliberately visible right here as one
 * sequential block, not split across callbacks where the order could
 * drift during a future edit.
 */
export function runConsumer(channel: Channel, pool: Pool, opts: ConsumeOptions): Promise<ConsumeSummary> {
  const summary: ConsumeSummary = { delivered: 0, effect: 0, acked: 0, rejected: 0 };

  return new Promise<ConsumeSummary>((resolve, reject) => {
    let settled = false;
    let consumerTag: string | undefined;
    const finish = (err?: unknown) => {
      if (settled) {
        // A message that slips in after `stopAfter` was already reached
        // (queue backlog, a race on the last delivery) would otherwise be
        // silently dropped here — neither acked, nacked, nor logged, and
        // left stuck on the channel until it closes. Not expected in any
        // of the demos, but a swallowed error is worse than a noisy one.
        if (err) console.error('[runConsumer] late error after stopAfter:', err);
        return;
      }
      settled = true;
      // Stop the broker from delivering anything further to THIS
      // consumer once we've seen enough — without this, the subscription
      // stays live on the channel for as long as the caller keeps it
      // open, even though nothing here will ever look at a message again.
      if (consumerTag) channel.cancel(consumerTag).catch(() => {});
      if (err) reject(err);
      else resolve(summary);
    };

    channel
      .prefetch(opts.prefetch)
      .then(() =>
        channel.consume(
          QUEUE,
          (msg: ConsumeMessage | null) => {
            if (!msg) return; // server cancelled this consumer
            handleMessage(msg).catch(finish);
          },
          { noAck: false },
        ),
      )
      .then((reply) => {
        consumerTag = reply.consumerTag;
      })
      .catch(finish);

    async function handleMessage(msg: ConsumeMessage): Promise<void> {
      const event: OrderPlacedEvent = JSON.parse(msg.content.toString('utf8'));
      // eslint-disable-next-line no-console
      console.error(`DELIVERED ${event.eventId}`);
      await logDelivery(pool, event.eventId, event.data.orderId);
      summary.delivered += 1;

      if (opts.isPoison?.(event.data)) {
        // requeue=false: straight to the DLX, reason "rejected" — not a
        // retry loop (that would be requeue=true, which is what
        // x-delivery-limit in topology.ts guards against instead).
        channel.reject(msg, false);
        // eslint-disable-next-line no-console
        console.error(`REJECTED ${event.eventId}`);
        summary.rejected += 1;
      } else {
        const isNew = await applyEffectOnce(pool, event.eventId, event.data.orderId);
        if (isNew) {
          summary.effect += 1;
          // eslint-disable-next-line no-console
          console.error(`EFFECT ${event.eventId}`);
        }

        if (opts.crashAfterEffect) {
          // eslint-disable-next-line no-console
          console.error(`CRASHING ${event.eventId}`);
          process.kill(process.pid, 'SIGKILL'); // never returns
          return;
        }

        channel.ack(msg);
        summary.acked += 1;
        // eslint-disable-next-line no-console
        console.error(`ACKED ${event.eventId}`);
      }

      if (opts.stopAfter && summary.delivered >= opts.stopAfter) finish();
    }
  });
}
