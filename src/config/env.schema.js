// Single source of truth for configuration. Fail-fast, not fail-late: the
// process either starts with a fully valid config, or doesn't start at all —
// and says in plain language which variables are broken, before any DI/HTTP
// setup happens. `validate()` is pure (no process.exit here) so it stays
// testable and reusable; the caller (app.js) decides what to do on failure.
const { z } = require('zod');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Password is deliberately NOT part of this URL — it lives in
  // DB_PASSWORD_FILE and is re-read on every new pg connection, so it can be
  // rotated without touching this variable or restarting the process.
  DB_URL: z.url({ protocol: /^postgres$/ }),

  DB_PASSWORD_FILE: z.string().min(1).default('secrets/db_password'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

/** @param {Record<string, unknown>} raw
 *  @returns {Readonly<z.infer<typeof envSchema>>} */
function validate(raw) {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${lines}\nCompare your .env with .env.example.`);
  }
  return Object.freeze(parsed.data);
}

module.exports = { envSchema, validate };
