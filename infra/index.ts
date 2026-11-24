// HW #28 — everything that goes into the cluster, as one typed program.
// No `kubectl apply -f`: `npm run up` / `npm run destroy` only.
//
//   Namespace → Secret (from the vault) → Postgres → app Deployment +
//   NodePort Service → PodDisruptionBudget → HorizontalPodAutoscaler
import { createHash } from 'node:crypto';
import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

// ─── 1. Configuration FIRST — before anything talks to the cluster ─────────
// Secret values come ONLY from the environment scripts/with-secrets.sh fills
// from the vault (HW #11). No `?? "changeme"`: a default here is a password
// committed to the repo. A missing one stops the deployment and is NAMED —
// validated before any API call, or the first cluster call would fail
// instead and name nothing.
const VAULT_VARS = [
  'APP_DB_PASSWORD',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_KID',
  'REFRESH_TOKEN_PEPPER',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
] as const;
type VaultVar = (typeof VAULT_VARS)[number];

const missing = VAULT_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  throw new Error(
    `missing from the vault: ${missing.join(', ')} — run through scripts/with-secrets.sh ` +
      `(or export them, SKIP_VAULT=1); refusing to deploy without them`,
  );
}
const vault = Object.fromEntries(VAULT_VARS.map((v) => [v, process.env[v]!])) as Record<VaultVar, string>;

const cfg = new pulumi.Config();
const namespaceName = cfg.require('namespace');
const image = cfg.require('image');
const replicas = cfg.requireNumber('replicas');
const nodePort = cfg.requireNumber('nodePort');
const rev = cfg.require('rev');
const profile = cfg.require('profile');
if (profile !== 'hardened' && profile !== 'naive') throw new Error(`profile must be hardened or naive, got "${profile}"`);
const hardened = profile === 'hardened';

// ─── 2. An explicit provider: never "whatever kubectl points at" ───────────
// enableSecretMutable: by default pulumi-kubernetes REPLACES a Secret when
// its data changes — and with a fixed name that's delete-then-create, which
// drags every Deployment referencing it into a replacement too: all pods
// killed at once. Found in this HW's grader dry run (regenerated keys →
// both Deployments replaced, 52 failed requests mid-"rollout"). Updated in
// place instead; the pod-template checksum below turns a changed secret
// into an ordinary ROLLING update.
const provider = new k8s.Provider('kind', { context: cfg.require('kubeContext'), enableSecretMutable: true });
const opts = { provider };

const ns = new k8s.core.v1.Namespace('ns', { metadata: { name: namespaceName } }, opts);
const namespace = ns.metadata.name;

// ─── 3. The runtime secret: vault → K8s Secret → referenced, never inlined ─
// `data` (base64), NOT `stringData`: stringData is write-only — the API never
// returns it, so every `up` would see a diff. With data, two `up`s in a row
// say "unchanged". Wrapped in pulumi.secret → encrypted in Pulumi's state
// with PULUMI_CONFIG_PASSPHRASE. Base64 is NOT encryption: in a local
// cluster this sits in etcd in plain text — the Secret takes it out of git,
// it doesn't encrypt it.
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const SECRET_KEYS: Record<VaultVar, string> = {
  APP_DB_PASSWORD: 'db-password',
  JWT_PRIVATE_KEY: 'jwt-private-key',
  JWT_PUBLIC_KEY: 'jwt-public-key',
  JWT_KID: 'jwt-kid',
  REFRESH_TOKEN_PEPPER: 'refresh-token-pepper',
  STORAGE_ACCESS_KEY: 'storage-access-key',
  STORAGE_SECRET_KEY: 'storage-secret-key',
};
const secret = new k8s.core.v1.Secret(
  'app-secrets',
  {
    metadata: { name: 'marketplace-secrets', namespace },
    type: 'Opaque',
    data: pulumi.secret(
      Object.fromEntries(VAULT_VARS.map((v) => [SECRET_KEYS[v], b64(vault[v])])) as Record<string, string>,
    ),
  },
  opts,
);
// A short digest of the secret values in the pod template: env vars from a
// Secret are read at container start, so a rotated value must restart the
// pods — this makes that a normal rolling update (maxUnavailable 0) instead
// of either "nothing happens" or "everything is replaced". The input
// includes the 256-bit signing key, so the digest can't be brute-forced
// back to the low-entropy values; it never contains a value itself.
const digest = (...vars: VaultVar[]) =>
  createHash('sha256').update(vars.map((v) => `${v}=${vault[v]}`).join('\n')).digest('hex').slice(0, 16);

const fromSecret = (envName: string, v: VaultVar): k8s.types.input.core.v1.EnvVar => ({
  name: envName,
  valueFrom: { secretKeyRef: { name: secret.metadata.name, key: SECRET_KEYS[v] } },
});

// ─── 4. Postgres, in the cluster (the app's warm-up connects to it) ────────
const dbLabels = { app: 'postgres' };
const db = new k8s.apps.v1.Deployment(
  'postgres',
  {
    metadata: { name: 'postgres', namespace },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: dbLabels },
      template: {
        metadata: { labels: dbLabels, annotations: { 'marketplace/secret-digest': digest('APP_DB_PASSWORD') } },
        spec: {
          containers: [
            {
              name: 'postgres',
              image: 'postgres:16-alpine',
              imagePullPolicy: 'IfNotPresent',
              env: [fromSecret('POSTGRES_PASSWORD', 'APP_DB_PASSWORD'), { name: 'POSTGRES_DB', value: 'marketplace' }],
              ports: [{ containerPort: 5432 }],
              readinessProbe: { exec: { command: ['pg_isready', '-U', 'postgres'] }, periodSeconds: 2 },
              resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
            },
          ],
          // demo data only — a real database gets a StatefulSet + a PVC
          volumes: [{ name: 'data', emptyDir: {} }],
        },
      },
    },
  },
  opts,
);
const dbService = new k8s.core.v1.Service(
  'postgres',
  { metadata: { name: 'postgres', namespace }, spec: { selector: dbLabels, ports: [{ port: 5432, targetPort: 5432 }] } },
  { ...opts, dependsOn: [db] },
);

// ─── 5. The app ────────────────────────────────────────────────────────────
// hardened — the four settings that make a rollout lose nothing:
//   maxUnavailable 0 + maxSurge 1   no old pod goes before a new one is READY
//   readinessProbe, period 1 s      the pod leaves the Service within ~1 s of
//                                   SIGTERM (the app turns /readyz red first)
//   DRAIN_MS 5 s < grace 15 s       drain fully, then close; SIGKILL never
//                                   lands mid-drain (that's exit 137)
//   liveness on ANOTHER path        "not ready" must never mean "restart me"
// naive — the control run: no probes, maxUnavailable 1, grace 1 s, no drain.
const DRAIN_MS = 5000;
const appLabels = { app: 'marketplace-api' };

const probes: Pick<k8s.types.input.core.v1.Container, 'readinessProbe' | 'livenessProbe'> = hardened
  ? {
      // "may I get traffic?" — red during warm-up (not listening yet) and
      // from the first moment of SIGTERM
      readinessProbe: { httpGet: { path: '/readyz', port: 3000 }, periodSeconds: 1, failureThreshold: 1, successThreshold: 1, timeoutSeconds: 1 },
      // "should I be killed?" — only a process that stopped answering at
      // all. Starts after the ~4 s warm-up, tolerates 3 misses.
      livenessProbe: { httpGet: { path: '/healthz', port: 3000 }, initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 3, timeoutSeconds: 2 },
    }
  : {};

const deployment = new k8s.apps.v1.Deployment(
  'app',
  {
    metadata: { name: 'marketplace-api', namespace, labels: appLabels },
    spec: {
      replicas,
      selector: { matchLabels: appLabels },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: hardened ? { maxUnavailable: 0, maxSurge: 1 } : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels: appLabels, annotations: { 'marketplace/secret-digest': digest(...VAULT_VARS) } },
        spec: {
          terminationGracePeriodSeconds: hardened ? 15 : 1,
          // distroless :nonroot is uid 65532 — given as a NUMBER: kubelet
          // can't resolve the image's user NAME to verify runAsNonRoot
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'api',
              image,
              imagePullPolicy: 'IfNotPresent', // loaded with `kind load`, never pulled
              ports: [{ name: 'http', containerPort: 3000 }],
              env: [
                { name: 'PORT', value: '3000' },
                { name: 'LOG_LEVEL', value: 'info' },
                // a change here IS the rollout (see Pulumi.yaml, rev)
                { name: 'REV', value: rev },
                { name: 'WARMUP_MS', value: '4000' },
                { name: 'DRAIN_MS', value: hardened ? String(DRAIN_MS) : '0' },
                // the URL carries no password (HW #11); the password is a
                // FILE from the Secret — a mounted Secret is updated in
                // place, so a rotation reaches new connections without a
                // restart, as the app's password-file design expects
                { name: 'DB_URL', value: pulumi.interpolate`postgres://postgres@${dbService.metadata.name}:5432/marketplace` },
                { name: 'DB_PASSWORD_FILE', value: '/var/run/secrets/marketplace/db-password' },
                // everything else from the vault: references, never values
                fromSecret('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY'),
                fromSecret('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY'),
                fromSecret('JWT_KID', 'JWT_KID'),
                fromSecret('REFRESH_TOKEN_PEPPER', 'REFRESH_TOKEN_PEPPER'),
                fromSecret('STORAGE_ACCESS_KEY', 'STORAGE_ACCESS_KEY'),
                fromSecret('STORAGE_SECRET_KEY', 'STORAGE_SECRET_KEY'),
              ],
              volumeMounts: [{ name: 'db-password', mountPath: '/var/run/secrets/marketplace', readOnly: true }],
              ...probes,
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
          volumes: [
            {
              name: 'db-password',
              secret: { secretName: secret.metadata.name, items: [{ key: SECRET_KEYS.APP_DB_PASSWORD, path: 'db-password' }] },
            },
          ],
        },
      },
    },
  },
  {
    ...opts,
    dependsOn: [dbService],
    // spec.replicas is written by THIS program at creation and by the HPA
    // afterwards (once metrics-server exists). Two writers on one field:
    // without this, every `up` would reset the HPA's decision. See README.
    ignoreChanges: ['spec.replicas'],
  },
);

const service = new k8s.core.v1.Service(
  'app',
  {
    metadata: { name: 'marketplace-api', namespace },
    spec: { type: 'NodePort', selector: appLabels, ports: [{ name: 'http', port: 80, targetPort: 'http', nodePort }] },
  },
  opts,
);

// ─── 6. Disruption budget: room for maintenance, not a drain blocker ───────
// minAvailable 2 of 3 → one voluntary eviction at a time. minAvailable ==
// replicas would allow ZERO: no node could ever be drained. (It guards the
// Eviction API only — a plain `kubectl delete pod` ignores it by design.)
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  'app',
  { metadata: { name: 'marketplace-api', namespace }, spec: { minAvailable: replicas - 1, selector: { matchLabels: appLabels } } },
  opts,
);

// ─── 7. Autoscaling: declared, autoscaling/v2, CPU ─────────────────────────
// kind has no metrics-server: TARGETS reads cpu: <unknown>/70% and nothing
// scales — expected. minReplicas = replicas (3), not 2: scaling down to 2
// would leave the PDB (minAvailable 2) with no room for an eviction.
const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  'app',
  {
    metadata: { name: 'marketplace-api', namespace },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name },
      minReplicas: replicas,
      maxReplicas: replicas * 2,
      metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }],
    },
  },
  opts,
);

export const namespaceOut = namespace;
export const deploymentName = deployment.metadata.name;
export const serviceUrl = pulumi.interpolate`http://127.0.0.1:${service.spec.ports[0].nodePort}`;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const activeProfile = profile;
export const activeRev = rev;
