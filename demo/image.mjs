#!/usr/bin/env node
// npm run demo:image — is the image production-grade, and did the build
// secret stay out of it? Every number is MEASURED from the built image:
//
//   stages        FROM lines in docker/Dockerfile
//   shell-inside  `docker run --entrypoint sh` (and /bin/sh, /bin/bash,
//                 /busybox/sh) — reading the Dockerfile can't tell: a base
//                 image can bring a shell you never asked for
//   runtime-uid   process.getuid() of node INSIDE the image
//   token-in-history  `docker history --no-trunc` — where an ARG leaks
//   token-in-config   `docker image inspect` — env/labels/metadata
//   token-in-layers   `docker save`, every layer unpacked and searched
//                     byte-wise — where COPY + rm leaks (the rm only adds
//                     a whiteout; the bytes stay in the earlier layer)
//
// The token is the bait in .npm_token (the same file image:build passes
// to BuildKit). control-in-layers=1 proves the layer search works: it
// looks for a string that IS in the image (our package name) and must
// find it — so token-in-layers=0 is a measurement, not a broken grep.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const IMAGE = process.env.IMAGE ?? 'marketplace-api:hw28';
const ROOT = path.resolve(import.meta.dirname, '..');
const token = readFileSync(path.join(ROOT, '.npm_token'), 'utf8').trim();
if (token.length < 8) throw new Error('.npm_token is missing or too short — see README, Grading');
const CONTROL = '"name": "marketplace-api"';

const count = (haystack, needle) => haystack.split(needle).length - 1;

// stages
const dockerfile = readFileSync(path.join(ROOT, 'docker/Dockerfile'), 'utf8');
const stages = dockerfile.split('\n').filter((l) => /^\s*FROM\s/i.test(l)).length;

// shell-inside: try to actually run one
const shells = ['sh', '/bin/sh', '/bin/bash', '/busybox/sh'];
const shellFound = shells.filter(
  (sh) => spawnSync('docker', ['run', '--rm', '--entrypoint', sh, IMAGE, '-c', 'exit 0'], { stdio: 'ignore' }).status === 0,
);

// runtime-uid: ask the process itself
const uid = spawnSync('docker', ['run', '--rm', '--entrypoint', '/nodejs/bin/node', IMAGE, '-e', 'process.stdout.write(String(process.getuid()))'], {
  encoding: 'utf8',
}).stdout.trim();

// token in history / config
const history = execFileSync('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', IMAGE], { encoding: 'utf8' });
const config = execFileSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8' });

// token in layers: docker save → unpack → search every blob's bytes
const tmp = mkdtempSync(path.join(os.tmpdir(), 'demo-image-'));
let tokenInLayers = 0;
let controlInLayers = 0;
let blobs = 0;
try {
  execFileSync('docker', ['save', '-o', path.join(tmp, 'image.tar'), IMAGE]);
  execFileSync('tar', ['-xf', path.join(tmp, 'image.tar'), '-C', tmp]);
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(tmp)) {
    if (file.endsWith('image.tar')) continue;
    let bytes = readFileSync(file);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes); // gzip-compressed layer
    if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
      bytes = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 }); // zstd-compressed layer
    }
    blobs += 1;
    if (bytes.includes(token)) tokenInLayers += 1;
    if (bytes.includes(CONTROL)) controlInLayers += 1;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const summary = {
  stages,
  'shell-inside': shellFound.length > 0 ? 1 : 0,
  'runtime-uid': uid,
  'token-in-history': count(history, token),
  'token-in-config': count(config, token),
  'token-in-layers': tokenInLayers,
  'control-in-layers': controlInLayers > 0 ? 1 : 0,
  'blobs-searched': blobs,
};
console.error(`image ${IMAGE}: shells found: [${shellFound.join(', ')}] · searched ${blobs} blobs from docker save`);
for (const [k, v] of Object.entries(summary)) console.log(`${k}=${v}`);

const ok =
  stages >= 2 &&
  summary['shell-inside'] === 0 &&
  uid !== '' && uid !== '0' &&
  summary['token-in-history'] + summary['token-in-config'] + tokenInLayers === 0 &&
  summary['control-in-layers'] === 1;
console.error(ok ? '✓ invariant holds' : '✗ invariant violated');
process.exit(ok ? 0 : 1);
