import type { RequestHandler } from 'express';
import type { CheckoutService } from '../checkout.service';
import { InsufficientBalanceError, InsufficientStockError, IdempotencyKeyReuseError } from '../checkout';

/** An Error carrying the HTTP status app.js's problem+json filter reads. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * POST /checkout — the API edge of HW #22's level 3. Shared by app.js
 * (behind the OpenAPI validator, which already guarantees the header and
 * body shape) and demo:outbox (which mounts it bare, so the demo's two
 * requests go through exactly this code, not a copy of it).
 */
export function createCheckoutHandler(service: CheckoutService): RequestHandler {
  return async (req, res, next) => {
    try {
      const idempotencyKey = req.header('idempotency-key');
      if (!idempotencyKey) throw httpError(400, 'Idempotency-Key header is required');

      const { user_id, product_id, quantity } = req.body;
      const result = await service.placeOrder(idempotencyKey, user_id, product_id, quantity);
      // Same status on a replay as on the first call (the client asked for
      // the same thing and gets the same answer), flagged the same way
      // POST /orders (HW #9) already flags its own replays.
      if (result.replayed) res.set('Idempotency-Replay', 'true');
      res.status(201).json({ order_id: result.orderId, total_cents: result.totalCents });
    } catch (err) {
      if (err instanceof InsufficientStockError || err instanceof InsufficientBalanceError) {
        return next(httpError(409, err.message));
      }
      if (err instanceof IdempotencyKeyReuseError) return next(httpError(422, err.message));
      next(err);
    }
  };
}
