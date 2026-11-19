// npm run demo:rbac — authentication (401) vs authorization (403), on two
// different levels of authorization:
//
//   anon         GET /orders/{A's}  no token                 → 401  who are you?
//   own          GET /orders/{A's}  buyer A                  → 200
//   foreign      GET /orders/{A's}  buyer B                  → 403  ownership (checked after load)
//   role-denied  POST /products     buyer B                  → 403  role guard
//   role-allowed POST /products     seller                   → 201
//   tampered     POST /products     A's token, role→admin,   → 401  signature no longer matches
//                                   old signature kept
//
// tampered is the cheap proof the signature is VERIFIED, not decoded:
// a server deciding on jwt.decode() would answer it with 201.
//
// Extra lines (not in the grader's contract): alg-none / alg-hs256 — the
// same token re-wrapped as `alg: none` and as HS256 keyed with our public
// key. Both must be 401: that's the algorithms allowlist, observed.
import { forgeWithAlg, openAuthDemo, tamperRole } from './demo-kit';

async function main(): Promise<void> {
  const demo = await openAuthDemo('rbac', { a: 'buyer', b: 'buyer', seller: 'seller' });
  const { a, b, seller } = demo.users;

  const [la, lb, ls] = [await demo.login(a), await demo.login(b), await demo.login(seller)];
  const tokenA = la.body.access_token;
  const tokenB = lb.body.access_token;
  const tokenSeller = ls.body.access_token;

  const created = await demo.call('POST', '/orders', {
    token: tokenA,
    headers: { 'Idempotency-Key': `rbac-${Date.now()}` },
    body: { items: [{ product_id: 'prod_1', quantity: 1 }] },
  });
  const orderId = created.body.id as string;

  const anon = await demo.call('GET', `/orders/${orderId}`);
  const own = await demo.call('GET', `/orders/${orderId}`, { token: tokenA });
  const foreign = await demo.call('GET', `/orders/${orderId}`, { token: tokenB });

  const product = { name: 'RBAC demo product', price_cents: 1999 };
  const roleDenied = await demo.call('POST', '/products', { token: tokenB, body: product });
  const roleAllowed = await demo.call('POST', '/products', { token: tokenSeller, body: product });
  const tampered = await demo.call('POST', '/products', { token: tamperRole(tokenA, 'admin'), body: product });

  const publicPem = Buffer.from(process.env.JWT_PUBLIC_KEY ?? '', 'base64').toString('utf8');
  const sellerAsNone = forgeWithAlg(tokenSeller, 'none', publicPem);
  const sellerAsHs256 = forgeWithAlg(tokenSeller, 'HS256', publicPem);
  const algNone = await demo.call('POST', '/products', { token: sellerAsNone, body: product });
  const algHs256 = await demo.call('POST', '/products', { token: sellerAsHs256, body: product });

  await demo.finish(
    {
      anon: anon.status,
      own: own.status,
      foreign: foreign.status,
      'role-denied': roleDenied.status,
      'role-allowed': roleAllowed.status,
      tampered: tampered.status,
      'alg-none': algNone.status,
      'alg-hs256': algHs256.status,
    },
    {
      'setup: three logins + an order': [la, lb, ls].every((l) => l.status === 200) && created.status === 201,
      'no token → 401 (not 403)': anon.status === 401,
      'owner → 200': own.status === 200 && own.body?.id === orderId,
      "someone else's order → 403 (not 401, not 404)": foreign.status === 403,
      'buyer writing the catalog → 403': roleDenied.status === 403,
      'seller writing the catalog → 201': roleAllowed.status === 200 || roleAllowed.status === 201,
      'forged payload → 401': tampered.status === 401,
      'alg none / HS256-with-public-key → 401 (allowlist)': algNone.status === 401 && algHs256.status === 401,
    },
  );
}

main().catch((err) => {
  console.error('demo:rbac failed:', err);
  process.exit(1);
});
