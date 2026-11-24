#!/usr/bin/env node
// npm run scan — image vulnerability gate. The verdict is COMPUTED from the
// scanner's JSON report, never printed:
//
//   found       = distinct (vulnerability id, package) pairs in the report
//                 at SCAN_SEVERITY
//   gate        = found <= SCAN_MAX ? pass : fail      → exit 0 / exit 1
//
//   SCAN_MAX=-1     npm run scan   → gate=fail (nothing is ≤ -1)
//   SCAN_MAX=99999  npm run scan   → gate=pass
//
// A green-or-red "image must be clean" rule isn't the point: even
// gcr.io/distroless/nodejs22-debian12:nonroot has fixable CRITICAL+HIGH
// findings, and the scanner's database changes daily. The CI step
// (.github/workflows/image-scan.yml) runs this same script with the
// project's working threshold.
//
// Trivy runs as a container (no local install): it reads the image from
// the Docker daemon through the socket; its vulnerability DB is cached in
// the `trivy-cache` volume between runs.
import { spawnSync } from 'node:child_process';

const IMAGE = process.env.IMAGE ?? 'marketplace-api:hw28';
const SEVERITY = process.env.SCAN_SEVERITY ?? 'CRITICAL,HIGH';
const MAX = Number(process.env.SCAN_MAX ?? 10); // the working threshold — same as CI
const TRIVY = process.env.TRIVY_IMAGE ?? 'aquasec/trivy:0.76.2';
// only findings with a fix available: an unfixable CVE can't be acted on
// by a rebuild, so it shouldn't block one (it's reported, not gated)
const IGNORE_UNFIXED = process.env.SCAN_IGNORE_UNFIXED !== '0';

if (!Number.isFinite(MAX)) {
  console.error(`SCAN_MAX must be a number, got "${process.env.SCAN_MAX}"`);
  process.exit(2);
}

const args = [
  'run', '--rm',
  '-v', '/var/run/docker.sock:/var/run/docker.sock',
  '-v', 'trivy-cache:/root/.cache/trivy',
  TRIVY, 'image',
  '--quiet', '--format', 'json',
  '--scanners', 'vuln',
  '--severity', SEVERITY,
  ...(IGNORE_UNFIXED ? ['--ignore-unfixed'] : []),
  IMAGE,
];
const run = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (run.status !== 0) {
  console.error(`scanner failed (exit ${run.status}):\n${run.stderr}`);
  process.exit(2); // no report → no verdict; never "pass by default"
}

const report = JSON.parse(run.stdout);
const findings = new Map();
for (const result of report.Results ?? []) {
  for (const v of result.Vulnerabilities ?? []) {
    findings.set(`${v.VulnerabilityID}|${v.PkgName}`, { severity: v.Severity, target: result.Target, fixed: v.FixedVersion });
  }
}
const bySeverity = {};
for (const f of findings.values()) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
const found = findings.size;
const gate = found <= MAX ? 'pass' : 'fail';

console.log(`image=${IMAGE}`);
console.log(`severity=${SEVERITY}`);
console.log(`ignore-unfixed=${IGNORE_UNFIXED ? 1 : 0}`);
console.log(`found=${found}`);
for (const [sev, n] of Object.entries(bySeverity)) console.log(`found-${sev.toLowerCase()}=${n}`);
console.log(`max-allowed=${MAX}`);
console.log(`gate=${gate}`);
process.exit(gate === 'pass' ? 0 : 1);
