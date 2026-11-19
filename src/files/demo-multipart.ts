// npm run demo:multipart — multipart is about RESUMING, not about size.
//
//  1. intent for a 12 MiB file (> the 10 MiB threshold) → multipart,
//     part size computed = 5 MiB → 3 parts (5 + 5 + 2 MiB)
//  2. client process #1 uploads parts 1 and 2 — and is SIGKILLed
//  3. the storage holds 2 parts (ListParts), but there is NO object yet:
//     HeadObject → 404 — parts are not a file until CompleteMultipartUpload
//  4. client process #2 — fresh, remembers nothing — asks the API which
//     parts the storage has (ListParts), uploads ONLY part 3 → resumed-parts=1
//  5. commit → the server completes from ListParts' ETags, HeadObject: the
//     size matches, and the ETag is "<hash>-3": N parts, NOT the file's MD5
//
// Run it twice in a row: it cleans the bucket (objects AND unfinished
// multipart uploads) before and after, so the second run's
// head-before-complete is 404 again, not the first run's object.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import { openFilesDemo, parseKv, runClient } from './demo-kit';
import { partSizeFor } from './upload-policy';

const MiB = 1024 * 1024;
const FILE_SIZE = 12 * MiB;

async function main(): Promise<void> {
  const demo = await openFilesDemo('multipart', { buyer: 'buyer' });
  const { buyer } = demo.users;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'demo-multipart-'));
  demo.onCleanup(async () => rmSync(tmp, { recursive: true, force: true }));

  // a "DB dump": gzip magic bytes + random content
  const file = path.join(tmp, 'backup.dump.gz');
  const bytes = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), randomBytes(FILE_SIZE - 4)]);
  writeFileSync(file, bytes);
  const md5 = createHash('md5').update(bytes).digest('hex');

  const token = (await demo.login(buyer)).body.access_token as string;
  const intent = await demo.call('POST', '/uploads/intent', {
    token,
    body: { filename: 'backup.dump.gz', content_type: 'application/gzip', size: FILE_SIZE },
  });
  const { file_id: fileId, key, part_size: partSize, parts_count: partsCount } = intent.body;
  console.error(`  ${FILE_SIZE} bytes → ${partsCount} parts × ${partSize} bytes (computed: ${partSizeFor(FILE_SIZE)})`);

  const clientEnv = { API_URL: demo.baseUrl, ACCESS_TOKEN: token, FILE_ID: fileId, FILE_PATH: file };

  // 2. first client dies after two parts
  const first = await runClient('client-multipart.js', [], { ...clientEnv, CRASH_AFTER: '2' });

  // 3. what the storage holds now (the demo's privileged view)
  const uploadId = (await demo.pool.query<{ upload_id: string }>(`SELECT upload_id FROM files WHERE id = $1`, [fileId])).rows[0]
    .upload_id;
  const listed = await demo.s3.send(new ListPartsCommand({ Bucket: demo.storage.bucket, Key: key, UploadId: uploadId }));
  const headBefore = await demo.s3
    .send(new HeadObjectCommand({ Bucket: demo.storage.bucket, Key: key }))
    .then(() => 200)
    .catch((err) => err?.$metadata?.httpStatusCode ?? 0);

  // 4. a fresh process resumes
  const second = await runClient('client-multipart.js', [], clientEnv);
  const resumed = parseKv(second.stdout);

  // 5. complete (server-side, from ListParts) + verify
  const commit = await demo.call('POST', '/uploads/commit', { token, body: { file_id: fileId } });
  const head = await demo.s3.send(new HeadObjectCommand({ Bucket: demo.storage.bucket, Key: key }));
  const etag = (head.ETag ?? '').replace(/"/g, '');

  await demo.finish(
    {
      'file-size': FILE_SIZE,
      'part-size': partSize,
      parts: partsCount,
      'first-client-killed': first.signal === 'SIGKILL' ? 1 : 0,
      'parts-before-resume': listed.Parts?.length ?? 0,
      'head-before-complete': headBefore,
      'already-on-server': Number(resumed['already-on-server'] ?? -1),
      'resumed-parts': Number(resumed['uploaded-this-run'] ?? -1),
      complete: commit.status,
      'size-match': head.ContentLength === FILE_SIZE && commit.body?.size === FILE_SIZE ? 1 : 0,
      'etag-multipart': etag.endsWith(`-${partsCount}`) ? 1 : 0,
      'etag-is-md5': etag === md5 ? 1 : 0,
    },
    {
      'planned as 3 computed parts': intent.status === 200 && intent.body.mode === 'multipart' && partsCount === 3 && partSize === partSizeFor(FILE_SIZE),
      'first client really died after 2 parts': first.signal === 'SIGKILL' && listed.Parts?.length === 2,
      'parts are not an object: HEAD → 404': headBefore === 404,
      'resume uploaded only the missing part': resumed['already-on-server'] === '2' && resumed['uploaded-this-run'] === '1',
      'complete → 200 COMPLETED': commit.status === 200 && commit.body?.status === 'COMPLETED',
      'size matches': head.ContentLength === FILE_SIZE,
      'ETag is <hash>-N, not the MD5': etag.endsWith(`-${partsCount}`) && etag !== md5,
    },
  );
}

main().catch((err) => {
  console.error('demo:multipart failed:', err);
  process.exit(1);
});
