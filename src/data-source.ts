// No hardcoded host/port/user/password here, and no reading of a second env
// file — every value comes from process.env, which scripts/with-secrets.sh
// populates before this module is ever imported (see its header comment for
// where those values actually come from). Nothing here is a fallback default
// either: if a variable is missing, `new DataSource(...)` gets `undefined`
// and TypeORM/pg fail loudly at connect time — that's intentional, not an
// oversight, the same fail-fast spirit as HW #11's zod schema.
import 'reflect-metadata';
import { DataSource, AbstractLogger, LogMessage, LogLevel } from 'typeorm';
import { User } from './entities/user.entity';
import { Product } from './entities/product.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';

// Counts real SQL round-trips — the one tool that actually shows N+1
// (it never shows up by reading the TypeScript, only in the query log).
export class QueryCountLogger extends AbstractLogger {
  count = 0;
  echo = false; // demos flip this on when they want the SQL printed too

  reset(): void {
    this.count = 0;
  }

  protected writeLog(_level: LogLevel, messages: LogMessage | LogMessage[]): void {
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (m.type === 'query') {
        this.count += 1;
        if (this.echo) {
          console.log(`  SQL#${this.count}: ${String(m.message).slice(0, 140)}`);
        }
      } else {
        // Everything that isn't a query — schema-build output for the CLI
        // (migration:show's "[X] Name" lines run through exactly this path,
        // via logSchemaBuild()), warnings, etc. Always shown, not gated
        // behind `echo`: only query counting is opt-in, plain log output
        // silently disappearing would just be a bug.
        console.log(String(m.message));
      }
    }
  }
}

// 'all', not ['query'] — AbstractLogger gates schema-build/log/error
// messages behind `isLogEnabledFor`, checked against these constructor
// options BEFORE writeLog() ever runs. ['query'] alone silently drops
// migration:show's "[X] Name" output (that's a logSchemaBuild() call) —
// writeLog() below never even gets the chance to print it.
export const logger = new QueryCountLogger('all');

// Only one exported DataSource instance in this file — the CLI
// (`typeorm migration:generate -d dist/data-source.js ...`) errors out
// ("must contain only one export of DataSource instance") if it finds the
// same instance under two export names.
const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER, // pg's own driver wants `user`; TypeORM's option is `username`
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Product, Order, OrderItem],
  migrations: ['dist/migrations/*.js'],
  synchronize: false, // schema comes from migrations, never from entity metadata at runtime
  logger,
});

export default AppDataSource;
