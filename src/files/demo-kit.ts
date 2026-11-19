// Shared plumbing for HW #26's demos. On top of HW #24's kit (own users,
// the real app as a child process, cleanup on every exit path) this adds
// the storage side of "bring state to clean": every object under the demo
// users' prefixes AND every unfinished multipart upload there — an
// unfinished upload isn't an object (HeadObject can't see it, a listing of
// objects doesn't show it) but it holds parts, and the storage bills them.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { openAuthDemo, type AuthDemo } from '../auth/demo-kit';
import type { Role } from '../auth/tokens';
import { createS3, ensureBucket, storageConfigFromEnv, type StorageConfig } from './storage';

/** Delete everything under `prefix`: objects, then unfinished uploads. */
export async function purgePrefix(s3: S3Client, bucket: string, prefix: string): Promise<{ objects: number; uploads: number }> {
  let objects = 0;
  let uploads = 0;
  for (let token: string | undefined; ; ) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
      objects += keys.length;
    }
    if (!page.IsTruncated) break;
    token = page.NextContinuationToken;
  }
  for (;;) {
    const page = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
    for (const u of page.Uploads ?? []) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key!, UploadId: u.UploadId! }));
      uploads += 1;
    }
    if (!page.IsTruncated || !(page.Uploads ?? []).length) break;
  }
  return { objects, uploads };
}

export interface FilesDemo extends AuthDemo {
  s3: S3Client;
  storage: StorageConfig;
}

/** The demo's own S3 client is privileged (vault credentials) — it plays
 *  the operator checking the storage, never the uploading client. */
export async function openFilesDemo(tag: string, specs: Record<string, Role>, appEnv?: Record<string, string>): Promise<FilesDemo> {
  const storage = storageConfigFromEnv();
  const s3 = createS3(storage);
  const warnings = await ensureBucket(s3, storage.bucket);
  for (const w of warnings) console.error(`(storage) ${w}`);

  const purgeUsers = async (ids: string[]) => {
    for (const id of ids) await purgePrefix(s3, storage.bucket, `uploads/${id}/`);
  };
  const demo = await openAuthDemo(tag, specs, { beforeReset: (_pool, oldIds) => purgeUsers(oldIds), appEnv });
  demo.onCleanup(() => purgeUsers(Object.values(demo.users).map((u) => u.id)));
  // spread would evaluate the baseUrl/port getters once — keep them live
  return Object.assign(demo, { s3, storage });
}

/** Is anything listening? A raw TCP connect, NOT fetch: fetch's pool can
 *  hold a socket to a dead server and hang instead of failing. */
export function isPortAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(1000);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Run one of the "client" scripts as a separate process whose environment
 * holds NO credentials of ours — no storage keys, no DB, no signing key.
 * Only PATH plus what the caller passes (a URL, a user's access token).
 * Whatever it manages to upload, it uploads with the presigned URL alone.
 */
export function runClient(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.once('error', reject);
    proc.once('exit', (code, signal) => resolve({ code, signal, stdout }));
  });
}

/** `key=value` lines a client printed → a record. */
export function parseKv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^([a-z0-9-]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
