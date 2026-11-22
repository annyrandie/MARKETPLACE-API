// npm run storage:init — create/configure the bucket (private, lifecycle
// rule for unfinished multipart uploads, CORS for browser PUTs). Idempotent;
// the demos run the same ensureBucket() themselves.
import { createS3, ensureBucket, storageConfigFromEnv } from './storage';

async function main(): Promise<void> {
  const cfg = storageConfigFromEnv();
  const warnings = await ensureBucket(createS3(cfg), cfg.bucket);
  console.log(`bucket ${cfg.bucket} ready at ${cfg.endpoint ?? 'AWS S3'} (private)`);
  for (const w of warnings) console.log(`  warning: ${w}`);
}

main().catch((err) => {
  console.error('storage:init failed:', err);
  process.exit(1);
});
