import { MigrationInterface, QueryRunner } from "typeorm";

// Hand-edited after `migration:generate` — the generator has no idea a
// tsvector column is supposed to be a Postgres GENERATED ALWAYS ... STORED
// expression (TypeORM's @Column decorator can't express that at all), so it
// emitted a plain, unpopulated tsvector column and no index for it. Fixed
// by hand below to match db/schema.sql's design from HW #12: the column
// computes itself from name + description on every INSERT/UPDATE, and a
// GIN index makes it actually searchable.
export class InitSchema1790194161630 implements MigrationInterface {
    name = 'InitSchema1790194161630'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "products" ("id" BIGSERIAL NOT NULL, "name" character varying(200) NOT NULL, "description" text NOT NULL, "price_cents" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || description)) STORED, CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_products_search_vector" ON "products" USING GIN ("search_vector")`);
        await queryRunner.query(`CREATE TABLE "order_items" ("id" BIGSERIAL NOT NULL, "quantity" integer NOT NULL, "unit_price_cents" integer NOT NULL, "order_id" bigint NOT NULL, "product_id" bigint NOT NULL, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_145532db85752b29c57d2b7b1f" ON "order_items" ("order_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_9263386c35b6b242540f9493b0" ON "order_items" ("product_id") `);
        await queryRunner.query(`CREATE TABLE "orders" ("id" BIGSERIAL NOT NULL, "status" character varying(20) NOT NULL, "total_amount_cents" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint NOT NULL, CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a922b820eeef29ac1c6800e826" ON "orders" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" BIGSERIAL NOT NULL, "email" character varying(255) NOT NULL, "full_name" character varying(200) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a922b820eeef29ac1c6800e826"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9263386c35b6b242540f9493b0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_145532db85752b29c57d2b7b1f"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_products_search_vector"`);
        await queryRunner.query(`DROP TABLE "products"`);
    }

}
