#!/usr/bin/env node
// Headless proof that room isolation is real, not asserted. Two clients
// join two DIFFERENT orders' rooms; only the one that changed should hear
// about it. --same-room is the control: point both clients at the SAME
// room and the EXPECTATION flips (B must now hear it) — a script that
// always prints B_RECEIVED=0 fails this run, which is exactly the point:
// it proves the main run's "0" was a measurement, not a hardcoded string.
//
// Order of operations matters (see README): connect -> join -> wait for
// the join ack -> only THEN change the status. Changing status before a
// client's join has been acknowledged races the event past an empty room.
import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.REALTIME_DEMO_URL || 'http://localhost:3000';
const sameRoom = process.argv.includes('--same-room');

async function createOrder(userId) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `realtime-demo-${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'X-User-Id': userId,
    },
    body: JSON.stringify({ items: [{ product_id: 'prod_1', quantity: 1 }] }),
  });
  if (!res.ok) throw new Error(`order create failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function setStatus(orderId, status) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`status change failed: ${res.status} ${await res.text()}`);
}

function connectAndJoin(orderId, userId) {
  return new Promise((resolve, reject) => {
    // userId travels in the handshake (`auth`), not in the `join` payload
    // — the gateway (orders.gateway.ts) reads identity once per
    // connection from here, exactly so a client can't just try a
    // different userId string per join call. See that file's comment.
    const socket = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false, auth: { userId } });
    let received = false;
    socket.on('order.status', () => {
      received = true;
    });
    socket.on('connect_error', (err) => reject(err));
    socket.on('connect', () => {
      socket.emit('join', { orderId }, (ack) => {
        if (!ack?.ok) {
          reject(new Error(`join denied for order ${orderId}: ${JSON.stringify(ack)}`));
          return;
        }
        resolve({ socket, didReceive: () => received });
      });
    });
  });
}

async function main() {
  const userA = 'realtime-demo-user-a';
  const userB = 'realtime-demo-user-b';

  const orderA = await createOrder(userA);
  const orderB = await createOrder(userB);

  // The one line --same-room changes: which room (and, since a real
  // ownership guard gates joins, which identity) client B uses. Both runs
  // share every other line of this script.
  const roomOrderIdForB = sameRoom ? orderA : orderB;
  const identityForB = sameRoom ? userA : userB;

  const clientA = await connectAndJoin(orderA, userA);
  const clientB = await connectAndJoin(roomOrderIdForB, identityForB);

  await setStatus(orderA, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const aReceived = clientA.didReceive() ? 1 : 0;
  const bReceived = clientB.didReceive() ? 1 : 0;

  console.log(`A_RECEIVED=${aReceived}`);
  console.log(`B_RECEIVED=${bReceived}`);

  clientA.socket.close();
  clientB.socket.close();

  const expectedB = sameRoom ? 1 : 0;
  const ok = aReceived === 1 && bReceived === expectedB;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
