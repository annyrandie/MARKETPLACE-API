// HW #18 asks for a Nest `@WebSocketGateway()` on the socket.io platform.
// This project is Express (HW #9's own "variant B" decision, unchanged
// since) — there is no Nest DI graph for a decorator to hook into — so
// this is the framework-agnostic equivalent: a plain function that attaches
// a socket.io server to the raw `http.Server` app.js creates (see that
// file's bootstrap function), wired into the SAME OrderEventsService the
// SSE route (orders.controller.ts) subscribes to.
import type { Server as HttpServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { OrderEventsService } from './order-events.service';

export interface OwnedOrder {
  id: string;
  userId: string | null;
}

export type OrderLookup = (orderId: string) => OwnedOrder | undefined;

export interface JoinAck {
  ok: boolean;
  room?: string;
  reason?: 'not_found' | 'forbidden';
}

export function attachOrdersGateway(
  httpServer: HttpServer,
  events: OrderEventsService,
  getOrder: OrderLookup,
): SocketIoServer {
  // No CORS config: realtime-demo.mjs is a Node process (socket.io-client
  // outside a browser never enforces CORS at all), and this app has no
  // browser-facing cross-origin client of its own. An earlier revision
  // set `cors: { origin: '*' }` out of socket.io-boilerplate habit — that
  // explicitly opened cross-origin WebSocket access this app's REST and
  // SSE surfaces don't have (neither sets any CORS header, so a browser's
  // own same-origin policy is what protects them by default); removing it
  // closes that mismatch instead of giving WS a wider cross-origin
  // exposure than the "equivalent" transport next to it.
  const io = new SocketIoServer(httpServer);

  io.on('connection', (socket) => {
    // Identity is read ONCE, at connection time, from the handshake — not
    // from the `join` payload. A payload field is just a string the
    // client typed into the SAME message asking to join; "someone else's
    // order" would otherwise mean nothing more than "a client that didn't
    // guess the right userId string this one time" — it could claim a
    // DIFFERENT userId on every join call over the same connection and
    // probe every order's ownership one guess at a time. Pinning identity
    // to the handshake (auth payload, same as a real session/JWT would
    // arrive) ties exactly one identity to this socket for its whole
    // lifetime, which is what makes "forbidden" actually mean something.
    const userId = socket.handshake.auth?.userId ?? socket.handshake.query?.userId;

    socket.on('join', (payload: { orderId?: string } | undefined, ack?: (res: JoinAck) => void) => {
      const orderId = payload?.orderId;
      const order = typeof orderId === 'string' ? getOrder(orderId) : undefined;

      if (!order) {
        ack?.({ ok: false, reason: 'not_found' });
        return;
      }
      // Ownership is enforced only when the order actually HAS an owner
      // — same rule orders.controller.ts's SSE route uses, for the same
      // reason: an order created without X-User-Id has no owner to check
      // against and is already public via plain GET /orders/:id, so
      // refusing every joiner for it (an earlier revision did exactly
      // that, unconditionally) made WebSocket the one transport that was
      // STRICTER than the "equivalent" SSE stream for the identical
      // resource, not just differently guarded. Someone else's order —
      // one that DOES have an owner — is still refused exactly as before.
      if (order.userId && order.userId !== userId) {
        ack?.({ ok: false, reason: 'forbidden' });
        return;
      }

      const room = `orders:${orderId}`;
      socket.join(room);
      ack?.({ ok: true, room });
    });
  });

  // ONE subscription for the gateway's whole lifetime, not one per room:
  // each event carries its own orderId, so it's routed to exactly the
  // room it belongs to as it arrives — server.to(room).emit(...), never a
  // broadcast to every connected socket.
  events.onAny((event) => {
    io.to(`orders:${event.orderId}`).emit('order.status', event);
  });

  return io;
}
