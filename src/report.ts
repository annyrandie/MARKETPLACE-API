// Revenue by product — an aggregate with a JOIN and a GROUP BY. `find()`
// can't express this at all: its whole job is "give me entities that exist
// in the DB", not "give me a row a GROUP BY invented". That's the actual
// line this project draws between Repository and QueryBuilder — see
// README § Repository vs QueryBuilder for the fuller version.
import 'reflect-metadata';
import AppDataSource, { logger } from './data-source';
import { Product } from './entities/product.entity';

interface RevenueRow {
  name: string;
  units: string; // aggregates come back as strings — a bigint SUM may not fit in a JS number
  revenue_cents: string;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  logger.echo = true;

  const report = await AppDataSource.getRepository(Product)
    .createQueryBuilder('p')
    .innerJoin('order_items', 'oi', 'oi.product_id = p.id')
    .select('p.name', 'name')
    .addSelect('SUM(oi.quantity)', 'units')
    .addSelect('SUM(oi.quantity * oi.unit_price_cents)', 'revenue_cents')
    .groupBy('p.id')
    .addGroupBy('p.name')
    .orderBy('revenue_cents', 'DESC')
    .getRawMany<RevenueRow>();

  logger.echo = false;
  console.log('\nRevenue by product:');
  console.table(
    report.map((r) => ({
      name: r.name,
      units: r.units,
      revenueCents: r.revenue_cents,
      revenueUAH: (Number(r.revenue_cents) / 100).toFixed(2),
    })),
  );

  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
