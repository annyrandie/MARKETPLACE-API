// N+1, demonstrated on the graph the assignment asks for: order → items →
// product (two relation levels). N+1 never shows up by reading the
// TypeScript — only in the SQL query log, which is exactly what
// QueryCountLogger exists to count.
import 'reflect-metadata';
import AppDataSource, { logger } from './data-source';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  logger.echo = false;

  const orderRepo = AppDataSource.getRepository(Order);
  const itemRepo = AppDataSource.getRepository(OrderItem);

  console.log('── Naive: find() + a query per order for its items, + a query per item for its product ──');
  logger.echo = true;
  logger.reset();
  const orders = await orderRepo.find(); // 1 query
  for (const order of orders) {
    const items = await itemRepo.find({ where: { order: { id: order.id } } }); // N queries — one per order
    for (const item of items) {
      // one more query per item, just to reach `product` — this is the
      // second relation level compounding the first
      await itemRepo.findOne({ where: { id: item.id }, relations: { product: true } });
    }
  }
  const naiveCount = logger.count;
  console.log(`Total queries: ${naiveCount} for ${orders.length} orders\n`);

  console.log('── Fix 1: relations (2 levels) → one query with LEFT JOINs ──');
  logger.reset();
  const withRelations = await orderRepo.find({ relations: { items: { product: true } } });
  const joinCount = logger.count;
  console.log(`Total queries: ${joinCount}, orders: ${withRelations.length}\n`);

  console.log('── Fix 2: relationLoadStrategy: "query" — no JOIN, still not N+1 ──');
  console.log('   (useful when a JOIN would multiply rows: one order × many items)');
  logger.reset();
  const withQueryStrategy = await orderRepo.find({
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });
  const queryStrategyCount = logger.count;
  console.log(`Total queries: ${queryStrategyCount}, orders: ${withQueryStrategy.length}\n`);

  logger.echo = false;
  console.log(`Summary: ${naiveCount} (naive, grows with the number of orders) → ${joinCount} (LEFT JOIN) or ${queryStrategyCount} (query strategy — constant, independent of N).`);
  console.log('N+1 is invisible in the TypeScript above — only the SQL log shows it. Always run with logging on when chasing it.');

  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
