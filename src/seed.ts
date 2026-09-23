// Deterministic, idempotent seed. Users/products are upserted by their
// natural key (email / name) — running this twice never duplicates them.
// Orders are guarded by a single count() check: once any exist, the second
// run skips order creation entirely rather than trying to figure out which
// of 10 specific orders are "new".
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
  const existingOrders = await orderRepo.count();

  if (existingOrders === 0) {
    const orders: Order[] = [];
    for (let i = 0; i < 10; i++) {
      const a = products[i % products.length];
      const b = products[(i + 2) % products.length];

      const itemA = new OrderItem();
      itemA.product = a;
      itemA.quantity = (i % 3) + 1;
      itemA.unitPriceCents = a.priceCents;

      const itemB = new OrderItem();
      itemB.product = b;
      itemB.quantity = 1;
      itemB.unitPriceCents = b.priceCents;

      const order = new Order();
      order.user = users[i % users.length];
      order.status = ORDER_STATUSES[i % ORDER_STATUSES.length];
      order.items = [itemA, itemB];
      order.totalAmountCents = itemA.quantity * itemA.unitPriceCents + itemB.quantity * itemB.unitPriceCents;
      orders.push(order);
    }
    await orderRepo.save(orders); // cascade: true on Order.items — inserts orders + order_items in one call
    console.log(`Seeded ${orders.length} orders.`);
  } else {
    console.log(`Orders already seeded (${existingOrders} found) — skipping.`);
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
