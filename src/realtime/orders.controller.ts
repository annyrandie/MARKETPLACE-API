// HW #18's requested `orders.controller.ts` — Express has no decorator
// controller class (no Nest here, see orders.gateway.ts's header comment),
// so this exports a route-handler FACTORY instead, mounted directly in
// app.js's own router the same way every other route there is. Untyped
// `req`/`res` params deliberately: adding `@types/express` just for two
// parameter annotations isn't worth a new dependency in a project where
// the route's own home (app.js) is plain, untyped JS anyway.
import { OrderEventsService, OrderStatusEvent } from './order-events.service';
import { OrderLookup } from './orders.gateway';

// Same shape app.js's ProblemError has ({status, message}) — not that
// class itself: app.js requires the COMPILED version of this file at
// module-load time (see its own header comment), so importing app.js's
// ProblemError back from here would be a circular require. app.js's
// single error-handling middleware only ever reads `.status`/`.message`
// off whatever reaches `next(err)`, so a plain Error with `.status` set
// funnels into the exact same RFC 7807 problem+json response as every
// other error in this app — not a bare `res.status(...).end()` with no
// body and no Content-Type, which was this route's one inconsistency
// with the rest of the API's single error contract.
function problem(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function createOrderEventsSseHandler(events: OrderEventsService, getOrder: OrderLookup) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req: any, res: any, next: (err?: unknown) => void): void => {
    const { orderId } = req.params;
    const order = getOrder(orderId);
    if (!order) {
      next(problem(404, `Order "${orderId}" was not found`));
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
        next(problem(403, `"${orderId}" does not belong to the caller`));
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
    // A clean disconnect fires 'close' on req; a reset/timed-out one can
    // instead make a later res.write() emit 'error' on the response
    // stream — with no listener, that's an unhandled EventEmitter error,
    // fatal to the whole process by default (the same class of bug
    // container.js's own header comment documents fixing for a dropped DB
    // connection). One flaky long-lived SSE client must not be able to
    // take the server down.
    res.on('error', unsubscribe);
  };
}
