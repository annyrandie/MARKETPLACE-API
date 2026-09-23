import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Order } from './order.entity';
import { Product } from './product.entity';

// This is the M:N-with-data case from the assignment: an order and a
// product relate through quantity and a historical unit price — data that
// lives ON the relationship, not just a bridge between two ids. That rules
// out @ManyToMany (which only models a bare link table); it has to be an
// explicit join entity, wired as two @ManyToOne sides instead.
@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  // Deleted order → its line items describe nothing on their own → CASCADE.
  @Index()
  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  // A product referenced by real sales history must not disappear from
  // under it → RESTRICT (db/schema.sql, HW #12, encodes the same choice
  // structurally: no ON DELETE clause on this FK, and Postgres's default,
  // NO ACTION, behaves like RESTRICT here).
  @Index()
  @ManyToOne(() => Product, (product) => product.orderItems, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'product_id' })
  product: Product;

  @Column({ type: 'int', name: 'quantity' })
  quantity: number;

  // The price AT THE TIME of purchase — never product.priceCents, which
  // can change after the fact. Historical truth, not a live join.
  @Column({ type: 'int', name: 'unit_price_cents' })
  unitPriceCents: number;
}
