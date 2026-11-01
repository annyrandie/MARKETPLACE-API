// npm run demo:outbox — happy path, end to end:
//   2 concurrent HTTP requests, SAME Idempotency-Key → 1 order + 1 outbox
//   row (level 3) → relay publishes it → the invoicing consumer applies
//   the effect once and marks it in its inbox.
// The requests go through the real POST /checkout handler
// (src/http/checkout.handler.ts, the one app.js mounts) on a throwaway
// express server — so the demo exercises the API edge itself, not a
// function call that skips it.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { CheckoutService } from '../checkout.service';
import { createCheckoutHandler } from '../http/checkout.handler';
import { drainOutbox } from './relay';
import { openDemo, waitFor, finish, PRODUCT_STOCK } from './demo-kit';

async function main(): Promise<void> {
  const demo = await openDemo('demo-outbox');

  const app = express();
  app.use(express.json());
  app.post('/checkout', createCheckoutHandler(new CheckoutService(demo.ds)));
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ detail: err.message });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/checkout`;

  // Fired together, not one after the other: the second request must hit
  // the key while the first one's transaction may still be open — that's
  // the race the ON CONFLICT claim in checkout() exists for.
  const key = `${demo.keyPrefix}${Date.now()}`;
  const body = JSON.stringify({ user_id: demo.userId, product_id: demo.productId, quantity: 2 });
  const send = () =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body });
  const responses = await Promise.all([send(), send()]);
  const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ order_id?: string }>));
  server.close();

  const ok201 = responses.filter((r) => r.status === 201).length;
  const replays = responses.filter((r) => r.headers.get('idempotency-replay') === 'true').length;
  const sameOrder = bodies[0].order_id !== undefined && bodies[0].order_id === bodies[1].order_id;

  await drainOutbox(demo.pool, demo.publishChannel);
  await waitFor(() => demo.seen.deliveries >= 1, 10000);
  // Grace period: a duplicate (if there were one) would arrive right
  // after the first delivery — give it the chance to show up and be counted.
  await new Promise((r) => setTimeout(r, 500));

  const c = await demo.counts();
  await demo.close();

  finish(
    {
      requests: responses.length,
      'status-201': ok201,
      replayed: replays,
      orders: c.orders,
      outbox: c.outbox,
      published: c.published,
      deliveries: demo.seen.deliveries,
      effect: c.effect,
      processed: c.processed,
      'stock-left': c.stock,
    },
    {
      'requests=2': responses.length === 2,
      'both requests 201, one of them a replay': ok201 === 2 && replays === 1,
      'both responses name the same order': sameOrder,
      'orders=1': c.orders === 1,
      'outbox=1': c.outbox === 1,
      'published=1': c.published === 1,
      'deliveries=1': demo.seen.deliveries === 1,
      'effect=1': c.effect === 1,
      'processed=1': c.processed === 1,
      'stock decremented once': c.stock === PRODUCT_STOCK - 2,
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
