import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

const router = Router();
const bookingSchema = z.object({ serviceName: z.string().min(1).max(100), itemName: z.string().min(1).max(300), price: z.string().min(1).max(50), tripDate: z.string().date().optional(), providerReference: z.string().max(200).optional() });
type BookingRow = { id: string; service_name: string; item_name: string; price: string; trip_date: string | null; status: string; payment_status: string; provider_reference: string | null; created_at: string };

export function normalizeBookingInput(body: unknown) {
  return { ...bookingSchema.parse(body), paymentStatus: 'pending' as const, status: 'upcoming' as const };
}

function serialize(row: BookingRow) {
  return { id: row.id, serviceName: row.service_name, itemName: row.item_name, price: row.price, tripDate: row.trip_date, status: row.status, paymentStatus: row.payment_status, providerReference: row.provider_reference, bookedAt: row.created_at };
}

router.use(requireAuth);

router.get('/', async (request, response, next) => {
  try {
    const result = await query<BookingRow>('SELECT id, service_name, item_name, price, trip_date, status, payment_status, provider_reference, created_at FROM bookings WHERE user_id = $1 ORDER BY created_at DESC', [request.user?.id]);
    return response.json({ bookings: result.rows.map(serialize) });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (request, response, next) => {
  try {
    const result = await query<BookingRow>('SELECT id, service_name, item_name, price, trip_date, status, payment_status, provider_reference, created_at FROM bookings WHERE id = $1 AND user_id = $2', [request.params.id, request.user?.id]);
    const booking = result.rows[0];
    if (!booking) return response.status(404).json({ error: 'Booking not found' });
    return response.json({ booking: serialize(booking) });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (request, response, next) => {
  try {
    const input = normalizeBookingInput(request.body);
    const result = await query<BookingRow>('INSERT INTO bookings (user_id, service_name, item_name, price, trip_date, payment_status, provider_reference, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, service_name, item_name, price, trip_date, status, payment_status, provider_reference, created_at', [request.user?.id, input.serviceName, input.itemName, input.price, input.tripDate ?? null, input.paymentStatus, input.providerReference ?? null, input.status]);
    return response.status(201).json({ booking: serialize(result.rows[0]) });
  } catch (error: any) {
    if (error?.name === 'ZodError') return response.status(400).json({ error: 'Invalid booking details', issues: error.issues });
    return next(error);
  }
});

export { router as bookingsRouter };
