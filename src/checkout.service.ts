// HW #19 review fix: checkout()'s `publish` callback used to be passed by
// exactly one caller — test/e2e/checkout.e2e.test.js. Every real path
// (demo:race, and nothing at all over HTTP) called checkout() without it,
// so in practice no order ever produced an `order.placed` event. This
// service is the one place that binds the two together: callers ask it
// to place an order, and the event is published as part of that, not as
// an opt-in a caller can forget.
//
// Lazy on both sides — the DataSource and the broker channel are opened
// on the first placeOrder(), not at construction — so app.js can create
// this at module load without `npm run test:e2e` (app.e2e.test.js) or the
// Pact provider verification suddenly needing a migrated DB and a running
// RabbitMQ just to require the app.
import type { DataSource } from 'typeorm';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { checkout, CheckoutResult } from './checkout';
import { publishOrderPlaced, OrderPlacedData } from './events/publisher';

type Log = (level: 'info' | 'warn' | 'error', ...args: unknown[]) => void;

export class CheckoutService {
  private dsReady?: Promise<DataSource>;
  private connection?: ChannelModel;
  private channel?: Promise<ConfirmChannel>;

  constructor(
    private readonly ds: DataSource,
    private readonly connectBroker: () => Promise<ChannelModel>,
    private readonly log: Log,
  ) {}

  async placeOrder(userId: string, productId: string, quantity: number): Promise<CheckoutResult> {
    const ds = await this.dataSource();
    return checkout(ds, userId, productId, quantity, (data) => this.publish(data));
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

  /**
   * Called by checkout() AFTER its transaction has committed. A failure
   * here is logged, not rethrown: the order is already in Postgres, and
   * answering the HTTP client with a 500 for a committed order would just
   * invite a retry that places a SECOND one. The lost event is the
   * dual-write gap README's "Async events" section already names — closed
   * properly only by a transactional outbox (HW #22), not by pretending
   * the order failed.
   */
  private async publish(data: OrderPlacedData): Promise<void> {
    try {
      const channel = await this.confirmChannel();
      await publishOrderPlaced(channel, data);
    } catch (err) {
      this.log(
        'error',
        `order ${data.orderId} committed, but order.placed was NOT published:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** One long-lived ConfirmChannel, reopened only after it (or its
   *  connection) dies — not a new TCP connection per order. */
  private confirmChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      const reset = () => {
        this.channel = undefined;
      };
      this.channel = (async () => {
        if (!this.connection) {
          const connection = await this.connectBroker();
          connection.on('error', (err) => this.log('warn', '[broker connection]', err.message));
          connection.on('close', () => {
            this.connection = undefined;
            reset();
          });
          this.connection = connection;
        }
        const channel = await this.connection.createConfirmChannel();
        // e.g. publishing to an exchange nobody declared yet (the consumer
        // side owns topology) closes the channel with a 404 — drop it so
        // the next order opens a fresh one instead of reusing a dead one.
        channel.on('error', (err) => this.log('warn', '[broker channel]', err.message));
        channel.on('close', reset);
        return channel;
      })().catch((err) => {
        reset();
        throw err;
      });
    }
    return this.channel;
  }
}
