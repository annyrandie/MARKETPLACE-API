import type { Queryable, QueryResult } from './queryable';

export interface ProductCard {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
  unitsSold: number;
  ordersCount: number;
}

/**
 * Wraps any Queryable and counts every statement that actually goes out to
 * Postgres. This — not "how many times did I call findCard()" — is what
 * demo:cache reports as db-calls: a cache bug that calls the loader twice,
 * or a loader that quietly grows a second query, both show up here.
 */
export class CountingQueryable implements Queryable {
  count = 0;

  constructor(private readonly inner: Queryable) {}

  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.count += 1;
    return this.inner.query<T>(sql, params);
  }
}

/**
 * The "heavy read" HW #23 puts behind the cache: a product card with its
 * live stock plus sales aggregates over order_items — a join + GROUP BY
 * that grows with order history, while the answer changes rarely and a
 * few minutes of staleness is harmless (stock here is informational; the
 * real oversell guard is checkout's atomic UPDATE, HW #14, never this).
 */
export class ProductCardRepository {
  constructor(private readonly db: Queryable) {}

  async findCard(productId: string): Promise<ProductCard | null> {
    const { rows } = await this.db.query<ProductCard>(
      `SELECT p.id::text                               AS "id",
              p.name                                   AS "name",
              p.price_cents                            AS "priceCents",
              p.stock                                  AS "stock",
              COALESCE(SUM(oi.quantity), 0)::int       AS "unitsSold",
              COUNT(DISTINCT oi.order_id)::int         AS "ordersCount"
         FROM products p
         LEFT JOIN order_items oi ON oi.product_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [productId],
    );
    return rows[0] ?? null;
  }
}

export const productCardKey = (productId: string): string => `product-card:v1:${productId}`;
