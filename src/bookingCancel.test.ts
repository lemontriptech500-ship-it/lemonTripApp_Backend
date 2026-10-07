import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { app } from './app.js';
import { createAccessToken } from './auth.js';
import { pool } from './db.js';

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
let database: PGlite;
const realPool = pool as unknown as { query: (...args: any[]) => unknown };
let originalPoolQuery: (...args: any[]) => unknown;

async function run(text: string, values?: unknown[]) {
  const result = await database.query(text, values);
  return { ...result, rowCount: result.rows.length || (result.affectedRows ?? 0) };
}

async function makeUser(email: string) {
  const user = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, email_verified, account_status) VALUES ('Cancel User', 'Cancel', $1, 'hash', true, 'active') RETURNING id",
    [email],
  );
  const id = user.rows[0].id;
  const session = await database.query<{ id: string }>(
    "INSERT INTO user_sessions (user_id, platform, refresh_token_hash, expires_at) VALUES ($1, 'app', $2, now() + interval '1 day') RETURNING id",
    [id, `hash-${email}`],
  );
  return { id, token: createAccessToken(id, session.rows[0].id, 'app') };
}

async function makeBooking(userId: string, paymentStatus: string) {
  const status = paymentStatus === 'paid' ? 'confirmed' : 'upcoming';
  const result = await database.query<{ id: string }>(
    "INSERT INTO bookings (user_id, service_name, item_name, price, status, payment_status) VALUES ($1, 'flights', 'Delhi to Goa', '5000', $2, $3) RETURNING id",
    [userId, status, paymentStatus],
  );
  return result.rows[0].id;
}

async function cancel(id: string, token?: string) {
  const response = await fetch(`${baseUrl}/api/bookings/${id}/cancel`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: (await response.json()) as any };
}

before(async () => {
  database = new PGlite();
  await database.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL, email text NOT NULL UNIQUE, phone text,
    password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const sharedAuth = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
  const userPlatform = await readFile(new URL('../migrations/005_user_platform.sql', import.meta.url), 'utf8');
  await database.exec('BEGIN');
  await database.exec(sharedAuth);
  await database.exec('COMMIT');
  await database.exec(userPlatform);
  await database.exec(`
    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service_name text NOT NULL, item_name text NOT NULL, price text NOT NULL, trip_date date,
      status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('upcoming', 'completed', 'cancelled', 'confirmed')),
      payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled')),
      provider_reference text, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type text NOT NULL, title text NOT NULL, body text NOT NULL, data jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  originalPoolQuery = realPool.query;
  realPool.query = (text: string, values?: unknown[]) => run(text, values);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  realPool.query = originalPoolQuery;
  await database.close();
});

test('a user cancels their own pending booking and gets a notification', async () => {
  const user = await makeUser('cancel-own@example.com');
  const id = await makeBooking(user.id, 'pending');
  const result = await cancel(id, user.token);
  assert.equal(result.status, 200);
  const row = await database.query<{ status: string; payment_status: string }>('SELECT status, payment_status FROM bookings WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'cancelled');
  assert.equal(row.rows[0].payment_status, 'cancelled');
  const notice = await database.query('SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2', [user.id, 'booking_cancelled']);
  assert.equal(notice.rows.length, 1);
  const again = await cancel(id, user.token);
  assert.equal(again.status, 409);
});

test('a paid booking cannot be cancelled online', async () => {
  const user = await makeUser('cancel-paid@example.com');
  const id = await makeBooking(user.id, 'paid');
  const result = await cancel(id, user.token);
  assert.equal(result.status, 409);
  const row = await database.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'confirmed');
});

test('nobody can cancel another user\'s booking, and login is required', async () => {
  const owner = await makeUser('cancel-owner@example.com');
  const other = await makeUser('cancel-other@example.com');
  const id = await makeBooking(owner.id, 'pending');
  assert.equal((await cancel(id, other.token)).status, 404);
  assert.equal((await cancel(id)).status, 401);
  assert.equal((await cancel('not-a-uuid', other.token)).status, 404);
  const row = await database.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [id]);
  assert.equal(row.rows[0].status, 'upcoming');
});