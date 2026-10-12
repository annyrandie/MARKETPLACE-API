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
  userId: string;
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
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    socket.on('join', (payload: { orderId?: string; userId?: string } | undefined, ack?: (res: JoinAck) => void) => {
      const orderId = payload?.orderId;
      const userId = payload?.userId;
      const order = typeof orderId === 'string' ? getOrder(orderId) : undefined;

      // Anonymous (no userId) or someone else's order (userId doesn't
      // match the owner on record) are both refused the same way: the
      // socket never joins the room, so it can never receive that order's
      // events through this connection.
      if (!order || !userId || order.userId !== userId) {
        ack?.({ ok: false, reason: order ? 'forbidden' : 'not_found' });
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
