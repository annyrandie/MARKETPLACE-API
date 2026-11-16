// npm run demo:reuse — rotation WITH reuse detection (RFC 9700 §4.14.2).
//
//   login            → r1
//   refresh(r1)      → 200, r2           (r1 is now "used")
//   refresh(r1)      → 401               ← someone replayed a used token:
//                                          compromise. Revoke the FAMILY.
//   refresh(r2)      → 401               ← the honest client's token died too
//
// r2-after-reuse=401 is the whole point: rotation alone already gives
// r1-reuse=401, but a thief who refreshes FIRST would then keep a working
// r2 while the victim silently logs in again. Killing the family means
// both sides lose the session — and the app logs it.
import { openAuthDemo } from './demo-kit';

async function main(): Promise<void> {
  const demo = await openAuthDemo('reuse', { buyer: 'buyer' });
  const { buyer } = demo.users;

  const login = await demo.login(buyer);
  const r1 = login.body.refresh_token;

  const r1Refresh = await demo.call('POST', '/auth/refresh', { body: { refresh_token: r1 } });
  const r2 = r1Refresh.body.refresh_token as string;
  const a2 = r1Refresh.body.access_token as string;
  const a2Before = await demo.call('GET', '/auth/me', { token: a2 });

  const r1Reuse = await demo.call('POST', '/auth/refresh', { body: { refresh_token: r1 } });
  const r2AfterReuse = await demo.call('POST', '/auth/refresh', { body: { refresh_token: r2 } });
  // the family is dead for access tokens as well, not only refresh tokens
  const a2AfterReuse = await demo.call('GET', '/auth/me', { token: a2 });

  await new Promise((r) => setTimeout(r, 200)); // let the app's stdout flush
  const logged = /refresh_token_reuse_detected/.test(demo.appOutput());
  const leakedToken = demo.appOutput().includes(r1) || demo.appOutput().includes(r2);
  const logLine = demo.appOutput().split('\n').find((l) => l.includes('refresh_token_reuse_detected'));
  if (logLine) console.error(`app log: ${logLine.trim()}`);

  await demo.finish(
    {
      login: login.status,
      'r1-refresh': r1Refresh.status,
      'a2-before-reuse': a2Before.status,
      'r1-reuse': r1Reuse.status,
      'r2-after-reuse': r2AfterReuse.status,
      'a2-after-reuse': a2AfterReuse.status,
      'reuse-logged': logged ? 1 : 0,
      'token-in-log': leakedToken ? 1 : 0,
    },
    {
      'login works': login.status === 200,
      'first refresh rotates': r1Refresh.status === 200 && r2 !== r1,
      'replayed r1 rejected': r1Reuse.status === 401,
      'whole family revoked: r2 dead too': r2AfterReuse.status === 401,
      'family revoked for access tokens too': a2Before.status === 200 && a2AfterReuse.status === 401,
      'reuse logged, without the token': logged && !leakedToken,
    },
  );
}

main().catch((err) => {
  console.error('demo:reuse failed:', err);
  process.exit(1);
});
