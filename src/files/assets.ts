import { createHash } from 'node:crypto';
import path from 'node:path';
import { HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Set on the OBJECT, at upload — the origin's word to every cache on the
// way. A content-addressed name never changes meaning, so a year and
// `immutable` (no revalidation even on reload) are safe. Without this
// header the edge has nothing to cache: cache-hit would be 0.
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** `app.css` + content → `app.<8 hex of sha256>.css` */
export function hashedName(logicalName: string, body: Buffer): string {
  const ext = path.extname(logicalName);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `${logicalName.slice(0, -ext.length || undefined)}.${hash}${ext}`;
}

/**
 * Deploy a public asset WITHOUT invalidation: new content → new name → new
 * URL. The old URL keeps serving the old bytes from every cache until it
 * ages out, and nobody asks for it any more (the new HTML points to the
 * new name). An object under a hashed name is never overwritten: if it
 * exists, it already holds exactly these bytes.
 */
export async function publishAsset(
  s3: S3Client,
  bucket: string,
  logicalName: string,
  body: Buffer,
  prefix = 'assets',
): Promise<{ key: string; uploaded: boolean }> {
  const key = `${prefix}/${hashedName(logicalName, body)}`;
  const exists = await s3
    .send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPES[path.extname(logicalName)] ?? 'application/octet-stream',
        CacheControl: IMMUTABLE,
      }),
    );
  }
  return { key, uploaded: !exists };
}
