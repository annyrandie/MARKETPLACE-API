// The transactional checkout: decrement stock, decrement the buyer's
// balance, record the order, and queue a post-processing task — one
// transaction, one connection, all-or-nothing.
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
import { OrderPlacedData } from './events/publisher';

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

export interface CheckoutResult {
  orderId: string;
  totalCents: number;
}

/**
 * HW #19: the `order.placed` event's actual origin — requirement #1 reads
 * "the event comes from your critical business operation", not from a
 * controller or a demo script reaching into the broker on its own.
 * `publish` is optional and deliberately called AFTER `ds.transaction(...)`
 * resolves, never from inside it: publishing INSIDE the transaction would
 * tell the world "order placed" before Postgres has actually committed
 * (and a rollback after that point could never be taken back) — the
 * classic dual-write problem between two different systems with no
 * shared transaction. This HW doesn't claim to solve that atomically
 * (publish failing here after a successful commit is a real, open gap) —
 * that's a transactional outbox, HW #22's job, named here rather than
 * quietly papered over.
 */
export async function checkout(
  ds: DataSource,
  userId: string,
  productId: string,
  quantity: number,
  publish?: (data: OrderPlacedData) => Promise<unknown>,
): Promise<CheckoutResult> {
  const result = await ds.transaction(async (manager: EntityManager) => {
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

    return { orderId: order.id, totalCents };
  });

  // Best-effort, outside the transaction, AFTER it has committed — see
  // this function's own header comment for why. A failure here throws
  // past the caller with the order already placed, not rolled back; this
  // HW names that gap rather than hiding it (README's "Async events"
  // section).
  if (publish) {
    await publish({ orderId: result.orderId, userId, totalCents: result.totalCents, productId, quantity });
  }

  return result;
}
