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
//
// HW #24: identities are real logins now (the seed's fixture accounts —
// `npm run seed` first), not an X-User-Id header / handshake string anyone
// could type: orders are created with a bearer token, the socket handshake
// carries the same token, and the status change is made by a seller.
import { io as ioClient } from 'socket.io-client';

const BASE_URL = process.env.REALTIME_DEMO_URL || 'http://localhost:3000';
const sameRoom = process.argv.includes('--same-room');
// the seed's dev-fixture password (src/seed.ts, DEV_SEED_PASSWORD)
const DEV_SEED_PASSWORD = process.env.DEV_SEED_PASSWORD || 'marketplace-dev-password';

async function login(email) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()} — did you run npm run seed?`);
  return (await res.json()).access_token;
}

async function createOrder(token) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `realtime-demo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ items: [{ product_id: 'prod_1', quantity: 1 }] }),
  });
  if (!res.ok) throw new Error(`order create failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function setStatus(orderId, status, sellerToken) {
  const res = await fetch(`${BASE_URL}/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sellerToken}` },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`status change failed: ${res.status} ${await res.text()}`);
}

function connectAndJoin(orderId, token) {
  return new Promise((resolve, reject) => {
    // the token travels in the handshake (`auth`), not in the `join`
    // payload — the gateway (orders.gateway.ts) verifies it once per
    // connection, so identity can't change from one join call to the next.
    const socket = ioClient(BASE_URL, { transports: ['websocket'], reconnection: false, auth: { token } });
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
  const tokenA = await login('alan@example.test'); // buyer
  const tokenB = await login('margaret@example.test'); // another buyer
  const sellerToken = await login('grace@example.test'); // changes status

  const orderA = await createOrder(tokenA);
  const orderB = await createOrder(tokenB);

  const roomOrderIdForB = sameRoom ? orderA : orderB;
  const identityForB = sameRoom ? tokenA : tokenB;

  const clientA = await connectAndJoin(orderA, tokenA);
  const clientB = await connectAndJoin(roomOrderIdForB, identityForB);

  await setStatus(orderA, 'completed', sellerToken);
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
