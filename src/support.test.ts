import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import express, { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createSupportRouter } from './routes/support.js';
import { env } from './config.js';

const owner = '00000000-0000-4000-8000-000000000001'; const other = '00000000-0000-4000-8000-000000000002';
let db: PGlite; let server: ReturnType<ReturnType<typeof express>['listen']>; let root = ''; let id = '';
const token = (user: string) => jwt.sign({ sub: user }, env.JWT_SECRET);
const form = { firstName: 'Test', lastName: 'Traveller', email: 'test@example.com', topic: 'General Booking', subject: 'Booking assistance', message: 'Please help me with this test booking.', submissionKey: randomUUID() };
before(async () => {
  db = new PGlite(); await db.exec('CREATE TABLE users (id uuid PRIMARY KEY)');
  await db.query('INSERT INTO users VALUES ($1),($2)', [owner, other]);
  await db.exec(await readFile(new URL('../migrations/012_support_requests.sql', import.meta.url), 'utf8'));
  const app = express(); app.use(express.json()); app.use('/api/support', createSupportRouter((sql, values) => db.query(sql, values)));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port'); root = `http://127.0.0.1:${address.port}/api/support`;
});
after(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (db) await db.close(); });
const post = (body: unknown, user = owner) => fetch(`${root}/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` }, body: JSON.stringify(body) });

test('support validates fields before writing and requires authentication', async () => {
  assert.equal((await fetch(`${root}/requests`)).status, 401);
  assert.equal((await post({ ...form, email: 'invalid' })).status, 400);
  assert.equal((await post({ ...form, message: 'short' })).status, 400);
  assert.equal((await post({ ...form, status: 'closed' })).status, 400);
  assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM support_requests')).rows[0].count, 0);
});
test('submitted request appears with one real update and duplicate retry returns the same reference', async () => {
  const response = await post(form); assert.equal(response.status, 201); const payload = await response.json() as { request: { id: string; status: string; updateCount: number } }; id = payload.request.id;
  assert.equal(payload.request.status, 'new'); assert.equal(payload.request.updateCount, 1);
  const retry = await post(form); assert.equal((await retry.json() as typeof payload).request.id, id);
  assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM support_requests')).rows[0].count, 1);
  assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM support_request_updates')).rows[0].count, 1);
  const list = await fetch(`${root}/requests`, { headers: { Authorization: `Bearer ${token(owner)}` } }).then(r => r.json()) as { items: { id: string }[] }; assert.equal(list.items[0].id, id);
});
test('request details and updates are scoped to the authenticated owner', async () => {
  const foreignList = await fetch(`${root}/requests`, { headers: { Authorization: `Bearer ${token(other)}` } }).then(r => r.json()) as { items: unknown[] }; assert.equal(foreignList.items.length, 0);
  assert.equal((await fetch(`${root}/requests/${id}`, { headers: { Authorization: `Bearer ${token(other)}` } })).status, 404);
  const details = await fetch(`${root}/requests/${id}`, { headers: { Authorization: `Bearer ${token(owner)}` } }).then(r => r.json()) as { updates: { message: string }[] }; assert.equal(details.updates.length, 1); assert.equal(details.updates[0].message, 'Your support request has been received.');
});
test('tracking reflects actual status and update count after a team update', async () => {
  await db.query("UPDATE support_requests SET status = 'in_progress' WHERE id = $1", [id]); await db.query("INSERT INTO support_request_updates (id, request_id, event_key, message) VALUES ($1,$2,'review','Your booking is being reviewed.')", [randomUUID(), id]);
  const list = await fetch(`${root}/requests`, { headers: { Authorization: `Bearer ${token(owner)}` } }).then(r => r.json()) as { items: { status: string; updateCount: number }[] }; assert.equal(list.items[0].status, 'in_progress'); assert.equal(list.items[0].updateCount, 2);
});
