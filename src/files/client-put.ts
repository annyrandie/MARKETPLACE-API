// A "browser" for demo:upload: PUTs a file to a presigned URL and prints
// the storage's status. Started by the demo as a separate process with no
// credentials in its environment (see demo-kit.ts, runClient) — and while
// our API is DOWN. A 200 here means the bytes reached the storage without
// us: no proxy, no keys, only the signature in the URL.
//
//   node dist/files/client-put.js <presigned-url> <file> <content-type>
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  const [url, file, contentType] = process.argv.slice(2);
  const credentialVars = Object.keys(process.env).filter((k) => /^(STORAGE_|AWS_|DB_|JWT_|REFRESH_)/.test(k));
  const res = await fetch(url, { method: 'PUT', body: readFileSync(file), headers: { 'content-type': contentType } });
  await res.arrayBuffer();
  console.log(`status=${res.status}`);
  console.log(`credential-vars=${credentialVars.length}`);
}

main().catch((err) => {
  console.error('client-put failed:', err instanceof Error ? err.message : err);
  console.log('status=0');
  process.exit(1);
});
