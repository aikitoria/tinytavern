import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Settings } from '@minitavern/shared';
import { BASE, assert, req, websocketHandshake } from './helpers.ts';
import type { SetupFixture } from './setup.ts';
import type { ImagesFixture } from './images.ts';
import type { CharactersFixture } from './characters.ts';

export async function testAuth(
  fixture: Pick<SetupFixture, 'dataDir'> &
    Pick<ImagesFixture, 'imageUrl'> &
    Pick<CharactersFixture, 'pngChar'>,
) {
  const { dataDir, imageUrl, pngChar } = fixture;

  console.log('== optional password authentication ==');
  const authBase = await req<Settings>('GET', '/api/settings');
  const enableAuth = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: authBase.revision,
      accessPassword: 'correct horse battery staple',
    }),
  });
  assert(enableAuth.status === 200, 'an access password can be enabled in settings');
  const enablingCookie = enableAuth.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const enabledSettings = (await enableAuth.json()) as Settings;
  assert(
    enabledSettings.hasPassword &&
      !JSON.stringify(enabledSettings).includes('correct horse battery staple') &&
      enablingCookie.startsWith('minitavern_session='),
    'enabling a password returns only password status and an HTTP-only session',
  );

  const passwordRow = new DatabaseSync(join(dataDir, 'minitavern.db'));
  try {
    const stored = passwordRow
      .prepare("SELECT value FROM settings WHERE key = 'access_password_hash'")
      .get() as { value: string } | undefined;
    assert(
      stored?.value.startsWith('scrypt-v1$') &&
        !stored.value.includes('correct horse battery staple'),
      'the access password is stored as a salted scrypt hash',
    );
  } finally {
    passwordRow.close();
  }

  const unauthenticatedApi = await fetch(`${BASE}/api/conversations`);
  assert(unauthenticatedApi.status === 401, 'conversation API access requires a login session');
  const unauthenticatedImage = await fetch(`${BASE}${imageUrl}`);
  assert(unauthenticatedImage.status === 401, 'image downloads require a login session');
  const unauthenticatedAvatar = await fetch(`${BASE}${pngChar.avatar}`);
  assert(unauthenticatedAvatar.status === 401, 'avatar downloads require a login session');
  assert((await websocketHandshake(BASE)) === 401, 'WebSocket upgrades require a login session');

  const wrongLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong password' }),
  });
  assert(wrongLogin.status === 401, 'an incorrect access password is rejected');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assert(
    login.status === 200 && cookie.startsWith('minitavern_session='),
    'the correct access password creates a session',
  );
  const authModule = new URL('../../server/src/auth.ts', import.meta.url).href;
  const freshProcessAuth = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { isRequestAuthenticated } = await import(process.env.AUTH_MODULE);
       process.stdout.write(isRequestAuthenticated({ headers: { cookie: process.env.AUTH_COOKIE }, socket: {} }) ? 'yes' : 'no');`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTH_MODULE: authModule, AUTH_COOKIE: cookie },
      encoding: 'utf8',
    },
  );
  assert(
    freshProcessAuth === 'yes',
    'a login cookie remains valid in a fresh server process using the same database',
  );
  const sessionToken = cookie.slice(cookie.indexOf('=') + 1);
  const sessionDb = new DatabaseSync(join(dataDir, 'minitavern.db'), { readOnly: true });
  try {
    const persisted = sessionDb
      .prepare('SELECT token_hash, expires_at FROM auth_sessions')
      .all() as { token_hash: string; expires_at: number }[];
    assert(
      persisted.length >= 1 &&
        persisted.every(
          (session) =>
            session.token_hash !== sessionToken &&
            !session.token_hash.includes(sessionToken) &&
            session.expires_at > Date.now(),
        ),
      'persistent sessions store only unexpired token hashes',
    );
  } finally {
    sessionDb.close();
  }
  const authenticatedApi = await fetch(`${BASE}/api/conversations`, {
    headers: { cookie },
  });
  assert(
    authenticatedApi.status === 200 &&
      authenticatedApi.headers.get('cache-control')?.includes('no-store') === true,
    'the login session authorizes API access without cacheable private data',
  );
  const authenticatedImage = await fetch(`${BASE}${pngChar.avatar}`, { headers: { cookie } });
  assert(
    authenticatedImage.status === 200 &&
      authenticatedImage.headers.get('cache-control')?.includes('no-store') === true,
    'authenticated media is never cached across session changes',
  );
  assert(
    (await websocketHandshake(BASE, cookie)) === 'open',
    'the login session authorizes WebSocket access',
  );

  const currentProtected = await fetch(`${BASE}/api/settings`, { headers: { cookie } });
  const currentProtectedSettings = (await currentProtected.json()) as Settings;
  const disableAuth = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      expectedRevision: currentProtectedSettings.revision,
      accessPassword: null,
    }),
  });
  assert(disableAuth.status === 200, 'the access password can be removed in settings');
  const sessionsAfterDisable = new DatabaseSync(join(dataDir, 'minitavern.db'), {
    readOnly: true,
  });
  try {
    const count = sessionsAfterDisable.prepare('SELECT count(*) AS n FROM auth_sessions').get() as {
      n: number;
    };
    assert(count.n === 0, 'removing the access password revokes persisted sessions');
  } finally {
    sessionsAfterDisable.close();
  }
  const passwordFreeAgain = await fetch(`${BASE}/api/conversations`);
  assert(passwordFreeAgain.status === 200, 'removing the password restores password-free access');
}
