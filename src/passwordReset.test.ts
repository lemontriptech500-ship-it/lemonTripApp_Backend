import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { app } from './app.js';
import { hashOpaqueToken, verifyPassword, hashPassword } from './auth.js';
import { env } from './config.js';
import { pool } from './db.js';

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
let database: PGlite;
let resetToken = '';
let resetLink = '';
const originalResetUrl = process.env.PASSWORD_RESET_URL;
const originalAppResetUrl = process.env.APP_PASSWORD_RESET_URL;
let originalFetch: typeof fetch;
const realPool = pool as unknown as { query: (...args: any[]) => unknown; connect: () => unknown };
let originalPoolQuery: (...args: any[]) => unknown;
let originalPoolConnect: () => unknown;

async function run(text: string, values?: unknown[]) {
  const result = await database.query(text, values);
  return { ...result, rowCount: result.rows.length || (result.affectedRows ?? 0) };
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://lemontrip.in' },
    body: JSON.stringify(body),
  });
  return { status: response.status, allowedOrigin: response.headers.get('access-control-allow-origin'), body: (await response.json()) as any };
}

async function addUser(email: string, status = 'active') {
  const result = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, email_verified, account_status) VALUES ('Reset User', 'Reset', $1, $2, true, $3) RETURNING id",
    [email, await hashPassword('OldPassword1'), status],
  );
  return result.rows[0].id;
}

before(async () => {
  delete process.env.PASSWORD_RESET_URL;
  delete process.env.APP_PASSWORD_RESET_URL;
  database = new PGlite();
  await database.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    phone text,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const sharedAuth = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
  const userPlatform = await readFile(new URL('../migrations/005_user_platform.sql', import.meta.url), 'utf8');
  const passwordReset = await readFile(new URL('../migrations/011_password_reset.sql', import.meta.url), 'utf8');
  await database.exec('BEGIN');
  await database.exec(sharedAuth);
  await database.exec('COMMIT');
  await database.exec(userPlatform);
  await database.exec(passwordReset);
  await database.exec(await readFile(new URL('../migrations/012_password_reset_compatibility.sql', import.meta.url), 'utf8'));

  originalPoolQuery = realPool.query;
  originalPoolConnect = realPool.connect;
  realPool.query = (text: string, values?: unknown[]) => run(text, values);
  realPool.connect = async () => ({ query: (text: string, values?: unknown[]) => run(text, values), release: () => undefined });

  Object.assign(env, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'test-email-key', EMAIL_FROM: 'LemonTrip <test@example.com>', PUBLIC_API_URL: 'https://lemontripapp-backend.onrender.com' });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(String(init?.body)) as { html: string };
      const match = body.html.match(/href="([^"]+)"/);
      resetLink = match ? match[1].replace(/&amp;/g, '&') : '';
      resetToken = resetLink ? new URL(resetLink).searchParams.get('token') ?? '' : '';
      assert.ok(body.html.includes(`<code>${resetToken}</code>`));
      return new Response('{}', { status: 200 });
    }
    return originalFetch(input, init);
  };

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (originalResetUrl === undefined) delete process.env.PASSWORD_RESET_URL;
  else process.env.PASSWORD_RESET_URL = originalResetUrl;
  if (originalAppResetUrl === undefined) delete process.env.APP_PASSWORD_RESET_URL;
  else process.env.APP_PASSWORD_RESET_URL = originalAppResetUrl;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  globalThis.fetch = originalFetch;
  realPool.query = originalPoolQuery;
  realPool.connect = originalPoolConnect;
  await database.close();
});

test('forgot-password gives the same answer for unknown emails and sends nothing', async () => {
  resetToken = '';
  const result = await post('/api/auth/forgot-password', { email: 'nobody-here@example.com' });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(resetToken, '');
});

test('forgot-password emails a link and stores only a hash of the token', async () => {
  const id = await addUser('reset-hash@example.com');
  resetToken = '';
  const result = await post('/api/auth/forgot-password', { email: 'reset-hash@example.com' });
  assert.equal(result.status, 200);
  assert.ok(resetToken.length > 20);
  assert.equal(new URL(resetLink).origin, 'https://lemontripapp-backend.onrender.com');
  assert.equal(new URL(resetLink).pathname, '/app/reset-password');
  const hashed = await database.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND token_hash = $2', [id, hashOpaqueToken(resetToken)]);
  assert.equal(hashed.rows.length, 1);
  const raw = await database.query('SELECT 1 FROM password_reset_tokens WHERE token_hash = $1', [resetToken]);
  assert.equal(raw.rows.length, 0);
  for (let visit = 0; visit < 2; visit++) {
    const opener = await fetch(`${baseUrl}/app/reset-password?token=${encodeURIComponent(resetToken)}`);
    assert.equal(opener.status, 200);
    assert.equal(opener.headers.get('cache-control'), 'no-store');
    assert.equal(opener.headers.get('referrer-policy'), 'no-referrer');
    const html = await opener.text();
    assert.ok(html.includes(`lemontripmobile://reset-password?token=${resetToken}`));
    assert.ok(html.includes('/app/reset-password/open.js'));
    assert.ok(html.includes('id="reset-password-form"'));
    assert.ok(html.includes(`name="token" value="${resetToken}"`));
    assert.ok(!html.includes('Opening the LemonTrip app'));
  }
  const unused = await database.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [id]);
  assert.equal(unused.rows.length, 1);
});

test('browser reset page rejects missing, malformed and duplicate tokens', async () => {
  for (const query of ['', '?token=short', '?token=%3Cscript%3E' + 'x'.repeat(25), '?token=' + 'x'.repeat(40) + '&token=' + 'y'.repeat(40)]) {
    const response = await fetch(`${baseUrl}/app/reset-password${query}`);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.ok(html.includes('This link is incomplete'));
    assert.ok(!html.includes('id="reset-password-form"'));
  }
  const script = await fetch(`${baseUrl}/app/reset-password/open.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.ok(!(await script.text()).includes('window.location'));
});

test('browser reset assets are served by the same backend with the existing content security policy', async () => {
  for (const [file, type] of [['styles.css', 'text/css'], ['logo.png', 'image/png'], ['Manrope.ttf', 'font/ttf']]) {
    const response = await fetch(`${baseUrl}/app/reset-password/assets/${file}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes(type));
    assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test('browser form validates confirmation and resets a password without an installed app', async () => {
  const id = await addUser('reset-browser@example.com');
  const token = 'browser-reset-token-' + 'x'.repeat(24);
  await database.query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [id, hashOpaqueToken(token)]);
  const script = await (await fetch(`${baseUrl}/app/reset-password/open.js`)).text();
  const values: Record<string, { value: string }> = {
    token: { value: token }, newPassword: { value: 'BrowserPassword9' }, confirmPassword: { value: 'MismatchPassword9' },
  };
  const button = { disabled: false };
  const status = { textContent: '', dataset: { state: '' } };
  let submit: (event: { preventDefault(): void }) => Promise<void> = async () => { throw new Error('Missing submit handler'); };
  let requests = 0;
  const form = {
    hidden: false,
    elements: { namedItem: (name: string) => values[name] },
    querySelector: () => button,
    addEventListener: (_name: string, handler: typeof submit) => { submit = handler; },
    reset: () => { for (const field of Object.values(values)) field.value = ''; },
  };
  runInNewContext(script, {
    document: { getElementById: (id: string) => id === 'reset-password-form' ? form : status },
    AbortSignal,
    fetch: async (path: string, init: RequestInit) => { requests++; return fetch(`${baseUrl}${path}`, init); },
  });
  const event = { preventDefault() {} };
  await submit(event);
  assert.equal(requests, 0);
  assert.match(status.textContent, /Passwords must match/);
  values.confirmPassword.value = values.newPassword.value;
  await submit(event);
  assert.equal(requests, 1);
  assert.equal(form.hidden, true);
  assert.match(status.textContent, /password has been updated/);
  const user = await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
  assert.equal(await verifyPassword('BrowserPassword9', user.rows[0].password_hash), true);
  await submit(event);
  assert.equal(requests, 1);
});

test('reset-password changes the password, signs out all sessions and works only once', async () => {
  const id = await addUser('reset-once@example.com');
  await database.query(
    "INSERT INTO user_sessions (user_id, platform, refresh_token_hash, expires_at) VALUES ($1, 'app', 'session-hash-1', now() + interval '1 day')",
    [id],
  );
  resetToken = '';
  await post('/api/auth/forgot-password', { email: 'reset-once@example.com' });
  const token = resetToken;
  assert.ok(token);

  const first = await post('/api/auth/reset-password', { token, newPassword: 'BrandNewPass9' });
  assert.equal(first.status, 200);
  assert.equal(first.allowedOrigin, 'https://lemontrip.in');
  assert.equal(first.body.sessionsLoggedOut, 1);
  const user = await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
  assert.equal(await verifyPassword('BrandNewPass9', user.rows[0].password_hash), true);
  assert.equal(await verifyPassword('OldPassword1', user.rows[0].password_hash), false);
  const sessions = await database.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  assert.equal(sessions.rows.length, 0);

  const oldLogin = await post('/api/auth/login', { email: 'reset-once@example.com', password: 'OldPassword1' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await post('/api/auth/login', { email: 'reset-once@example.com', password: 'BrandNewPass9' });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.body.accessToken);

  const second = await post('/api/auth/reset-password', { token, newPassword: 'AnotherPass10' });
  assert.equal(second.status, 400);
});

test('invalid and expired reset tokens are rejected', async () => {
  const wrong = await post('/api/auth/reset-password', { token: 'x'.repeat(40), newPassword: 'BrandNewPass9' });
  assert.equal(wrong.status, 400);

  const id = await addUser('reset-expired@example.com');
  resetToken = '';
  await post('/api/auth/forgot-password', { email: 'reset-expired@example.com' });
  await database.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [id]);
  const expired = await post('/api/auth/reset-password', { token: resetToken, newPassword: 'BrandNewPass9' });
  assert.equal(expired.status, 400);
  const user = await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
  assert.equal(await verifyPassword('OldPassword1', user.rows[0].password_hash), true);
});

test('pending and disabled accounts get no reset link', async () => {
  await addUser('reset-pending@example.com', 'pending');
  await addUser('reset-disabled@example.com', 'disabled');
  resetToken = '';
  await post('/api/auth/forgot-password', { email: 'reset-pending@example.com' });
  assert.equal(resetToken, '');
  await post('/api/auth/forgot-password', { email: 'reset-disabled@example.com' });
  assert.equal(resetToken, '');
});

test('legacy website reset URL is migrated to the app backend opener', async () => {
  process.env.PASSWORD_RESET_URL = 'https://lemontrip.in/reset-password?source=email';
  try {
    await addUser('reset-legacy@example.com');
    const result = await post('/api/auth/forgot-password', { email: 'reset-legacy@example.com' });
    assert.equal(result.status, 200);
    const link = new URL(resetLink);
    assert.equal(link.pathname, '/app/reset-password');
    assert.equal(link.origin, 'https://lemontripapp-backend.onrender.com');
    assert.equal(link.searchParams.get('source'), 'email');
    assert.ok(link.searchParams.get('token'));
  } finally {
    delete process.env.PASSWORD_RESET_URL;
  }
});

test('app reset URL takes precedence and replaces a stale token', async () => {
  process.env.PASSWORD_RESET_URL = 'https://lemontrip.in/reset-password';
  process.env.APP_PASSWORD_RESET_URL = 'https://lemontrip.in/app/reset-password?token=stale&source=app';
  try {
    await addUser('reset-configured@example.com');
    await post('/api/auth/forgot-password', { email: 'reset-configured@example.com' });
    const link = new URL(resetLink);
    assert.equal(link.pathname, '/app/reset-password');
    assert.equal(link.origin, 'https://lemontripapp-backend.onrender.com');
    assert.equal(link.searchParams.get('source'), 'app');
    assert.equal(link.searchParams.getAll('token').length, 1);
    assert.notEqual(resetToken, 'stale');
  } finally {
    delete process.env.PASSWORD_RESET_URL;
    delete process.env.APP_PASSWORD_RESET_URL;
  }
});

test('browser reset preflight allows the production app reset page', async () => {
  const response = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://lemontrip.in', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://lemontrip.in');
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /content-type/i);
});

test('requesting a new reset link invalidates the previous link', async () => {
  await post('/api/auth/forgot-password', { email: 'reset-hash@example.com' });
  const oldToken = resetToken;
  await post('/api/auth/forgot-password', { email: 'reset-hash@example.com' });
  assert.notEqual(resetToken, oldToken);
  const old = await post('/api/auth/reset-password', { token: oldToken, newPassword: 'BrandNewPass9' });
  assert.equal(old.status, 400);
  const current = await post('/api/auth/reset-password', { token: resetToken, newPassword: 'BrandNewPass9' });
  assert.equal(current.status, 200);
});

test('password reset rejects passwords outside 8–128 characters', async () => {
  for (const newPassword of ['short', 'x'.repeat(129)]) {
    const result = await post('/api/auth/reset-password', { token: 'x'.repeat(40), newPassword });
    assert.equal(result.status, 400);
  }
});

test('login is limited per email after 10 attempts', async () => {
  const body = { email: 'ratelimit-test@example.com', password: 'WrongPassword1' };
  for (let i = 0; i < 10; i++) {
    const attempt = await post('/api/auth/login', body);
    assert.equal(attempt.status, 401);
  }
  const blocked = await post('/api/auth/login', body);
  assert.equal(blocked.status, 429);
  const other = await post('/api/auth/login', { email: 'ratelimit-other@example.com', password: 'WrongPassword1' });
  assert.equal(other.status, 401);
});
