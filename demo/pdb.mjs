#!/usr/bin/env node
// npm run demo:pdb — the PodDisruptionBudget leaves room for exactly one
// voluntary disruption, and stops the second.
//
// Evictions go through the EVICTION API (POST …/pods/<pod>/eviction) — the
// only path a PDB guards. `kubectl delete pod` would skip the budget
// entirely, by design. The status codes are the API server's own, read
// over `kubectl proxy` (kubectl create --raw can't print them):
//   201 Created          — eviction accepted, the budget is spent
//   429 TooManyRequests  — "would violate the disruption budget"
//
// Both evictions are sent back to back: the first one's replacement pod is
// still warming up (~4 s), so the second finds disruptionsAllowed = 0.
// Afterwards the demo waits until the Deployment is back to full strength,
// so the next run (or a node drain) starts from a healthy budget.
import { execFileSync, spawn } from 'node:child_process';

const NS = process.env.K8S_NAMESPACE ?? 'marketplace';
const APP = process.env.K8S_APP ?? 'marketplace-api';
const kubectl = (...args) => execFileSync('kubectl', ['-n', NS, ...args], { encoding: 'utf8' });

function startProxy() {
  const proc = spawn('kubectl', ['proxy', '--port=0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => {
      const m = /Starting to serve on 127\.0\.0\.1:(\d+)/.exec(String(d));
      if (m) resolve({ proc, base: `http://127.0.0.1:${m[1]}` });
    });
    proc.once('exit', (code) => reject(new Error(`kubectl proxy exited (${code})`)));
  });
}

async function main() {
  const pdb = JSON.parse(kubectl('get', 'pdb', APP, '-o', 'json'));
  const before = pdb.status;
  const pods = JSON.parse(kubectl('get', 'pods', '-l', `app=${APP}`, '-o', 'json')).items.filter(
    (p) => !p.metadata.deletionTimestamp && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
  );
  if (pods.length < 2) throw new Error(`need at least 2 ready pods, found ${pods.length}`);
  console.error(`PDB ${APP}: minAvailable=${pdb.spec.minAvailable} currentHealthy=${before.currentHealthy} disruptionsAllowed=${before.disruptionsAllowed}`);

  const proxy = await startProxy();
  const evict = async (pod) => {
    const res = await fetch(`${proxy.base}/api/v1/namespaces/${NS}/pods/${pod}/eviction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: pod, namespace: NS } }),
    });
    const body = await res.json().catch(() => ({}));
    console.error(`evict ${pod} → ${res.status} ${body.reason ?? ''} ${body.message ? `(${body.message})` : ''}`.trim());
    return res.status;
  };

  let evict1;
  let evict2;
  try {
    evict1 = await evict(pods[0].metadata.name);
    evict2 = await evict(pods[1].metadata.name);
  } finally {
    proxy.proc.kill();
  }

  // back to full strength before exiting (the replacement must warm up)
  execFileSync('kubectl', ['-n', NS, 'rollout', 'status', `deploy/${APP}`, '--timeout=120s'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    const s = JSON.parse(kubectl('get', 'pdb', APP, '-o', 'json')).status;
    if (s.currentHealthy >= before.currentHealthy) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = JSON.parse(kubectl('get', 'pdb', APP, '-o', 'json')).status;

  const summary = {
    healthy: before.currentHealthy,
    minAvailable: pdb.spec.minAvailable,
    'disruptions-allowed-before': before.disruptionsAllowed,
    'evict-1': evict1,
    'evict-2': evict2,
    'healthy-after-recovery': after.currentHealthy,
  };
  for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);
  const ok = before.disruptionsAllowed >= 1 && evict1 === 201 && evict2 === 429;
  console.error(ok ? '✓ one eviction allowed, the second refused by the budget' : '✗ invariant violated');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('demo:pdb failed:', err.message ?? err);
  process.exit(1);
});
