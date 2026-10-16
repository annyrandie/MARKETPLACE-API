import { Channel, ConfirmChannel } from 'amqplib';

// Topic exchange for the whole domain, one queue per event this service
// actually consumes — a new event type later (HW #22+) is a new queue +
// binding, never a reason to touch what's already here.
export const EXCHANGE = 'shop.events';
export const ROUTING_KEY = 'order.placed';
export const QUEUE = 'order.placed';

export const DLX_EXCHANGE = 'shop.events.dlx';
export const DLQ = 'order.placed.dlq';

// Hint #2's cheapest default against a routing key with no binding ever
// matching: a publish like that still gets a positive confirm (the
// broker's job was only to route or discard correctly, and discarding
// correctly is what it did) — the message itself just vanishes. An
// alternate exchange catches anything `shop.events` can't route instead
// of silently dropping it.
export const ALTERNATE_EXCHANGE = 'shop.events.unroutable';
export const ALTERNATE_QUEUE = 'shop.events.unroutable';

/**
 * Declared by the consumer/bootstrap side, never by the publisher —
 * publishing code only ever needs an exchange name and a routing key; it
 * has no business knowing who, if anyone, is listening (requirement #1).
 * Idempotent: safe to call on every process start.
 *
 * Quorum, not classic, for the work queue: `x-delivery-limit` (one of the
 * four legal dead-letter reasons) only exists on quorum queues, and
 * classic mirroring (ha-mode) was removed in RabbitMQ 4.0 anyway, so
 * quorum is the only durably-replicated option left for a real queue.
 */
export async function assertTopology(channel: Channel | ConfirmChannel): Promise<void> {
  await channel.assertExchange(ALTERNATE_EXCHANGE, 'fanout', { durable: true });
  await channel.assertQueue(ALTERNATE_QUEUE, { durable: true });
  await channel.bindQueue(ALTERNATE_QUEUE, ALTERNATE_EXCHANGE, '');

  await channel.assertExchange(EXCHANGE, 'topic', {
    durable: true,
    arguments: { 'alternate-exchange': ALTERNATE_EXCHANGE },
  });
  await channel.assertExchange(DLX_EXCHANGE, 'topic', { durable: true });

  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX_EXCHANGE, ROUTING_KEY);

  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DLX_EXCHANGE,
      'x-dead-letter-routing-key': ROUTING_KEY,
      // Defense in depth, not what demo:dlq demonstrates (that one uses an
      // explicit reject — see src/events/consumer.ts) — a message that
      // somehow loops via requeue=true still hits a hard ceiling instead
      // of warming the cluster forever.
      'x-delivery-limit': 5,
    },
  });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
}
