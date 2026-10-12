import { Queryable } from './queryable';

export interface OrderItemInput {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderRow {
  id: string;
  user_id: string;
  status: string;
  total_amount_cents: number;
  created_at: Date;
}

export interface OrderItemWithProductRow {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderWithItems extends OrderRow {
  items: OrderItemWithProductRow[];
}

// Same Queryable seam as UserRepository — see that file's header comment.
export class OrderRepository {
  constructor(private readonly db: Queryable) {}

  // Order + its line items as two statements, not one — this repository
  // doesn't open its own transaction (it trusts the caller: production code
  // hands it a Pool and wraps the call in its own BEGIN/COMMIT the way
  // src/checkout.ts does; the integration suite hands it an already-open,
  // ROLLBACK-bound Client). `order_items.product_id`'s FK (RESTRICT, HW
  // #13's InitSchema) is what turns a bad productId into a real Postgres
  // error here, not a silently-inserted dangling reference.
  async create(userId: string, status: string, items: OrderItemInput[]): Promise<OrderRow> {
    const totalAmountCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
    const { rows } = await this.db.query<OrderRow>(
      `INSERT INTO orders (user_id, status, total_amount_cents) VALUES ($1, $2, $3)
       RETURNING id, user_id, status, total_amount_cents, created_at`,
      [userId, status, totalAmountCents],
    );
    const order = rows[0];
    for (const item of items) {
      await this.db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [order.id, item.productId, item.quantity, item.unitPriceCents],
      );
    }
    return order;
  }

  // JOIN order_items -> products: proves the FK actually resolves to a real
  // row, not just that an id column holds a number a mock would never check.
  async findWithItems(orderId: string): Promise<OrderWithItems | null> {
    const { rows: orderRows } = await this.db.query<OrderRow>(
      `SELECT id, user_id, status, total_amount_cents, created_at FROM orders WHERE id = $1`,
      [orderId],
    );
    if (!orderRows[0]) return null;

    const { rows: items } = await this.db.query<OrderItemWithProductRow>(
      `SELECT oi.id, oi.product_id, p.name AS product_name, oi.quantity, oi.unit_price_cents
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [orderId],
    );
    return { ...orderRows[0], items };
  }

  // Aggregation across every order a user has placed — the kind of query a
  // mocked repository can't meaningfully fake, because the "mock" would
  // just be the sum the test already expects.
  async totalSpentByUser(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT coalesce(sum(total_amount_cents), 0) AS total FROM orders WHERE user_id = $1`,
      [userId],
    );
    return Number(rows[0].total);
  }
}
