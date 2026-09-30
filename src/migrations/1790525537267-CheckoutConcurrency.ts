import { MigrationInterface, QueryRunner } from "typeorm";

// Hand-edited after `migration:generate` — same reason as InitSchema's own
// comment: the generator compares entity metadata against the live schema,
// and `Product.searchVector` is declared as a plain readonly @Column (no
// `@Generated`), not as the `GENERATED ALWAYS AS (...) STORED` expression
// it actually is in Postgres. The generator "fixed" that mismatch by
// emitting DROP INDEX + a RENAME/re-ADD dance that would have converted the
// generated column into an ordinary one (losing its GENERATED behavior
// entirely) and rebuilt the index as a plain B-tree, not GIN. All of that
// — 6 statements in up(), 4 in down() — is removed below; this migration
// only does what it's actually named for: the HW #14 checkout schema.
//
// One more hand-add: `typeorm_metadata`. InitSchema (HW #13) never created
// it — TypeORM only auto-creates it via `synchronize()`, and that project
// deliberately never runs synchronize. Its absence is exactly what made
// generating *this* migration fail with `relation "typeorm_metadata" does
// not exist` before this table existed. Creating it here, once, means the
// next migration generated against this schema (HW #15/#16) doesn't hit
// the same wall.
export class CheckoutConcurrency1790525537267 implements MigrationInterface {
    name = 'CheckoutConcurrency1790525537267'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "typeorm_metadata" ("type" character varying NOT NULL, "database" character varying, "schema" character varying, "table" character varying, "name" character varying, "value" text)`);
        await queryRunner.query(`CREATE TABLE "job_queue" ("id" BIGSERIAL NOT NULL, "kind" character varying(50) NOT NULL, "payload" jsonb NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'pending', "processed_count" integer NOT NULL DEFAULT '0', "worker_id" character varying(50), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_276b4a8597badbcd15d9fae6115" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_025b3f44c2e432020bc66bc9f5" ON "job_queue" ("status") `);
        await queryRunner.query(`ALTER TABLE "products" ADD "stock" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "balance_cents" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance_cents"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "stock"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_025b3f44c2e432020bc66bc9f5"`);
        await queryRunner.query(`DROP TABLE "job_queue"`);
        // Deliberately NOT dropping "typeorm_metadata" here: it's shared
        // infrastructure created once for later migrations (HW #15/#16) to
        // rely on, not something this migration owns. Reverting this HW
        // must not tear down infrastructure that other migrations use.
    }

}
