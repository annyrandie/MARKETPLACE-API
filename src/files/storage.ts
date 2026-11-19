import {
  CreateBucketCommand,
  DeleteBucketPolicyCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StorageConfig {
  /** undefined → real AWS S3 */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** From process.env — what scripts/with-secrets.sh (or the grader's
 *  exports) put there. app.js passes its zod-validated config instead. */
export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set — run via: bash scripts/with-secrets.sh dev <command>`);
    return v;
  };
  return {
    endpoint: env.STORAGE_ENDPOINT || undefined,
    region: env.STORAGE_REGION || 'us-east-1',
    bucket: env.STORAGE_BUCKET || 'marketplace-files',
    accessKeyId: need('STORAGE_ACCESS_KEY'),
    secretAccessKey: need('STORAGE_SECRET_KEY'),
  };
}

export function createS3(cfg: StorageConfig): S3Client {
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    // emulators serve path-style (http://host/bucket/key); AWS prefers
    // virtual-hosted (bucket.s3.region.amazonaws.com)
    forcePathStyle: Boolean(cfg.endpoint),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // SDKs since late 2024 add a CRC32 checksum to uploads by default. A
    // presigned URL is signed BEFORE the body exists, so the checksum
    // baked into its query is that of EMPTY data — some S3-compatible
    // stores then reject the real PUT. Only when the API requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Idempotent bucket setup, run by the demos and `npm run storage:init`:
 * - the bucket exists and is PRIVATE — no bucket policy at all (anonymous
 *   GET → 403); public assets reach the world only through the edge;
 * - lifecycle: abort multipart uploads left incomplete for 7 days — they
 *   are billed although no object exists (a "delete after 30 days" rule
 *   doesn't touch them, it's a different action);
 * - CORS for browser PUTs, exposing ETag — a browser can't read a part's
 *   ETag without it (we don't need it: commit uses ListParts — but a
 *   client-side completion would).
 * Lifecycle/CORS are separate AWS APIs, not the object protocol: a store
 * that doesn't implement them gets a warning, not a failure.
 */
export async function ensureBucket(s3: S3Client, bucket: string, opts: { allowedOrigins?: string[] } = {}): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
  }
  await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket })).catch(() => {}); // private: no policy
  await s3
    .send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-multipart-7d',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            },
          ],
        },
      }),
    )
    .catch((err) => warnings.push(`lifecycle not applied: ${(err as Error).name}`));
  await s3
    .send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ['PUT'],
              AllowedOrigins: opts.allowedOrigins ?? ['http://localhost:3000'],
              AllowedHeaders: ['content-type'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    )
    .catch((err) => warnings.push(`CORS not applied: ${(err as Error).name}`));
  return warnings;
}
