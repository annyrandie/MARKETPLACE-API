// HW #18's requested `orders.controller.ts` — Express has no decorator
// controller class (no Nest here, see orders.gateway.ts's header comment),
// so this exports a route-handler FACTORY instead, mounted directly in
// app.js's own router the same way every other route there is. Untyped
// `req`/`res` params deliberately: adding `@types/express` just for two
// parameter annotations isn't worth a new dependency in a project where
// the route's own home (app.js) is plain, untyped JS anyway.
import { OrderEventsService, OrderStatusEvent } from './order-events.service';

export type OrderExists = (orderId: string) => boolean;

export function createOrderEventsSseHandler(events: OrderEventsService, orderExists: OrderExists) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req: any, res: any): void => {
    const { orderId } = req.params;
    if (!orderExists(orderId)) {
      res.status(404).end();
      return;
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
    const lastEventIdHeader = req.get('Last-Event-ID');
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;
    for (const missed of events.getEventsSince(orderId, lastEventId)) {
      writeEvent(missed);
    }

    const unsubscribe = events.subscribe(orderId, writeEvent);
    req.on('close', unsubscribe);
  };
}
