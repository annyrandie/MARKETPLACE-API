import { Queryable } from './queryable';

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  balance_cents: number;
  created_at: Date;
}

// HW #16: deliberately NOT built on TypeORM's Repository — it accepts a
// bare Queryable (Pool or a single transaction-scoped Client) so the
// integration suite's ROLLBACK isolation strategy (test/integration/testkit)
// can hand it a Client mid-transaction instead of the pool. TypeORM's own
// Repository is tied to its DataSource/EntityManager and doesn't offer that
// seam directly.
export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(email: string, fullName: string): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, full_name) VALUES ($1, $2)
       RETURNING id, email, full_name, balance_cents, created_at`,
      [email, fullName],
    );
    return rows[0];
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id, email, full_name, balance_cents, created_at FROM users WHERE email = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  // ON CONFLICT upsert, made possible by the UNIQUE index on `email` that HW
  // #13's InitSchema migration already puts on this table — a second call
  // with the same email updates the existing row in place instead of
  // erroring, and the row count never grows past 1.
  async upsertByEmail(email: string, fullName: string): Promise<UserRow> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, full_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, email, full_name, balance_cents, created_at`,
      [email, fullName],
    );
    return rows[0];
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>('SELECT count(*) FROM users');
    return Number(rows[0].count);
  }
}
