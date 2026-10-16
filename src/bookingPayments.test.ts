import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import express, { type Request, type Response, type NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createBookingPaymentsRouter } from './routes/bookingPayments.js';
import { env } from './config.js';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const secret = 'test-fixture-secret';
const oldKeys = [process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET];
let db: PGlite; let server: ReturnType<ReturnType<typeof express>['listen']>; let root = ''; let sequence = 0;
const notices: string[] = [];
const providerCalls: string[] = [];
const providerOrders = new Map<string, { amount: number; currency: string }>();
const payments = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }>();
let rejectOrder = false;
const providerFetch: typeof fetch = async (input, init) => {
  const url = String(input); providerCalls.push(url);
  if (url.endsWith('/orders')) {
    if (rejectOrder) return Response.json({ error: 'unavailable' }, { status: 503 });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.currency, 'INR'); assert.equal(body.notes.testMode, 'true');
    const id = `order_fixture${++sequence}`;
    providerOrders.set(id, body);
    return Response.json({ id, amount: body.amount, currency: body.currency });
  }
  const id = /\/payments\/(pay_[^/]+)/.exec(url)?.[1] ?? '';
  const payment = payments.get(id);
  if (!payment) return Response.json({}, { status: 404 });
  if (url.endsWith('/capture')) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.amount, payment.amount);
    assert.equal(body.currency, payment.currency);
    payment.status = 'captured';
  }
  return Response.json(payment);
};
const token = (user: string) => jwt.sign({ sub: user }, env.JWT_SECRET);
const post = (path: string, body: unknown, user = owner) => fetch(root + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user)}` }, body: JSON.stringify(body) });
const details = { amount: 1234.56, currency: 'INR', itemName: 'Test journey', tripDate: '2026-12-01' };
const create = async (service = 'flights') => { const response = await post(`/${service}/order`, details); assert.equal(response.status, 201); return await response.json() as { orderId: string; bookingId: string; amount: number; keyId: string; testMode: boolean }; };
const receipt = (orderId: string, overrides: Partial<{ order_id: string; amount: number; currency: string; status: string }> = {}) => {
  const id = `pay_fixture${payments.size + 1}`;
  const order = providerOrders.get(orderId)!;
  payments.set(id, { id, order_id: orderId, amount: order.amount, currency: order.currency, status: 'captured', ...overrides });
  return { razorpayOrderId: orderId, razorpayPaymentId: id, razorpaySignature: createHmac('sha256', secret).update(`${orderId}|${id}`).digest('hex') };
};
before(async () => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture'; process.env.RAZORPAY_KEY_SECRET = secret;
  db = new PGlite();
  await db.exec(`CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, service_name text, item_name text, price text,
    amount numeric, currency text, trip_date date, payment_status text, provider_reference text, status text)`);
  const app = express(); app.use(express.json());
  app.use('/payments', createBookingPaymentsRouter({ database: (sql, values) => db.query(sql, values), providerFetch, notify: async (_user, booking) => { notices.push(booking.id); } }));
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port'); root = `http://127.0.0.1:${address.port}/payments`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (db) await db.close();
  for (const [i, key] of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'].entries()) { if (oldKeys[i] === undefined) delete process.env[key]; else process.env[key] = oldKeys[i]; }
});

test('orders require login, valid INR details and test credentials', async () => {
  assert.equal((await fetch(root + '/flights/order', { method: 'POST' })).status, 401);
  for (const invalid of [{ amount: 0 }, { amount: -1 }, { amount: 1_000_001 }, { currency: 'USD' }, { tripDate: 'not-a-date' }, { paymentStatus: 'paid' }]) {
    assert.equal((await post('/flights/order', { ...details, ...invalid })).status, 400);
  }
  assert.equal((await post('/unknown/order', details)).status, 404);
  process.env.RAZORPAY_KEY_ID = 'rzp_live_forbidden';
  assert.equal((await post('/hotels/order', details)).status, 503);
  process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
  assert.equal(providerCalls.length, 0);
});

test('all app booking services and cart create pending orders and confirm only captured, signed payments; retries are idempotent', async () => {
  for (const service of ['flights', 'buses', 'hotels', 'packages', 'cart']) {
    const order = await create(service);
    assert.equal(order.amount, 123456); assert.equal(order.testMode, true); assert.equal(order.keyId, 'rzp_test_fixture');
    const pending = (await db.query<{ payment_status: string }>('SELECT payment_status FROM bookings WHERE id=$1', [order.bookingId])).rows[0];
    assert.equal(pending.payment_status, 'pending');
    const signed = receipt(order.orderId);
    assert.equal((await post(`/${service}/verify`, signed)).status, 200);
    assert.equal((await post(`/${service}/verify`, signed)).status, 200);
    const saved = (await db.query<{ payment_status: string; status: string }>('SELECT payment_status,status FROM bookings WHERE id=$1', [order.bookingId])).rows[0];
    assert.equal(saved.payment_status, 'paid'); assert.equal(saved.status, 'confirmed');
    assert.equal(notices.filter(id => id === order.bookingId).length, 1);
  }
});

test('cart orders may omit a single trip date', async () => {
  const response = await post('/cart/order', { amount: 250, currency: 'INR', itemName: 'Mixed travel cart' });
  assert.equal(response.status, 201);
  const order = await response.json() as { bookingId: string };
  const saved = (await db.query<{ service_name: string; trip_date: string | null }>('SELECT service_name,trip_date FROM bookings WHERE id=$1', [order.bookingId])).rows[0];
  assert.equal(saved.service_name, 'Travel Cart');
  assert.equal(saved.trip_date, null);
});

test('verification rejects tampered signatures, another owner and another service', async () => {
  const order = await create('buses'); const signed = receipt(order.orderId);
  const calls = providerCalls.length;
  assert.equal((await post('/buses/verify', { ...signed, razorpaySignature: '0'.repeat(64) })).status, 400);
  assert.equal((await post('/buses/verify', signed, other)).status, 404);
  assert.equal((await post('/hotels/verify', signed)).status, 404);
  assert.equal(providerCalls.length, calls);
});

test('wrong amounts, currency, order IDs and failed payments never confirm a booking', async () => {
  for (const overrides of [{ amount: 1 }, { currency: 'USD' }, { order_id: 'order_other123' }, { status: 'failed' }]) {
    const order = await create('hotels'); const signed = receipt(order.orderId, overrides);
    const response = await post('/hotels/verify', signed);
    assert.ok([400, 409].includes(response.status));
    assert.equal((await db.query<{ payment_status: string }>('SELECT payment_status FROM bookings WHERE id=$1', [order.bookingId])).rows[0].payment_status, 'pending');
  }
});

test('authorized test payments are captured before confirmation', async () => {
  const order = await create('packages'); const signed = receipt(order.orderId, { status: 'authorized' });
  assert.equal((await post('/packages/verify', signed)).status, 200);
  assert.ok(providerCalls.some(url => url.endsWith(`/${signed.razorpayPaymentId}/capture`)));
});

test('cancelled bookings cannot be paid and provider failures do not create bookings', async () => {
  const order = await create(); const signed = receipt(order.orderId);
  await db.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [order.bookingId]);
  assert.equal((await post('/flights/verify', signed)).status, 409);
  const beforeCount = (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM bookings')).rows[0].count;
  rejectOrder = true;
  assert.equal((await post('/flights/order', details)).status, 502);
  rejectOrder = false;
  assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM bookings')).rows[0].count, beforeCount);
});
