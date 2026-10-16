import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { pool } from '../db.js';
import { rateAllowed } from '../rateLimit.js';

const router = Router();
router.use(requireAuth);

const MIN_TOPUP_PAISE = 10000;
const MAX_TOPUP_PAISE = 10000000;

type WalletRow = { id: string; balance_paise: string; currency: string; status: string };

function razorpayKeys() {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  return keyId?.startsWith('rzp_test_') && keySecret ? { keyId, keySecret } : null;
}

function makeReference() {
  return 'LT-WTU-' + Date.now().toString(36).toUpperCase() + '-' + randomBytes(4).toString('hex').toUpperCase();
}

const createSchema = z.object({ amount: z.coerce.number().finite() });
const verifySchema = z.object({
  razorpayOrderId: z.string().min(1).max(100),
  razorpayPaymentId: z.string().min(1).max(100),
  razorpaySignature: z.string().min(1).max(200),
});

// Creates a Razorpay order for a wallet top-up. The amount is validated on the server.
router.post('/', async (request, response, next) => {
  const keys = razorpayKeys();
  if (!keys) return response.status(503).json({ error: 'Wallet top-ups are not available right now.' });
  if (!rateAllowed('topup:' + request.user!.id, 10, 15 * 60 * 1000)) {
    return response.status(429).json({ error: 'Too many top-up attempts. Try again later.' });
  }
  const parsed = createSchema.safeParse(request.body);
  const amountPaise = parsed.success ? Math.round(parsed.data.amount * 100) : 0;
  if (!parsed.success || amountPaise < MIN_TOPUP_PAISE || amountPaise > MAX_TOPUP_PAISE) {
    return response.status(400).json({ error: 'Top-up amount must be between INR 100 and INR 100,000.' });
  }

  const client = await pool.connect();
  try {
    const walletResult = await client.query<WalletRow>(
      'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id, balance_paise, currency, status',
      [request.user!.id],
    );
    const wallet = walletResult.rows[0];
    if (wallet.status !== 'active') return response.status(403).json({ error: 'Your wallet is not active.' });

    const topupReference = makeReference();
    const orderResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(keys.keyId + ':' + keys.keySecret).toString('base64'),
      },
      body: JSON.stringify({ amount: amountPaise, currency: wallet.currency, receipt: topupReference, notes: { topupReference, userId: request.user!.id } }),
    });
    const order = (await orderResponse.json().catch(() => null)) as { id?: string; amount?: number; currency?: string } | null;
    if (!orderResponse.ok || !order?.id) {
      return response.status(502).json({ error: 'The payment provider could not create the order. Please try again.' });
    }

    const saved = await client.query<{ id: string; topup_reference: string }>(
      'INSERT INTO wallet_topups (user_id, wallet_id, topup_reference, amount_paise, razorpay_order_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, topup_reference',
      [request.user!.id, wallet.id, topupReference, amountPaise, order.id],
    );
    return response.status(201).json({
      orderId: order.id,
      amount: order.amount ?? amountPaise,
      currency: order.currency ?? wallet.currency,
      keyId: keys.keyId,
      topupId: saved.rows[0].id,
      topupReference: saved.rows[0].topup_reference,
    });
  } catch (error) {
    return next(error);
  } finally {
    client.release();
  }
});

// Verifies the Razorpay signature, then credits the wallet once (row locks make retries safe).
router.post('/verify', async (request, response, next) => {
  const keys = razorpayKeys();
  if (!keys) return response.status(503).json({ error: 'Wallet top-ups are not available right now.' });
  const parsed = verifySchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Payment verification details are required.' });
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

  const expected = createHmac('sha256', keys.keySecret).update(razorpayOrderId + '|' + razorpayPaymentId).digest('hex');
  const matches = expected.length === razorpaySignature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature));
  if (!matches) return response.status(400).json({ error: 'Invalid payment signature.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const topupResult = await client.query<{ id: string; wallet_id: string; topup_reference: string; amount_paise: string; status: string }>(
      'SELECT id, wallet_id, topup_reference, amount_paise, status FROM wallet_topups WHERE user_id = $1 AND razorpay_order_id = $2 FOR UPDATE',
      [request.user!.id, razorpayOrderId],
    );
    const topup = topupResult.rows[0];
    if (!topup) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Top-up order not found.' });
    }

    const walletResult = await client.query<WalletRow>(
      'SELECT id, balance_paise, currency, status FROM wallets WHERE id = $1 FOR UPDATE',
      [topup.wallet_id],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Wallet not found.' });
    }

    if (topup.status === 'SUCCESS') {
      await client.query('COMMIT');
      return response.json({ status: 'SUCCESS', balance: Number(wallet.balance_paise) / 100, currency: wallet.currency });
    }
    if (topup.status !== 'PENDING') {
      await client.query('ROLLBACK');
      return response.status(409).json({ error: 'This top-up can no longer be paid.' });
    }
    if (wallet.status !== 'active') {
      await client.query('ROLLBACK');
      return response.status(403).json({ error: 'Your wallet is not active.' });
    }

    const before = BigInt(wallet.balance_paise);
    const after = before + BigInt(topup.amount_paise);
    await client.query('UPDATE wallets SET balance_paise = $1, updated_at = NOW() WHERE id = $2', [after.toString(), wallet.id]);
    await client.query(
      "INSERT INTO wallet_transactions (wallet_id, user_id, transaction_reference, type, source, amount_paise, balance_before_paise, balance_after_paise, status, description, payment_reference) VALUES ($1, $2, $3, 'CREDIT', 'TOPUP', $4, $5, $6, 'SUCCESS', $7, $8)",
      [wallet.id, request.user!.id, topup.topup_reference, topup.amount_paise, before.toString(), after.toString(), 'Wallet top-up', razorpayPaymentId],
    );
    await client.query(
      "UPDATE wallet_topups SET razorpay_payment_id = $1, razorpay_signature = $2, status = 'SUCCESS', updated_at = NOW() WHERE id = $3",
      [razorpayPaymentId, razorpaySignature, topup.id],
    );
    await client.query('COMMIT');
    return response.json({ status: 'SUCCESS', balance: Number(after) / 100, currency: wallet.currency });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

export const walletTopupsRouter = router;
