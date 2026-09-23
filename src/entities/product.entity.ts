import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { OrderItem } from './order-item.entity';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 200, name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'description' })
  description: string;

  // Money as an integer in minor units (cents), never float — 0.1 + 0.2 !==
  // 0.3. db/schema.sql (HW #12) used `numeric(10,2)` for the same reason
  // (Postgres numeric is exact decimal, not float); this ORM layer follows
  // this HW's own instruction to use integer minor units instead — see
  // README for the reasoning behind the two different, both legitimate,
  // choices living in two parallel artifacts of the same design.
  @Column({ type: 'int', name: 'price_cents' })
  priceCents: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  // A tsvector column can't be expressed as `GENERATED ALWAYS AS (...)
  // STORED` through a plain @Column decorator — TypeORM has no first-class
  // support for Postgres generated columns. select/insert/update are all
  // false: the app never writes this column, Postgres computes it, and the
  // migration (hand-edited after migration:generate — see its own comment)
  // is what actually adds the GENERATED clause and the GIN index.
  @Column({ type: 'tsvector', name: 'search_vector', select: false, insert: false, update: false, nullable: true })
  searchVector: string;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems: OrderItem[];
}
