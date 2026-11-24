#!/usr/bin/env node
// Load generator for demo:rollout. Writes ONE LINE PER REQUEST to a file:
// the HTTP status, or 000 when there was no response at all (connection
// refused / reset / timeout — what a failure looks like on a bare NodePort,
// with no ingress in between to turn it into a 502/503).
//
//   node scripts/load.mjs <url> <out-file> [concurrency]
//
// Runs until SIGTERM/SIGINT, then flushes and exits. Keep-alive on, like a
// real client: that's what makes the server's `Connection: close` while
// draining matter.
import http from 'node:http';
import { createWriteStream } from 'node:fs';

const [url, outFile, concurrencyArg] = process.argv.slice(2);
const concurrency = Number(concurrencyArg ?? 16);
const out = createWriteStream(outFile, { flags: 'w' });
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
let running = true;

function once() {
  return new Promise((resolve) => {
    const req = http.get(url, { agent, timeout: 5000 }, (res) => {
      res.resume();
      res.once('end', () => resolve(String(res.statusCode)));
      res.once('error', () => resolve('000'));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', () => resolve('000'));
  });
}

async function worker() {
  while (running) out.write(`${await once()}\n`);
}

const workers = Array.from({ length: concurrency }, worker);
const stop = async () => {
  running = false;
  await Promise.all(workers);
  agent.destroy();
  out.end(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
