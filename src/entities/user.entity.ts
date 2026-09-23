import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany, Index } from 'typeorm';
import { Order } from './order.entity';

@Entity('users')
export class User {
  // bigint PKs come back from node-postgres as strings — that's not a
  // TypeORM quirk, it's precision: a bigint can exceed Number.MAX_SAFE_INTEGER.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255, name: 'email' })
  email: string;

  @Column({ type: 'varchar', length: 200, name: 'full_name' })
  fullName: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];
}
