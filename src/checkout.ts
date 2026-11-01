// The transactional checkout: decrement stock, decrement the buyer's
// balance, record the order, queue a post-processing task, and (HW #22)
// write the order.placed event to the outbox — one transaction, one
// connection, all-or-nothing.
//
// Oversell protection: an atomic `UPDATE ... WHERE stock >= $n RETURNING`,
// not `SELECT ... FOR UPDATE` + a JS-side check. Both are race-free (both
// take a row lock), but the atomic UPDATE does the check and the write in
// the SAME statement — there's no separate read step in application code
// for a bug to slip a decision into. `SELECT ... FOR UPDATE` still requires
// the app to read a value, decide in JS, and issue a second statement; get
// that wrong (e.g. skip re-reading after acquiring the lock) and it's the
// exact read-modify-write anti-pattern this whole exercise exists to avoid.
// One round trip instead of two is a real bonus, not the main reason.
import { DataSource, EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { Product } from './entities/product.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Task } from './entities/task.entity';
import { toOrderPlacedEvent } from './outbox/order-placed.event';

export class InsufficientStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Product "${productId}" does not have enough stock`);
    this.name = 'InsufficientStockError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor(public readonly userId: string) {
    super(`User "${userId}" does not have enough balance`);
    this.name = 'InsufficientBalanceError';
  }
}

/** The same Idempotency-Key reused for a different order — one key is one
 *  intent, it can't mean two different purchases. */
export class IdempotencyKeyReuseError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency-Key "${key}" was already used for a different checkout request`);
    this.name = 'IdempotencyKeyReuseError';
  }
}

export interface CheckoutResult {
  orderId: string;
  totalCents: number;
  /** true when this call didn't place anything — the key had already
   *  produced this order, and this is that order handed back again. */
  replayed: boolean;
}

export interface CheckoutOptions {
  /** HW #22 level 3: the client's Idempotency-Key. Two calls with the same
   *  key place ONE order — the key identifies the intent, not the body
   *  (two legitimately identical orders just use two keys). */
  idempotencyKey?: string;
  /** demo:crash-write only — runs inside the transaction right after the
   *  outbox row is inserted; throwing here is the "business write fails
   *  after the event was already written" case. */
  afterOutboxInsert?: (manager: EntityManager) => Promise<void>;
}

/**
 * HW #19 published `order.placed` right after this transaction committed —
 * a dual write with no shared COMMIT, where a crash between the two lost
 * the event for good. HW #22 closes that gap with a transactional outbox:
 * the event is just another row INSERTed in this same transaction, so it
 * exists if and only if the order does. Nothing here talks to the broker
 * (a broker can't roll back) — src/outbox/relay.ts moves committed rows
 * out afterwards, at-least-once.
 */
export async function checkout(
  ds: DataSource,
  userId: string,
  productId: string,
  quantity: number,
  opts: CheckoutOptions = {},
): Promise<CheckoutResult> {
  return ds.transaction(async (manager: EntityManager) => {
    // Claim the key FIRST, before touching stock: a concurrent request with
    // the same key blocks right here on the unique index until this
    // transaction ends — then either sees our committed row (replay) or,
    // if we rolled back, claims the key itself. No SELECT-then-INSERT
    // window in between.
    // Keys are scoped per buyer: the same key from two different buyers is
    // two different intents.
    const request = { productId, quantity };
    if (opts.idempotencyKey !== undefined) {
      const claimed: Array<{ key: string }> = await manager.query(
        `INSERT INTO idempotency_keys (user_id, key, request) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
        [userId, opts.idempotencyKey, request],
      );
      if (claimed.length === 0) {
        const [existing]: Array<{ request: typeof request; order_id: string; total_cents: number }> =
          await manager.query(
            `SELECT request, order_id, total_cents FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
            [userId, opts.idempotencyKey],
          );
        if (existing.request.productId !== productId || existing.request.quantity !== quantity) {
          throw new IdempotencyKeyReuseError(opts.idempotencyKey);
        }
        return { orderId: String(existing.order_id), totalCents: existing.total_cents, replayed: true };
      }
    }

    // Lock + check + write, one statement, zero window: 0 rows back means
    // "not enough stock", full stop — no other transaction can observe or
    // act on a half-decided state in between.
    //
    // manager.query() on an UPDATE ... RETURNING returns a 2-tuple
    // [rows, affectedCount] for Postgres — unlike a plain SELECT, which
    // returns the rows array directly. Destructuring only the first element
    // is required, not stylistic: treating the tuple itself as the rows
    // array silently makes `stockRows.length` always 2 and
    // `stockRows[0].price_cents` always `undefined` → NaN totals — the
    // exact bug this comment is here so nobody reintroduces.
    const [stockRows]: [Array<{ price_cents: number }>, number] = await manager.query(
      `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING price_cents`,
      [quantity, productId],
    );
    if (stockRows.length === 0) {
      throw new InsufficientStockError(productId);
    }
    const priceCents = Number(stockRows[0].price_cents);
    const totalCents = priceCents * quantity;

    // Same pattern for the buyer's balance — a second independent atomic
    // guard, not a shared lock with the stock check.
    const [balanceRows]: [Array<{ id: string }>, number] = await manager.query(
      `UPDATE users SET balance_cents = balance_cents - $1 WHERE id = $2 AND balance_cents >= $1 RETURNING id`,
      [totalCents, userId],
    );
    if (balanceRows.length === 0) {
      throw new InsufficientBalanceError(userId);
    }

    const orderRepo = manager.getRepository(Order);
    const order = await orderRepo.save(
      orderRepo.create({
        user: { id: userId } as User,
        status: 'completed' as OrderStatus,
        totalAmountCents: totalCents,
      }),
    );

    const itemRepo = manager.getRepository(OrderItem);
    await itemRepo.save(
      itemRepo.create({
        order: { id: order.id } as Order,
        product: { id: productId } as Product,
        quantity,
        unitPriceCents: priceCents,
      }),
    );

    // Same transaction as the order itself: this task can never exist for
    // an order that didn't commit, and can never fail to exist for one
    // that did — no separate "did the enqueue also succeed?" question.
    const taskRepo = manager.getRepository(Task);
    await taskRepo.save(
      taskRepo.create({
        kind: 'order.postprocess',
        payload: { orderId: order.id, userId, productId, quantity },
      }),
    );

    // The event, as a row: same transaction, same COMMIT as the order.
    // Payload is the explicit contract from toOrderPlacedEvent(), never
    // the `order` entity spread as-is.
    const event = toOrderPlacedEvent({
      id: order.id,
      userId,
      productId,
      quantity,
      totalCents,
      createdAt: order.createdAt,
    });
    await manager.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, type, payload) VALUES ('order', $1, $2, $3)`,
      [order.id, event.type, event],
    );

    await opts.afterOutboxInsert?.(manager);

    if (opts.idempotencyKey !== undefined) {
      await manager.query(
        `UPDATE idempotency_keys SET order_id = $3, total_cents = $4 WHERE user_id = $1 AND key = $2`,
        [userId, opts.idempotencyKey, order.id, totalCents],
      );
    }

    return { orderId: order.id, totalCents, replayed: false };
  });
}
