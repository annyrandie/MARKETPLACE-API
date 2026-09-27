// Deterministic, idempotent seed. Users/products are upserted by their
// natural key (email / name). Orders have no natural business key of their
// own, so their natural key is their full composition — which user, and
// exactly which (product, quantity) line items — checked and restored one
// order at a time, not behind a single all-or-nothing count() guard: if
// someone deletes a subset of the seed orders, a re-run puts back exactly
// the missing ones instead of seeing "orders exist" and skipping everyone.
import 'reflect-metadata';
import AppDataSource, { logger } from './data-source';
import { User } from './entities/user.entity';
import { Product } from './entities/product.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';

const USERS = [
  { email: 'ada@example.test', fullName: 'Ada Lovelace' },
  { email: 'grace@example.test', fullName: 'Grace Hopper' },
  { email: 'alan@example.test', fullName: 'Alan Turing' },
  { email: 'margaret@example.test', fullName: 'Margaret Hamilton' },
  { email: 'katherine@example.test', fullName: 'Katherine Johnson' },
];

const PRODUCTS = [
  { name: 'Механічна клавіатура', description: 'Ігрова клавіатура з механічними перемикачами.', priceCents: 249900 },
  { name: 'Бездротова миша', description: 'Ергономічна миша з довгим часом роботи від акумулятора.', priceCents: 89900 },
  { name: '27" монітор', description: 'IPS-панель, 144 Гц, тонкі рамки.', priceCents: 899900 },
  { name: 'Веб-камера', description: 'Full HD камера для відеодзвінків.', priceCents: 59900 },
  { name: 'USB-хаб', description: 'Хаб на чотири порти USB-C.', priceCents: 39900 },
  { name: 'Килимок для миші', description: 'Тканинний килимок великого розміру.', priceCents: 19900 },
];

const ORDER_STATUSES: OrderStatus[] = ['completed', 'completed', 'pending', 'completed', 'cancelled'];

interface ItemSpec {
  productId: string;
  quantity: number;
}

/** A seed order's natural key: user + the exact multiset of (product,
 *  quantity) pairs on it, order-independent (sorted) so item array order
 *  never matters. */
function orderKey(userId: string, items: ItemSpec[]): string {
  const itemsPart = items
    .map((it) => `${it.productId}:${it.quantity}`)
    .sort()
    .join('|');
  return `${userId}::${itemsPart}`;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  logger.echo = false;

  const userRepo = AppDataSource.getRepository(User);
  const users: User[] = [];
  for (const u of USERS) {
    let user = await userRepo.findOneBy({ email: u.email });
    if (!user) user = await userRepo.save(userRepo.create(u));
    users.push(user);
  }

  const productRepo = AppDataSource.getRepository(Product);
  const products: Product[] = [];
  for (const p of PRODUCTS) {
    let product = await productRepo.findOneBy({ name: p.name });
    if (!product) product = await productRepo.save(productRepo.create(p));
    products.push(product);
  }

  const orderRepo = AppDataSource.getRepository(Order);
  const existing = await orderRepo.find({ relations: { user: true, items: { product: true } } });
  const existingKeys = new Set(
    existing.map((o) => orderKey(o.user.id, o.items.map((it) => ({ productId: it.product.id, quantity: it.quantity })))),
  );

  const newOrders: Order[] = [];
  for (let i = 0; i < 10; i++) {
    const a = products[i % products.length];
    const b = products[(i + 2) % products.length];
    const user = users[i % users.length];
    const itemSpecs: ItemSpec[] = [
      { productId: a.id, quantity: (i % 3) + 1 },
      { productId: b.id, quantity: 1 },
    ];

    if (existingKeys.has(orderKey(user.id, itemSpecs))) continue; // this exact seed order is already there

    const itemA = new OrderItem();
    itemA.product = a;
    itemA.quantity = itemSpecs[0].quantity;
    itemA.unitPriceCents = a.priceCents;

    const itemB = new OrderItem();
    itemB.product = b;
    itemB.quantity = itemSpecs[1].quantity;
    itemB.unitPriceCents = b.priceCents;

    const order = new Order();
    order.user = user;
    order.status = ORDER_STATUSES[i % ORDER_STATUSES.length];
    order.items = [itemA, itemB];
    order.totalAmountCents = itemA.quantity * itemA.unitPriceCents + itemB.quantity * itemB.unitPriceCents;
    newOrders.push(order);
  }

  if (newOrders.length > 0) {
    await orderRepo.save(newOrders); // cascade: true on Order.items — inserts orders + order_items in one call
    console.log(`Seeded ${newOrders.length} order(s) (${existing.length} already present).`);
  } else {
    console.log(`All 10 seed orders already present (${existing.length} found) — skipping.`);
  }

  const counts = {
    users: await userRepo.count(),
    products: await productRepo.count(),
    orders: await orderRepo.count(),
    order_items: await AppDataSource.getRepository(OrderItem).count(),
  };
  console.log('Row counts:', counts);

  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
