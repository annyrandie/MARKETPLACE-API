import { ConfirmChannel } from 'amqplib';
import { EXCHANGE, ROUTING_KEY } from './topology';

export interface OrderPlacedData {
  orderId: string;
  userId: string | null;
  totalCents: number;
  [key: string]: unknown;
}

export interface OrderPlacedEvent {
  eventId: string;
  type: 'order.placed';
  occurredAt: string;
  data: OrderPlacedData;
}

/**
 * A deliberately designed contract — eventId, type, occurredAt, data —
 * not an ORM entity spread onto the wire. `eventId` defaults to a
 * deterministic function of `orderId`, not a fresh random id per call:
 * the consumer recognizes a duplicate BY this value, so if the same
 * business operation ever publishes again for the same order (a retry,
 * an outbox replay in HW #22), it must produce the identical id, not a
 * new one that a dedup check would never have seen before.
 */
export function orderPlacedEventId(orderId: string): string {
  return `order.placed:${orderId}`;
}

/**
 * Published on a ConfirmChannel and awaited to completion
 * (`waitForConfirms`) — a plain `channel.publish()` only proves the
 * message reached this process's own socket buffer; the confirm is the
 * broker's own acknowledgement that it has the message. `mandatory`
 * would be the other half of "did it go anywhere at all" (see
 * topology.ts's alternate-exchange comment for why that's handled on the
 * exchange instead, once, rather than as a per-publish flag).
 */
export async function publishOrderPlaced(
  channel: ConfirmChannel,
  data: OrderPlacedData,
): Promise<OrderPlacedEvent> {
  const event: OrderPlacedEvent = {
    eventId: orderPlacedEventId(data.orderId),
    type: 'order.placed',
    occurredAt: new Date().toISOString(),
    data,
  };

  channel.publish(EXCHANGE, ROUTING_KEY, Buffer.from(JSON.stringify(event)), {
    contentType: 'application/json',
    persistent: true,
    messageId: event.eventId,
  });
  await channel.waitForConfirms();

  return event;
}
