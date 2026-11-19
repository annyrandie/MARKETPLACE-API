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

  // HW #14: checkout decrements this atomically, same pattern as
  // Product.stock — see src/checkout.ts.
  @Column({ type: 'int', name: 'balance_cents', default: 0 })
  balanceCents: number;

  // HW #24: scrypt hash (src/auth/password.ts); never selected by default
  // so no query that loads a User accidentally carries it around.
  @Column({ type: 'text', name: 'password_hash', nullable: true, select: false })
  passwordHash: string | null;

  // HW #24: the source of truth for authorization — the access token only
  // carries a copy (a cache until its exp). CHECK constraint in the migration.
  @Column({ type: 'varchar', length: 16, name: 'role', default: 'buyer' })
  role: 'buyer' | 'seller' | 'admin';

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];
}
