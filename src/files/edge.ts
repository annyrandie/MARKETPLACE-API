// The edge: a tiny shared cache in front of the PRIVATE bucket — the local
// form of CloudFront + Origin Access Control. The public talks only to
// this; this talks to the storage with its OWN credentials (in AWS terms:
// the distribution's OAC identity, the only principal the bucket policy
// lets in). A direct anonymous GET on the bucket stays 403.
//
//   npm run edge                                  (EDGE_PORT, default 9180)
//
// What it caches is decided by the ORIGIN's Cache-Control, set on the
// object when it was uploaded (see assets.ts) — never by the edge: no
// `public, max-age` on the object → nothing cached, every request a MISS.
// Only the `assets/` prefix is served: user uploads (uploads/…) are
// private and go through GET /files/:id, never through a public cache.
import http from 'node:http';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createS3, storageConfigFromEnv } from './storage';

interface Entry {
  body: Buffer;
  headers: Record<string, string>;
  expiresAt: number;
}

function freshFor(cacheControl: string | undefined): number {
  const cc = (cacheControl ?? '').toLowerCase();
  if (!/\bpublic\b/.test(cc) || /\b(private|no-store|no-cache)\b/.test(cc)) return 0;
  const m = /\b(?:s-maxage|max-age)=(\d+)/.exec(cc);
  return m ? Number(m[1]) : 0;
}

export function createEdgeServer(s3: S3Client, bucket: string): http.Server {
  const cache = new Map<string, Entry>();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://edge');
    if (url.pathname === '/healthz') return void res.end('ok');
    const key = decodeURIComponent(url.pathname.slice(1));
    if (req.method !== 'GET' || !key.startsWith('assets/') || key.includes('..')) {
      res.writeHead(404).end();
      return;
    }

    let entry = cache.get(key);
    let state: 'HIT' | 'MISS' = 'HIT';
    if (!entry || entry.expiresAt <= Date.now()) {
      state = 'MISS';
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const headers: Record<string, string> = {
          'content-type': obj.ContentType ?? 'application/octet-stream',
          ...(obj.CacheControl ? { 'cache-control': obj.CacheControl } : {}),
          ...(obj.ETag ? { etag: obj.ETag } : {}),
        };
        entry = { body: Buffer.from(await obj.Body!.transformToByteArray()), headers, expiresAt: 0 };
        const ttl = freshFor(obj.CacheControl);
        if (ttl > 0) {
          entry.expiresAt = Date.now() + ttl * 1000;
          cache.set(key, entry);
        }
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        res.writeHead(status === 404 ? 404 : 502, { 'x-cache': 'MISS' }).end();
        return;
      }
    }

    if (entry.headers.etag && req.headers['if-none-match'] === entry.headers.etag) {
      res.writeHead(304, { etag: entry.headers.etag, 'x-cache': state }).end();
      return;
    }
    res.writeHead(200, { ...entry.headers, 'content-length': String(entry.body.length), 'x-cache': state });
    res.end(entry.body);
  });
}

if (require.main === module) {
  const cfg = storageConfigFromEnv();
  const port = Number(process.env.EDGE_PORT ?? 9180);
  const server = createEdgeServer(createS3(cfg), cfg.bucket);
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    console.log(`edge listening on http://127.0.0.1:${addr.port} → bucket ${cfg.bucket} (private, read with the edge's own credentials)`);
    process.send?.({ port: addr.port });
  });
}
