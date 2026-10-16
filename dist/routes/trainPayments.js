import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { notifyBookingCreated } from '../notifications.js';
import { rateAllowed } from '../rateLimit.js';
const router = Router();
router.use(requireAuth);
// The mobile train catalogue is local sample data, so the server cannot re-price a train
// the way the website backend does. Because the amount comes from the client, this route
// only works with Razorpay TEST keys (rzp_test_...) and caps the amount per passenger.
const MAX_PER_PASSENGER_RUPEES = 25000;
function razorpayTestKeys() {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    if (!keyId || !keySecret)
        return { error: 'Razorpay is not configured on the server.' };
    if (!keyId.startsWith('rzp_test_')) {
        return { error: 'Train payments are limited to Razorpay test mode. Use rzp_test_ keys on this server.' };
    }
    return { keyId, keySecret };
}
const orderSchema = z.object({
    amount: z.coerce.number().finite().positive(),
    passengers: z.coerce.number().int().min(1).max(6),
    trainName: z.string().trim().min(1).max(120),
    route: z.string().trim().min(1).max(120),
    journeyDate: z.string().date(),
    couponCode: z.string().trim().max(40).optional(),
});
const verifySchema = z.object({
    razorpayOrderId: z.string().min(1).max(100),
    razorpayPaymentId: z.string().min(1).max(100),
    razorpaySignature: z.string().min(1).max(200),
});
// Creates a Razorpay (test mode) order and a pending booking row that references it.
router.post('/order', async (request, response, next) => {
    const keys = razorpayTestKeys();
    if ('error' in keys)
        return response.status(503).json({ error: keys.error });
    if (!rateAllowed(`train-order:${request.user.id}`, 15, 15 * 60 * 1000)) {
        return response.status(429).json({ error: 'Too many payment attempts. Try again later.' });
    }
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Valid train booking details are required.' });
    const { amount, passengers, trainName, route, journeyDate, couponCode } = parsed.data;
    const amountPaise = Math.round(amount * 100);
    if (amountPaise < 100 || amount > passengers * MAX_PER_PASSENGER_RUPEES) {
        return response.status(400).json({ error: 'Train fare is outside the allowed range.' });
    }
    try {
        const reference = 'LT-TR-' + Date.now().toString(36).toUpperCase() + '-' + randomBytes(3).toString('hex').toUpperCase();
        const orderResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(keys.keyId + ':' + keys.keySecret).toString('base64'),
            },
            body: JSON.stringify({
                amount: amountPaise,
                currency: 'INR',
                receipt: reference,
                notes: { itemType: 'train', userId: request.user.id, passengers: String(passengers), couponCode: couponCode || '' },
            }),
        });
        const order = (await orderResponse.json().catch(() => null));
        if (!orderResponse.ok || !order?.id) {
            return response.status(502).json({ error: 'The payment provider could not create the order. Please try again.' });
        }
        const saved = await query(`INSERT INTO bookings (user_id, service_name, item_name, price, trip_date, payment_status, provider_reference, status)
       VALUES ($1, 'Trains', $2, $3, $4, 'pending', $5, 'upcoming') RETURNING id`, [request.user.id, `${trainName} · ${route}`, `₹${amount.toLocaleString('en-IN')}`, journeyDate, order.id]);
        return response.status(201).json({
            orderId: order.id,
            amount: order.amount ?? amountPaise,
            currency: order.currency ?? 'INR',
            keyId: keys.keyId,
            bookingId: saved.rows[0].id,
            bookingReference: reference,
            testMode: true,
        });
    }
    catch (error) {
        return next(error);
    }
});
// Verifies the Razorpay signature, then marks the booking paid (safe to retry).
router.post('/verify', async (request, response, next) => {
    const keys = razorpayTestKeys();
    if ('error' in keys)
        return response.status(503).json({ error: keys.error });
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Payment verification details are required.' });
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;
    const expected = createHmac('sha256', keys.keySecret).update(razorpayOrderId + '|' + razorpayPaymentId).digest('hex');
    const matches = expected.length === razorpaySignature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature));
    if (!matches)
        return response.status(400).json({ error: 'Invalid payment signature.' });
    try {
        const updated = await query(`UPDATE bookings SET payment_status = 'paid', status = 'confirmed'
       WHERE user_id = $1 AND service_name = 'Trains' AND provider_reference = $2 AND payment_status = 'pending'
       RETURNING id, item_name, payment_status`, [request.user.id, razorpayOrderId]);
        if (updated.rows[0]) {
            await notifyBookingCreated(request.user.id, updated.rows[0]);
            return response.json({ status: 'paid', bookingId: updated.rows[0].id });
        }
        const existing = await query(`SELECT id, item_name, payment_status FROM bookings WHERE user_id = $1 AND service_name = 'Trains' AND provider_reference = $2`, [request.user.id, razorpayOrderId]);
        if (!existing.rows[0])
            return response.status(404).json({ error: 'Payment order not found.' });
        if (existing.rows[0].payment_status === 'paid')
            return response.json({ status: 'paid', bookingId: existing.rows[0].id });
        return response.status(409).json({ error: 'This payment can no longer be completed.' });
    }
    catch (error) {
        return next(error);
    }
});
export const trainPaymentsRouter = router;
