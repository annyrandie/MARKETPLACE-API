// The one service behind POST /checkout (app.js) and demo:outbox. HW #19
// had it publish order.placed itself, right after checkout() committed —
// HW #22 removed that: the event is now an outbox row inside checkout()'s
// own transaction, and src/outbox/relay.ts is the only thing that talks
// to the broker. This service no longer needs a broker connection at all.
//
// Lazy: the DataSource is initialized on the first placeOrder(), not at
// construction, so app.js can create this at module load without
// app.e2e.test.js or the Pact provider verification needing a migrated DB.
import type { DataSource } from 'typeorm';
import { checkout, CheckoutResult } from './checkout';

export class CheckoutService {
  private dsReady?: Promise<DataSource>;

  constructor(private readonly ds: DataSource) {}

  async placeOrder(
    idempotencyKey: string,
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CheckoutResult> {
    const ds = await this.dataSource();
    return checkout(ds, userId, productId, quantity, { idempotencyKey });
  }

  private dataSource(): Promise<DataSource> {
    if (!this.dsReady) {
      this.dsReady = (this.ds.isInitialized ? Promise.resolve(this.ds) : this.ds.initialize()).catch((err) => {
        this.dsReady = undefined; // next request retries instead of caching the failure forever
        throw err;
      });
    }
    return this.dsReady;
  }
}
