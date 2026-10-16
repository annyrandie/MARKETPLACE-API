// HW #18's requested `orders.controller.ts` — Express has no decorator
// controller class (no Nest here, see orders.gateway.ts's header comment),
// so this exports a route-handler FACTORY instead, mounted directly in
// app.js's own router the same way every other route there is. Untyped
// `req`/`res` params deliberately: adding `@types/express` just for two
// parameter annotations isn't worth a new dependency in a project where
// the route's own home (app.js) is plain, untyped JS anyway.
import { OrderEventsService, OrderStatusEvent } from './order-events.service';
import { OrderLookup } from './orders.gateway';

export function createOrderEventsSseHandler(events: OrderEventsService, getOrder: OrderLookup) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req: any, res: any): void => {
    const { orderId } = req.params;
    const order = getOrder(orderId);
    if (!order) {
      res.status(404).end();
      return;
    }
    // Ownership is enforced only when the order actually HAS an owner.
    // An order created without X-User-Id (POST /orders never required it,
    // before or after this HW) is already fully public — GET /orders/:id
    // returns its status to anyone, no header needed — so its event
    // stream being equally open isn't a new leak, just the same resource
    // over a different transport. What WAS a real gap: an order that DOES
    // have a recorded owner got the same open 200 here that an anonymous
    // one does, even though the WebSocket join (orders.gateway.ts) was
    // correctly refusing anyone but that owner for the identical room.
    // `X-User-Id` is the same header POST /orders already reads.
    if (order.userId) {
      const userId = req.get('X-User-Id');
      if (!userId || order.userId !== userId) {
        res.status(403).end();
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Sets the CLIENT's reconnect delay (EventSource's own retry timer) —
    // without this line the default is several seconds, which makes a
    // demo relying on a prompt reconnect look stuck rather than fast.
    res.write('retry: 1000\n\n');

    const writeEvent = (event: OrderStatusEvent): void => {
      res.write(`id: ${event.id}\nevent: order.status\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
    };

    // Last-Event-ID: resume exactly where this connection left off — every
    // buffered event strictly newer than what the client already has,
    // then fall through to the live subscription below for anything after.
    // A missing OR unparsable header (`Number(...)` on anything that
    // isn't a clean integer, including undefined, is NaN) both mean
    // "nothing seen yet" — `id > NaN` is false for every real id, so an
    // unparsable header used to silently swallow the whole backlog
    // instead of replaying it.
    const parsedLastEventId = Number(req.get('Last-Event-ID'));
    const lastEventId = Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0;
    for (const missed of events.getEventsSince(orderId, lastEventId)) {
      writeEvent(missed);
    }

    const unsubscribe = events.subscribe(orderId, writeEvent);
    req.on('close', unsubscribe);
  };
}
