import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const initial = (await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
const notifications = await readFile(new URL('../migrations/009_notifications_profile.sql', import.meta.url), 'utf8');

test('notifications migration fills booking amount from the first number in price', async () => {
  const db = new PGlite();
  await db.exec(initial);
  const user = await db.query<{ id: string }>("INSERT INTO users (name, email, password_hash) VALUES ('Price User', 'price@example.com', 'hash') RETURNING id");
  for (const price of ['Rs. 24,999', '24999.50', 'INR 1,20,000', 'Free']) {
    await db.query("INSERT INTO bookings (user_id, service_name, item_name, price) VALUES ($1, 'Test', 'Item', $2)", [user.rows[0].id, price]);
  }
  await db.exec(notifications);
  const result = await db.query<{ price: string; amount: string | null }>('SELECT price, amount::text AS amount FROM bookings');
  const byPrice = Object.fromEntries(result.rows.map((row) => [row.price, row.amount]));
  assert.equal(byPrice['Rs. 24,999'], '24999.00');
  assert.equal(byPrice['24999.50'], '24999.50');
  assert.equal(byPrice['INR 1,20,000'], '120000.00');
  assert.equal(byPrice['Free'], null);
  await db.close();
});

test('notifications migration keeps updated_at current and uses the unique function name', async () => {
  const db = new PGlite();
  await db.exec(initial);
  const user = await db.query<{ id: string }>("INSERT INTO users (name, email, password_hash) VALUES ('Time User', 'time@example.com', 'hash') RETURNING id");
  await db.query("INSERT INTO bookings (user_id, service_name, item_name, price) VALUES ($1, 'Test', 'Item', '100')", [user.rows[0].id]);
  await db.exec(notifications);
  const before = await db.query<{ updated_at: Date | string }>('SELECT updated_at FROM bookings');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await db.exec("UPDATE bookings SET status = 'cancelled'");
  const after = await db.query<{ updated_at: Date | string }>('SELECT updated_at FROM bookings');
  assert.ok(new Date(after.rows[0].updated_at).getTime() > new Date(before.rows[0].updated_at).getTime());
  const functions = await db.query<{ name: string }>("SELECT proname AS name FROM pg_proc WHERE proname IN ('set_updated_at', 'lemontrip_set_updated_at') ORDER BY 1");
  assert.deepEqual(functions.rows.map((row) => row.name), ['lemontrip_set_updated_at']);
  await db.close();
});
