// The uploading client of demo:multipart — a separate process with no
// storage credentials. It never remembers anything between runs: each
// start asks the API which parts the STORAGE already holds
// (GET /uploads/:id/parts → ListParts on the server) and uploads only the
// missing ones, each straight to the storage on its presigned URL.
//
//   API_URL=… ACCESS_TOKEN=… FILE_ID=… FILE_PATH=… [CRASH_AFTER=2] \
//     node dist/files/client-multipart.js
//
// CRASH_AFTER=n: SIGKILL itself right after the n-th part of this run —
// the "connection dropped / laptop lid closed" half of the demo. A real
// kill, not a return: nothing gets to clean up or save state.
import { openSync, readSync, closeSync } from 'node:fs';

interface PartsResponse {
  uploaded: Array<{ part_number: number }>;
  missing: Array<{ part_number: number; url: string; start: number; end: number }>;
}

function readRange(file: string, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start + 1);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}

async function main(): Promise<void> {
  const { API_URL, ACCESS_TOKEN, FILE_ID, FILE_PATH } = process.env;
  const crashAfter = Number(process.env.CRASH_AFTER ?? 0);
  const res = await fetch(`${API_URL}/uploads/${FILE_ID}/parts`, { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`GET parts → ${res.status} ${await res.text()}`);
  const plan = (await res.json()) as PartsResponse;
  console.log(`already-on-server=${plan.uploaded.length}`);
  console.error(`  [client pid ${process.pid}] storage already has parts [${plan.uploaded.map((p) => p.part_number).join(',')}], sending [${plan.missing.map((p) => p.part_number).join(',')}]`);

  let sent = 0;
  for (const part of plan.missing) {
    const put = await fetch(part.url, { method: 'PUT', body: new Uint8Array(readRange(FILE_PATH!, part.start, part.end)) });
    await put.arrayBuffer();
    if (!put.ok) throw new Error(`part ${part.part_number} → ${put.status}`);
    sent += 1;
    console.error(`  [client pid ${process.pid}] part ${part.part_number} stored (${part.end - part.start + 1} bytes)`);
    if (crashAfter && sent === crashAfter) {
      console.error(`  [client pid ${process.pid}] 💥 SIGKILL after ${sent} part(s)`);
      process.kill(process.pid, 'SIGKILL');
    }
  }
  console.log(`uploaded-this-run=${sent}`);
}

main().catch((err) => {
  console.error('client-multipart failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
