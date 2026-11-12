import { MigrationInterface, QueryRunner } from "typeorm";

// HW #22: transactional outbox + the idempotency it costs. Hand-written,
// not `migration:generate` — none of these four tables is an entity
// (they're written with raw SQL from checkout.ts / src/outbox/*), and a
// partial index isn't something the generator would ever emit anyway.
export class Outbox1793570000000 implements MigrationInterface {
    name = 'Outbox1793570000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Field roles match what Debezium's Outbox Event Router reads
        // (aggregatetype / aggregateid / type / payload), so a later move
        // from this polling relay to CDC doesn't rewrite any consumer.
        // Snake_case on purpose — the router's canonical names have no
        // underscores, so that move means overriding
        // `route.by.field=aggregate_type` and
        // `table.field.event.key=aggregate_id` (README, "Outbox").
        await queryRunner.query(`
            CREATE TABLE "outbox" (
                "id"             BIGSERIAL PRIMARY KEY,
                "aggregate_type" varchar(50)  NOT NULL,
                "aggregate_id"   varchar(64)  NOT NULL,
                "type"           varchar(100) NOT NULL,
                "payload"        jsonb        NOT NULL,
                "created_at"     timestamptz  NOT NULL DEFAULT now(),
                "published_at"   timestamptz,
                "attempts"       integer      NOT NULL DEFAULT 0
            )`);
        // The relay's one query, and only the rows it can still pick:
        // published rows drop out of this index the moment they're marked,
        // so it stays as small as the backlog, not as large as the table.
        await queryRunner.query(
            `CREATE INDEX "IDX_outbox_unpublished" ON "outbox" ("created_at", "id") WHERE "published_at" IS NULL`,
        );

        // Inbox (level 2): one row per (message, consumer) — the PK IS the
        // dedup, claimed with ON CONFLICT DO NOTHING in the same
        // transaction as the effect itself.
        await queryRunner.query(`
            CREATE TABLE "processed_messages" (
                "message_id"   varchar(200) NOT NULL,
                "consumer"     varchar(100) NOT NULL,
                "processed_at" timestamptz  NOT NULL DEFAULT now(),
                PRIMARY KEY ("message_id", "consumer")
            )`);

        // The invoicing consumer's effect (level 1): its natural key is the
        // order itself — one invoice per order, so a replay is an
        // ON CONFLICT no-op, not a second invoice. No FK to orders on
        // purpose: this table belongs to the consumer side, which in a real
        // split would be another service with its own database.
        await queryRunner.query(`
            CREATE TABLE "order_invoices" (
                "order_id"    bigint      PRIMARY KEY,
                "user_id"     bigint      NOT NULL,
                "total_cents" integer     NOT NULL,
                "created_at"  timestamptz NOT NULL DEFAULT now()
            )`);

        // Level 3, the API edge: Idempotency-Key → the order it produced.
        // Scoped per buyer — clients generate keys themselves, so a key is
        // only unique within one client; two buyers who happen to pick the
        // same key are two different intents, not a conflict. `request` is
        // only there to refuse one key reused for a different order (422)
        // — it is never the dedup key itself.
        await queryRunner.query(`
            CREATE TABLE "idempotency_keys" (
                "user_id"     bigint       NOT NULL,
                "key"         varchar(200) NOT NULL,
                "request"     jsonb        NOT NULL,
                "order_id"    bigint       REFERENCES "orders" ("id") ON DELETE CASCADE,
                "total_cents" integer,
                "created_at"  timestamptz  NOT NULL DEFAULT now(),
                PRIMARY KEY ("user_id", "key")
            )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "idempotency_keys"`);
        await queryRunner.query(`DROP TABLE "order_invoices"`);
        await queryRunner.query(`DROP TABLE "processed_messages"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_outbox_unpublished"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
    }

}
