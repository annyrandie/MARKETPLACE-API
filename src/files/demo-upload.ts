// npm run demo:upload — the bytes go PAST our service.
//
//  1. intent with a hostile filename (../../etc/passwd)  → 200; the key is
//     the server's own uploads/{user}/{uuid}.png — nothing of the filename
//  2. a second intent, commit with NO bytes uploaded      → 409 (HeadObject
//     says there's nothing — without it, the "file" would be COMPLETED)
//  3. the URL from (1) with another key in its path       → 403 (the
//     signature covers the path)
//  4. STOP the API                                        → api-alive=0
//  5. a separate process with NO credentials PUTs the bytes to the URL
//     from (1)                                            → 200 (put-offline)
//  6. API back up — on a NEW port — commit (1)            → 200, COMPLETED
//     (+ GET /files/:id → 302 → the same bytes back, straight from storage)
//  7. a URL issued with a short lifetime, used after it   → 403 (expired)
//
// For (7) the restarted app gets UPLOAD_URL_TTL_SECONDS=2 — the production
// value is 300 s (README, Files), too long to wait out in a demo; what's
// proven is "this exact URL dies at its expiry", whatever the number.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { isPortAlive, openFilesDemo, parseKv, runClient } from './demo-kit';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHORT_TTL_SECONDS = 2;

async function main(): Promise<void> {
  const demo = await openFilesDemo('upload', { buyer: 'buyer' });
  const { buyer } = demo.users;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'demo-upload-'));
  demo.onCleanup(async () => rmSync(tmp, { recursive: true, force: true }));

  // a small, genuine-looking PNG (commit checks the signature bytes)
  const file = path.join(tmp, 'avatar.png');
  writeFileSync(file, Buffer.concat([PNG_SIGNATURE, randomBytes(48 * 1024)]));
  const bytes = readFileSync(file);

  const token = (await demo.login(buyer)).body.access_token as string;
  const intentBody = (filename: string) => ({ filename, content_type: 'image/png', size: bytes.length });

  // 1. intent — hostile filename
  const hostile = '../../etc/passwd';
  const intent = await demo.call('POST', '/uploads/intent', { token, body: intentBody(hostile) });
  const key = intent.body.key as string;
  const keyFromServer =
    new RegExp(`^uploads/${buyer.id}/[0-9a-f-]{36}\\.png$`).test(key) && !/passwd|etc|\.\./.test(key) ? 1 : 0;
  console.error(`  filename "${hostile}" → key "${key}"`);

  // 2. commit with nothing uploaded
  const empty = await demo.call('POST', '/uploads/intent', { token, body: intentBody('empty.png') });
  const commitWithoutBytes = await demo.call('POST', '/uploads/commit', { token, body: { file_id: empty.body.file_id } });

  // 3. tampered: same signature, another key in the path
  const putUrl = intent.body.put.url as string;
  const tamperedUrl = putUrl.replace(key, `uploads/${buyer.id}/evil.png`);
  const tampered = await fetch(tamperedUrl, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png' } });
  await tampered.arrayBuffer();

  // 4. our API goes away
  const oldPort = demo.port;
  await demo.stopApp();
  const apiAlive = (await isPortAlive(oldPort)) ? 1 : 0;

  // 5. the bytes travel without us, from a process with no credentials
  const client = await runClient('client-put.js', [putUrl, file, 'image/png']);
  const put = parseKv(client.stdout);
  const objectAfterPut = await demo.s3
    .send(new HeadObjectCommand({ Bucket: demo.storage.bucket, Key: key }))
    .then((h) => h.ContentLength === bytes.length)
    .catch(() => false);

  // 6. back up on a NEW port (+ short URL lifetime for step 7)
  await demo.restartApp({ UPLOAD_URL_TTL_SECONDS: String(SHORT_TTL_SECONDS) });
  const commit = await demo.call('POST', '/uploads/commit', { token, body: { file_id: intent.body.file_id } });
  const download = await demo.call('GET', `/files/${intent.body.file_id}`, { token });
  let downloadOk = 0;
  if (download.status === 302) {
    const got = await fetch(download.body.location);
    downloadOk = Buffer.from(await got.arrayBuffer()).equals(bytes) ? 1 : 0;
  }

  // 7. expired
  const shortIntent = await demo.call('POST', '/uploads/intent', { token, body: intentBody('late.png') });
  await new Promise((r) => setTimeout(r, (SHORT_TTL_SECONDS + 2) * 1000));
  const expired = await fetch(shortIntent.body.put.url, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png' } });
  await expired.arrayBuffer();

  await demo.finish(
    {
      intent: intent.status,
      'key-from-server': keyFromServer,
      'commit-without-bytes': commitWithoutBytes.status,
      tampered: tampered.status,
      'api-alive': apiAlive,
      'put-offline': Number(put.status ?? 0),
      'client-credential-vars': Number(put['credential-vars'] ?? -1),
      commit: commit.status,
      'commit-status-completed': commit.body?.status === 'COMPLETED' ? 1 : 0,
      'download-redirect': download.status,
      'download-same-bytes': downloadOk,
      expired: expired.status,
    },
    {
      'intent issued': intent.status === 200 && intent.body.mode === 'single',
      'key generated by the server, filename not in it': keyFromServer === 1,
      'commit without bytes → 4xx': commitWithoutBytes.status >= 400 && commitWithoutBytes.status < 500,
      'signature covers the key': tampered.status === 403,
      'API was down during the PUT': apiAlive === 0,
      'bytes reached storage without us, from a keyless process':
        put.status === '200' && put['credential-vars'] === '0' && objectAfterPut,
      'commit after HeadObject → 200 COMPLETED': commit.status === 200 && commit.body?.status === 'COMPLETED',
      'download is a 302 to the same bytes': download.status === 302 && downloadOk === 1,
      'expired URL → 403': expired.status === 403,
    },
  );
}

main().catch((err) => {
  console.error('demo:upload failed:', err);
  process.exit(1);
});
