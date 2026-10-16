import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { notifyBookingCreated } from '../notifications.js';
import { rateAllowed } from '../rateLimit.js';
const services = { flights: 'Flights', buses: 'Buses', hotels: 'Hotels', packages: 'Holiday Package', cart: 'Travel Cart' };
const serviceSchema = z.enum(['flights', 'buses', 'hotels', 'packages', 'cart']);
const orderSchema = z.strictObject({
    amount: z.number().finite().min(1).max(1_000_000),
    currency: z.literal('INR'),
    itemName: z.string().trim().min(1).max(300),
    tripDate: z.string().date().optional(),
    couponCode: z.string().trim().max(40).optional(),
});
const verifySchema = z.strictObject({
    razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/),
    razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/),
    razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/),
});
function testKeys() {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
    return keyId?.startsWith('rzp_test_') && keySecret ? { keyId, keySecret } : null;
}
// These catalogue fares are client estimates. Live keys are deliberately rejected.
export function createBookingPaymentsRouter({ database = query, providerFetch = fetch, notify = notifyBookingCreated } = {}) {
    const router = Router();
    router.use(requireAuth);
    router.post('/:service/order', async (request, response, next) => {
        const service = serviceSchema.safeParse(request.params.service);
        if (!service.success)
            return response.status(404).json({ error: 'Payment service not found.' });
        const keys = testKeys();
        if (!keys)
            return response.status(503).json({ error: 'Razorpay test payments are not configured. Set test keys on the app backend.' });
        const parsed = orderSchema.safeParse(request.body);
        if (!parsed.success)
            return response.status(400).json({ error: 'Valid booking details and an INR amount between 1 and 1,000,000 are required.' });
        if (!rateAllowed(`booking-payment:${request.user.id}`, 20, 15 * 60 * 1000))
            return response.status(429).json({ error: 'Too many payment attempts. Try again later.' });
        const { amount, itemName, tripDate, couponCode } = parsed.data;
        const amountPaise = Math.round(amount * 100);
        const reference = `LT-${service.data.toUpperCase().slice(0, 2)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`.toUpperCase();
        try {
            const result = await providerFetch('https://api.razorpay.com/v1/orders', {
                method: 'POST', signal: AbortSignal.timeout(12_000),
                headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64') },
                body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: reference, notes: { service: service.data, userId: request.user.id, couponCode: couponCode ?? '', testMode: 'true' } }),
            });
            const order = await result.json().catch(() => null);
            if (!result.ok || !order?.id || order.amount !== amountPaise || order.currency !== 'INR')
                return response.status(502).json({ error: 'Razorpay could not create the test order. Please try again.' });
            const saved = await database(`INSERT INTO bookings (user_id, service_name, item_name, price, amount, currency, trip_date, payment_status, provider_reference, status)
         VALUES ($1, $2, $3, $4, $5, 'INR', $6, 'pending', $7, 'upcoming') RETURNING id`, [request.user.id, services[service.data], itemName, `₹${(amountPaise / 100).toLocaleString('en-IN')}`, amountPaise / 100, tripDate ?? null, order.id]);
            return response.status(201).json({ orderId: order.id, amount: amountPaise, currency: 'INR', keyId: keys.keyId, bookingId: saved.rows[0].id, bookingReference: reference, testMode: true });
        }
        catch (error) {
            return next(error);
        }
    });
    router.post('/:service/verify', async (request, response, next) => {
        const service = serviceSchema.safeParse(request.params.service);
        if (!service.success)
            return response.status(404).json({ error: 'Payment service not found.' });
        const keys = testKeys();
        if (!keys)
            return response.status(503).json({ error: 'Razorpay test payments are not configured.' });
        const parsed = verifySchema.safeParse(request.body);
        if (!parsed.success)
            return response.status(400).json({ error: 'Payment verification details are required.' });
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;
        const expected = createHmac('sha256', keys.keySecret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature)))
            return response.status(400).json({ error: 'Invalid payment signature.' });
        try {
            const params = [request.user.id, services[service.data], razorpayOrderId];
            const find = () => database('SELECT id, item_name, payment_status, status, amount, currency FROM bookings WHERE user_id = $1 AND service_name = $2 AND provider_reference = $3', params);
            const booking = (await find()).rows[0];
            if (!booking)
                return response.status(404).json({ error: 'Payment order not found.' });
            if (booking.status === 'cancelled')
                return response.status(409).json({ error: 'This booking was cancelled. Contact support with your payment ID.' });
            if (booking.payment_status === 'paid')
                return response.json({ status: 'paid', bookingId: booking.id });
            if (booking.payment_status !== 'pending')
                return response.status(409).json({ error: 'This order can no longer be completed.' });
            const headers = { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64') };
            const paymentUrl = `https://api.razorpay.com/v1/payments/${razorpayPaymentId}`;
            const result = await providerFetch(paymentUrl, { headers, signal: AbortSignal.timeout(12_000) });
            let payment = await result.json().catch(() => null);
            const amountPaise = Math.round(Number(booking.amount) * 100);
            const matches = (p) => p?.id === razorpayPaymentId && p.order_id === razorpayOrderId && p.amount === amountPaise && p.currency === booking.currency;
            if (!result.ok || !matches(payment))
                return response.status(400).json({ error: 'Razorpay payment does not match this booking.' });
            // Work with either automatic or manual capture in the test dashboard.
            if (payment.status === 'authorized') {
                const captured = await providerFetch(`${paymentUrl}/capture`, { method: 'POST', headers, signal: AbortSignal.timeout(12_000), body: JSON.stringify({ amount: amountPaise, currency: booking.currency }) });
                payment = await captured.json().catch(() => null);
                if (!captured.ok || !matches(payment))
                    return response.status(502).json({ error: 'Payment capture could not be confirmed. Retry verification.' });
            }
            if (payment.status !== 'captured')
                return response.status(409).json({ error: 'Payment has not completed. Retry verification or contact support with your payment ID.' });
            const updated = await database(`UPDATE bookings SET payment_status = 'paid', status = 'confirmed'
        WHERE user_id = $1 AND service_name = $2 AND provider_reference = $3 AND payment_status = 'pending' AND status <> 'cancelled'
        RETURNING id, item_name, payment_status, status, amount, currency`, params);
            if (updated.rows[0])
                await notify(request.user.id, updated.rows[0]);
            const confirmed = updated.rows[0] ?? (await find()).rows[0];
            if (confirmed?.payment_status !== 'paid' || confirmed.status === 'cancelled')
                return response.status(409).json({ error: 'Booking could not be confirmed. Contact support with your payment ID.' });
            return response.json({ status: 'paid', bookingId: confirmed.id });
        }
        catch (error) {
            return next(error);
        }
    });
    return router;
}
export const bookingPaymentsRouter = createBookingPaymentsRouter();
