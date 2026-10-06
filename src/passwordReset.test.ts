import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { app } from './app.js';
import { hashOpaqueToken, verifyPassword, hashPassword } from './auth.js';
import { env } from './config.js';
import { pool } from './db.js';

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
let database: PGlite;
let resetToken = '';
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function addUser(email: string, status = 'active') {
  const result = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, email_verified, account_status) VALUES ('Reset User', 'Reset', $1, $2, true, $3) RETURNING id",
    [email, await hashPassword('OldPassword1'), status],
  );
  return result.rows[0].id;
}

before(async () => {
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
  const passwordReset = await readFile(new URL('../migrations/009_password_reset.sql', import.meta.url), 'utf8');
  await database.exec('BEGIN');
  await database.exec(sharedAuth);
  await database.exec('COMMIT');
  await database.exec(userPlatform);
  await database.exec(passwordReset);

  originalPoolQuery = realPool.query;
  originalPoolConnect = realPool.connect;
  realPool.query = (text: string, values?: unknown[]) => run(text, values);
  realPool.connect = async () => ({ query: (text: string, values?: unknown[]) => run(text, values), release: () => undefined });

  Object.assign(env, { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'test-email-key', EMAIL_FROM: 'LemonTrip <test@example.com>' });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(String(init?.body)) as { html: string };
      const match = body.html.match(/reset-password\?token=([^&"]+)/);
      resetToken = match ? decodeURIComponent(match[1]) : '';
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
  const hashed = await database.query('SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND token_hash = $2', [id, hashOpaqueToken(resetToken)]);
  assert.equal(hashed.rows.length, 1);
  const raw = await database.query('SELECT 1 FROM password_reset_tokens WHERE token_hash = $1', [resetToken]);
  assert.equal(raw.rows.length, 0);
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
  assert.equal(first.body.sessionsLoggedOut, 1);
  const user = await database.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
  assert.equal(await verifyPassword('BrandNewPass9', user.rows[0].password_hash), true);
  assert.equal(await verifyPassword('OldPassword1', user.rows[0].password_hash), false);
  const sessions = await database.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  assert.equal(sessions.rows.length, 0);

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
