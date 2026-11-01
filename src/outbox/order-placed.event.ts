import { OrderPlacedEvent, orderPlacedEventId } from '../events/publisher';

/** What checkout() knows about the order it just wrote — its own shape,
 *  not the ORM entity, so a column rename can't leak onto the wire. */
export interface PlacedOrder {
  id: string;
  userId: string;
  productId: string;
  quantity: number;
  totalCents: number;
  createdAt: Date;
}

/**
 * The one mapping from "an order we committed" to the public event
 * contract (the same envelope HW #19 designed: eventId, type, occurredAt,
 * data). Stored verbatim as the outbox row's payload and published
 * verbatim by the relay — nobody downstream ever sees `orders` columns.
 * eventId is a function of the order, not random, so every redelivery of
 * this row carries the same id the consumer's inbox dedups by.
 */
export function toOrderPlacedEvent(order: PlacedOrder): OrderPlacedEvent {
  return {
    eventId: orderPlacedEventId(order.id),
    type: 'order.placed',
    occurredAt: order.createdAt.toISOString(),
    data: {
      orderId: order.id,
      userId: order.userId,
      totalCents: order.totalCents,
      productId: order.productId,
      quantity: order.quantity,
    },
  };
}
