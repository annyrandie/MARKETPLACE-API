import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HW #24: authentication + authorization.
 *
 * - users.password_hash: scrypt (see src/auth/password.ts), nullable — a
 *   user without one simply can't log in (seed/legacy rows).
 * - users.role: the source of truth for authorization. The access token
 *   carries a COPY of it (a cache, valid until exp); every refresh re-reads
 *   it from here.
 * - refresh_tokens: one row per issued refresh token. Only an HMAC of the
 *   token is stored (token_hash), so a dump of this table is not a dump of
 *   live sessions. family_id ties every rotation of one login together —
 *   that link is what reuse detection revokes. used_at marks a rotated
 *   token; seeing a used one again = compromise → revoke the family.
 * - revoked_access_tokens: the access-token denylist (jti until its exp).
 *   Same database as refresh_tokens ON PURPOSE: logout revokes the family
 *   and denylists the jti in ONE transaction — no dual write between two
 *   stores (HW #22's lesson).
 */
export class Auth1794100000000 implements MigrationInterface {
  name = 'Auth1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" text`);
    await queryRunner.query(`ALTER TABLE "users" ADD "role" character varying(16) NOT NULL DEFAULT 'buyer'`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_role" CHECK ("role" IN ('buyer', 'seller', 'admin'))`,
    );

    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"          uuid                     NOT NULL DEFAULT gen_random_uuid(),
        "family_id"   uuid                     NOT NULL,
        "user_id"     bigint                   NOT NULL,
        "token_hash"  character(64)            NOT NULL,
        "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expires_at"  TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at"     TIMESTAMP WITH TIME ZONE,
        "revoked_at"  TIMESTAMP WITH TIME ZONE,
        "replaced_by" uuid,
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_refresh_tokens_replaced_by" FOREIGN KEY ("replaced_by") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL
      )`);
    // every refresh looks a token up by its hash — unique: a collision of
    // two random 256-bit tokens' HMACs would be a bug worth failing on
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`);
    // revoking a family, and "is this family revoked?" on every request
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_family" ON "refresh_tokens" ("family_id")`);

    await queryRunner.query(`
      CREATE TABLE "revoked_access_tokens" (
        "jti"        uuid                     NOT NULL,
        "user_id"    bigint                   NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "revoked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_revoked_access_tokens" PRIMARY KEY ("jti"),
        CONSTRAINT "FK_revoked_access_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    // the denylist's "TTL": rows past expires_at are ignored by the check
    // and deleted by the cleanup in logout (see refresh-tokens.ts)
    await queryRunner.query(`CREATE INDEX "IDX_revoked_access_tokens_expires" ON "revoked_access_tokens" ("expires_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "revoked_access_tokens"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
  }
}
