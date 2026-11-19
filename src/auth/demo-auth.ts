// npm run demo:auth — login, access, refresh, and a logout that kills BOTH
// tokens:
//   - the refresh token is a row → its family gets revoked_at;
//   - the access token is self-contained, valid until exp → its jti goes
//     into the denylist. after-logout=401 is the proof the denylist works:
//     without it that token would keep working for up to 10 minutes.
import { openAuthDemo } from './demo-kit';

async function main(): Promise<void> {
  const demo = await openAuthDemo('auth', { buyer: 'buyer' });
  const { buyer } = demo.users;

  const login = await demo.login(buyer);
  const noToken = await demo.call('GET', '/auth/me');
  const withToken = await demo.call('GET', '/auth/me', { token: login.body.access_token });

  const refreshed = await demo.call('POST', '/auth/refresh', { body: { refresh_token: login.body.refresh_token } });
  const access2 = refreshed.body.access_token as string;
  const refresh2 = refreshed.body.refresh_token as string;

  const logout = await demo.call('POST', '/auth/logout', { token: access2 });
  const afterLogout = await demo.call('GET', '/auth/me', { token: access2 });
  const refreshAfterLogout = await demo.call('POST', '/auth/refresh', { body: { refresh_token: refresh2 } });
  // the access token from BEFORE the refresh — same family, also dead
  const firstAccessAfterLogout = await demo.call('GET', '/auth/me', { token: login.body.access_token });

  await demo.finish(
    {
      login: login.status,
      'no-token': noToken.status,
      'with-token': withToken.status,
      refresh: refreshed.status,
      logout: logout.status,
      'after-logout': afterLogout.status,
      'refresh-after-logout': refreshAfterLogout.status,
      'first-access-after-logout': firstAccessAfterLogout.status,
    },
    {
      'login works': login.status === 200,
      'no token → 401': noToken.status === 401,
      'valid token → 200': withToken.status === 200 && withToken.body?.user_id === buyer.id,
      'refresh → new pair': refreshed.status === 200 && access2 !== login.body.access_token && refresh2 !== login.body.refresh_token,
      'logout succeeds': logout.status === 200 || logout.status === 204,
      'access token dead after logout (denylist)': afterLogout.status === 401,
      'refresh token dead after logout (family revoked)': refreshAfterLogout.status === 401,
      'older access token of the family dead too': firstAccessAfterLogout.status === 401,
    },
  );
}

main().catch((err) => {
  console.error('demo:auth failed:', err);
  process.exit(1);
});
