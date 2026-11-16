import type { RequestHandler } from 'express';
import { CacheAside, CacheBusyError } from '../redis/cache';
import { ProductCardRepository, productCardKey } from '../repositories/product-card.repository';

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * GET /product-cards/{productId} — HW #23's heavy read through the cache.
 * The DB is reached only on a miss, by one caller per key; a caller that
 * has nothing to serve and can't wait any longer gets 503 + Retry-After
 * (load shed), never a DB query of its own.
 */
export function createProductCardHandler(cache: CacheAside, repo: ProductCardRepository): RequestHandler {
  return async (req, res, next) => {
    const productId = String(req.params.productId);
    try {
      const card = await cache.get(productCardKey(productId), () => repo.findCard(productId));
      if (!card) return next(httpError(404, `Product "${productId}" was not found`));
      res.json({
        id: card.id,
        name: card.name,
        price_cents: card.priceCents,
        stock: card.stock,
        units_sold: card.unitsSold,
        orders_count: card.ordersCount,
      });
    } catch (err) {
      if (err instanceof CacheBusyError) {
        res.set('Retry-After', String(err.retryAfterSeconds));
        return next(Object.assign(httpError(503, err.message), { expose: true }));
      }
      next(err);
    }
  };
}
