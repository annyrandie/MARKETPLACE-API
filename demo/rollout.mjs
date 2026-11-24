#!/usr/bin/env node
// npm run demo:rollout — roll out a new revision UNDER LOAD and count, from
// a file, every response that wasn't a 200.
//
//  1. (if asked for another profile) switch the Deployment to it first,
//     without load: ROLLOUT_PROFILE=naive is the control run
//  2. wait for a steady state (no terminating pod + 3 s of 200s), then
//     start the load generator → one status code per line into a temp file
//  3. 2 s of steady load, then `pulumi config set rev <new>` + `pulumi up`:
//     a new pod template → a rolling update of all replicas; pulumi up
//     returns when the Deployment reports the rollout complete
//  4. 2 s more load, stop the generator, COUNT the file
//  5. put the cluster back on the hardened profile if it was switched
//
// requests/ok/failed are counted from the file, rollout-seconds is the
// measured duration of the update — nothing here is printed from a constant.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.ROLLOUT_URL ?? 'http://127.0.0.1:30080/products';
const PROFILE = process.env.ROLLOUT_PROFILE ?? 'hardened';
const CONCURRENCY = Number(process.env.ROLLOUT_CONCURRENCY ?? 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pulumi = (...args) =>
  execFileSync('bash', [path.join(ROOT, 'scripts/pulumi.sh'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
const currentConfig = (key) => pulumi('config', 'get', key).trim();
// Steady state before measuring: no app pod is terminating, AND 3 s of
// uninterrupted 200s through the Service. Without it the settling of a
// profile switch would be measured as if it were the rollout: pulumi up
// returns while old pods still drain, and naive pods (no readiness probe)
// count as available while they're still warming up.
function terminatingPods() {
  const pods = JSON.parse(execFileSync('kubectl', ['-n', 'marketplace', 'get', 'pods', '-l', 'app=marketplace-api', '-o', 'json'], { encoding: 'utf8' }));
  return pods.items.filter((p) => p.metadata.deletionTimestamp).length;
}
async function waitSteady(holdMs = 3000, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let since = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no steady state at ${URL} within ${timeoutMs} ms`);
    const okNow = terminatingPods() === 0 && (await fetch(URL).then((r) => r.status === 200, () => false));
    if (!okNow) since = 0;
    else if (!since) since = Date.now();
    else if (Date.now() - since >= holdMs) return;
    await sleep(100);
  }
}

const setProfile = (profile) => {
  pulumi('config', 'set', 'profile', profile);
  pulumi('up');
};

async function main() {
  const startedProfile = currentConfig('profile');
  if (startedProfile !== PROFILE) {
    console.error(`switching the Deployment to profile=${PROFILE} (no load yet)…`);
    setProfile(PROFILE);
  }

  await waitSteady();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'demo-rollout-'));
  const codesFile = path.join(tmp, 'codes.txt');
  let summary;
  try {
    const loader = spawn(process.execPath, [path.join(ROOT, 'scripts/load.mjs'), URL, codesFile, String(CONCURRENCY)], {
      stdio: 'inherit',
    });
    const loaderDone = new Promise((r) => loader.once('exit', r));
    await sleep(2000);

    const rev = `r${Date.now()}`;
    console.error(`rolling out rev=${rev} (profile=${PROFILE}) under load, ${CONCURRENCY} concurrent clients…`);
    pulumi('config', 'set', 'rev', rev);
    const t0 = Date.now();
    pulumi('up');
    const rolloutSeconds = (Date.now() - t0) / 1000;

    await sleep(2000);
    loader.kill('SIGTERM');
    await loaderDone;

    const codes = readFileSync(codesFile, 'utf8').split('\n').filter(Boolean);
    const byCode = {};
    for (const c of codes) byCode[c] = (byCode[c] ?? 0) + 1;
    const ok = byCode['200'] ?? 0;
    summary = {
      profile: PROFILE,
      requests: codes.length,
      ok,
      failed: codes.length - ok,
      'rollout-seconds': rolloutSeconds.toFixed(1),
    };
    for (const [code, n] of Object.entries(byCode)) if (code !== '200') summary[`code-${code}`] = n;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (PROFILE !== 'hardened') {
      console.error('restoring the hardened profile…');
      setProfile('hardened');
    }
  }

  for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);
  const ok = summary.failed === 0 && summary.requests >= 5000;
  console.error(ok ? '✓ zero failed responses during the rollout' : `✗ ${summary.failed} of ${summary.requests} responses were not 200`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('demo:rollout failed:', err.message ?? err);
  process.exit(1);
});
