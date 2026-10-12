import { Subject } from 'rxjs';

// One event bus, two transports: orders.gateway.ts (WebSocket) and
// orders.controller.ts (SSE) both subscribe to the SAME OrderEventsService
// instance, wired together once in app.js. Neither transport owns the
// buffer or the sequence counter — if it did, a client that only ever used
// one of the two transports would see a different event history than one
// using the other.
export interface OrderStatusEvent {
  id: number;
  orderId: string;
  status: string;
  createdAt: string;
}

// Demo-sized, not production-sized: enough events per order to answer a
// Last-Event-ID replay after a short reconnect, not a durable log. A real
// deployment would back this with something that survives a restart —
// exactly the seam Lecture 19's queue and Lecture 23's Redis plug into
// (see README).
const BUFFER_LIMIT = 200;

export class OrderEventsService {
  private readonly bus = new Subject<OrderStatusEvent>();
  private readonly buffers = new Map<string, OrderStatusEvent[]>();
  private readonly counters = new Map<string, number>();

  /** Called from the order-status business logic (app.js), never directly
   *  from a transport — see README's "Emit from business logic" note. */
  emitStatusChange(orderId: string, status: string): OrderStatusEvent {
    const nextId = (this.counters.get(orderId) ?? 0) + 1;
    this.counters.set(orderId, nextId);

    const event: OrderStatusEvent = { id: nextId, orderId, status, createdAt: new Date().toISOString() };

    const buffer = this.buffers.get(orderId) ?? [];
    buffer.push(event);
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
    this.buffers.set(orderId, buffer);

    this.bus.next(event);
    return event;
  }

  /** For SSE's Last-Event-ID replay: every buffered event for this order
   *  strictly newer than `lastEventId`. */
  getEventsSince(orderId: string, lastEventId: number): OrderStatusEvent[] {
    return (this.buffers.get(orderId) ?? []).filter((event) => event.id > lastEventId);
  }

  /** One order's live events — what the SSE handler subscribes to. */
  subscribe(orderId: string, listener: (event: OrderStatusEvent) => void): () => void {
    const subscription = this.bus.subscribe((event) => {
      if (event.orderId === orderId) listener(event);
    });
    return () => subscription.unsubscribe();
  }

  /** Every order's live events, unfiltered — what the WebSocket gateway
   *  subscribes to once, routing each event into its own `orders:<id>`
   *  room as it arrives, rather than one subscription per room. */
  onAny(listener: (event: OrderStatusEvent) => void): () => void {
    const subscription = this.bus.subscribe(listener);
    return () => subscription.unsubscribe();
  }
}
