import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, OneToMany, JoinColumn, Index } from 'typeorm';
import { User } from './user.entity';
import { OrderItem } from './order-item.entity';

export type OrderStatus = 'pending' | 'completed' | 'cancelled';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  // History must never silently vanish because a user account did — an
  // order stays on the books even if the user is later deleted. RESTRICT:
  // deleting a user with existing orders is refused, not cascaded.
  @Index()
  @ManyToOne(() => User, (user) => user.orders, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar', length: 20, name: 'status' })
  status: OrderStatus;

  @Column({ type: 'int', name: 'total_amount_cents' })
  totalAmountCents: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  // cascade: true — save(order) with order.items set inserts the order AND
  // its items in one call.
  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true })
  items: OrderItem[];
}
