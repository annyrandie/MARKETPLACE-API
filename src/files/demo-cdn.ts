// npm run demo:cdn — a CLOSED bucket behind a cache, and a deploy with
// zero invalidations.
//
//  1. publish app.css → assets/demo-cdn/app.<hash>.css with
//     Cache-Control: public, max-age=31536000, immutable (set on the OBJECT)
//  2. anonymous GET straight at the storage                → 403 (direct)
//  3. GET through the edge (its own process, its own
//     credentials — the local OAC)                         → 200, X-Cache: MISS
//  4. the same again                                        → 200, X-Cache: HIT
//  5. "deploy" new CSS → a NEW name (new hash)             → new-name=1
//  6. GET the new URL through the edge                     → 200, new bytes
//  7. the OLD URL still serves the old bytes from cache — nobody asks for it
//     any more, and nothing had to be purged: invalidations=0
//
// Self-cleaning: deletes its asset prefix before and after; the edge
// process (and its in-memory cache) dies with the demo.
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createS3, ensureBucket, storageConfigFromEnv } from './storage';
import { IMMUTABLE, publishAsset } from './assets';
import { purgePrefix } from './demo-kit';

const PREFIX = 'assets/demo-cdn';
const CSS_V1 = Buffer.from('body { color: #1a1a1a; font-family: system-ui; }\n');
const CSS_V2 = Buffer.from('body { color: #0b3d91; font-family: system-ui; }\n');

function startEdge(): Promise<{ child: ChildProcess; url: string }> {
  // the edge gets the storage credentials from the same environment the
  // wrapper gave this demo — it's the only party allowed to read the bucket
  const child = fork(path.join(__dirname, 'edge.js'), [], {
    env: { ...process.env, EDGE_PORT: '0' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.once('message', (m: { port: number }) => resolve({ child, url: `http://127.0.0.1:${m.port}` }));
    child.once('exit', (code) => reject(new Error(`edge exited early (${code})`)));
  });
}

async function get(url: string) {
  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, xCache: res.headers.get('x-cache'), cacheControl: res.headers.get('cache-control'), body };
}

async function main(): Promise<void> {
  const cfg = storageConfigFromEnv();
  const s3 = createS3(cfg);
  for (const w of await ensureBucket(s3, cfg.bucket)) console.error(`(storage) ${w}`);
  await purgePrefix(s3, cfg.bucket, `${PREFIX}/`);

  const edge = await startEdge();
  const killEdge = () => edge.child.exitCode === null && edge.child.kill('SIGKILL');
  process.on('exit', killEdge);

  let summary: Record<string, number>;
  let invariant: Record<string, boolean>;
  try {
    // 1. publish v1
    const v1 = await publishAsset(s3, cfg.bucket, 'app.css', CSS_V1, PREFIX);
    console.error(`  published ${v1.key}`);

    // 2. straight at the bucket, no credentials
    const directUrl = `${(cfg.endpoint ?? `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`).replace(/\/$/, '')}/${cfg.endpoint ? `${cfg.bucket}/` : ''}${v1.key}`;
    const direct = await fetch(directUrl);
    await direct.arrayBuffer();

    // 3-4. through the edge
    const miss = await get(`${edge.url}/${v1.key}`);
    const hit = await get(`${edge.url}/${v1.key}`);
    console.error(`  edge #1: ${miss.status} X-Cache: ${miss.xCache} · edge #2: ${hit.status} X-Cache: ${hit.xCache} · Cache-Control: ${hit.cacheControl}`);

    // 5-6. deploy v2: new content → new name → new URL
    const v2 = await publishAsset(s3, cfg.bucket, 'app.css', CSS_V2, PREFIX);
    console.error(`  deployed  ${v2.key}`);
    const fresh = await get(`${edge.url}/${v2.key}`);

    // 7. the old URL: still cached, still the old bytes, never purged
    const old = await get(`${edge.url}/${v1.key}`);

    // a private upload is NOT servable through the public edge
    const privatePath = await get(`${edge.url}/uploads/1/anything.png`);

    summary = {
      direct: direct.status,
      'edge-miss': miss.status,
      'edge-miss-header': miss.xCache === 'MISS' ? 1 : 0,
      'edge-hit': hit.status,
      'cache-hit': hit.xCache === 'HIT' ? 1 : 0,
      'immutable-header': hit.cacheControl === IMMUTABLE ? 1 : 0,
      'new-name': v2.key !== v1.key ? 1 : 0,
      'new-url': fresh.status,
      'content-changed': fresh.body.equals(CSS_V2) && !fresh.body.equals(miss.body) ? 1 : 0,
      'old-url-still-cached': old.xCache === 'HIT' && old.body.equals(CSS_V1) ? 1 : 0,
      invalidations: 0,
      'edge-serves-uploads': privatePath.status === 200 ? 1 : 0,
    };
    invariant = {
      'bucket is closed to the public (403)': direct.status === 403,
      'edge reads it: MISS then HIT': miss.status === 200 && miss.xCache === 'MISS' && hit.status === 200 && hit.xCache === 'HIT',
      'caching was decided by the object’s own Cache-Control': hit.cacheControl === IMMUTABLE,
      'new content → new name → new URL, served fresh': v2.key !== v1.key && fresh.status === 200 && fresh.body.equals(CSS_V2),
      'no invalidation needed: the old entry harms nobody': old.xCache === 'HIT' && old.body.equals(CSS_V1),
      'private uploads are not served by the public edge': privatePath.status === 404,
    };
  } finally {
    killEdge();
    await purgePrefix(s3, cfg.bucket, `${PREFIX}/`).catch(() => {});
  }

  for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);
  const broken = Object.entries(invariant).filter(([, ok]) => !ok).map(([n]) => n);
  if (broken.length) {
    console.error(`✗ invariant violated: ${broken.join(', ')}`);
    process.exit(1);
  }
  console.error('✓ invariant holds');
  process.exit(0);
}

main().catch((err) => {
  console.error('demo:cdn failed:', err);
  process.exit(1);
});
