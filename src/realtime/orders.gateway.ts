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

/** HW #24: the same check every HTTP request goes through (signature +
 *  revocation) — resolves to the caller, rejects on a bad token. */
export type Authenticate = (token: string) => Promise<{ sub: string; role: string }>;

export interface JoinAck {
  ok: boolean;
  room?: string;
  reason?: 'not_found' | 'forbidden';
}

export function attachOrdersGateway(
  httpServer: HttpServer,
  events: OrderEventsService,
  getOrder: OrderLookup,
  authenticate: Authenticate,
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

  // HW #24: authentication happens in the HANDSHAKE — a socket without a
  // valid bearer token (`auth: { token }`) never connects at all; the
  // client gets connect_error "unauthorized". Same 401 semantics as HTTP.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string') return next(new Error('unauthorized'));
    authenticate(token)
      .then((caller) => {
        socket.data.caller = caller;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });

  io.on('connection', (socket) => {
    // Identity is fixed ONCE, at the handshake (io.use above), from a
    // verified token — never from the `join` payload, where a client could
    // claim a different user on every call and probe every order's
    // ownership one guess at a time. Before HW #24 the handshake carried a
    // bare userId string; now it's the signed `sub`.
    const caller = socket.data.caller as { sub: string; role: string };

    socket.on('join', (payload: { orderId?: string } | undefined, ack?: (res: JoinAck) => void) => {
      const orderId = payload?.orderId;
      const order = typeof orderId === 'string' ? getOrder(orderId) : undefined;

      if (!order) {
        ack?.({ ok: false, reason: 'not_found' });
        return;
      }
      // Ownership — the same rule as GET /orders/:id and the SSE stream:
      // the owner or an admin. Someone else's order → forbidden.
      if (order.userId && order.userId !== caller.sub && caller.role !== 'admin') {
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
