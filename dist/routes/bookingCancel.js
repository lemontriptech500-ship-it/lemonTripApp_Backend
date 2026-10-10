import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { createNotification } from '../notifications.js';
const router = Router();
// A user cancels their own booking. Allowed only while payment is still pending,
// so no money has moved and no refund is involved. Paid bookings need support.
router.post('/:id/cancel', requireAuth, async (request, response, next) => {
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success)
        return response.status(404).json({ error: 'Booking not found' });
    try {
        const updated = await query("UPDATE bookings SET status = 'cancelled', payment_status = 'cancelled' WHERE id = $1 AND user_id = $2 AND payment_status = 'pending' AND status NOT IN ('cancelled', 'completed') RETURNING id, item_name", [id.data, request.user?.id]);
        const booking = updated.rows[0];
        if (!booking) {
            const found = await query('SELECT status FROM bookings WHERE id = $1 AND user_id = $2', [id.data, request.user?.id]);
            if (!found.rows[0])
                return response.status(404).json({ error: 'Booking not found' });
            if (found.rows[0].status === 'cancelled')
                return response.status(409).json({ error: 'Booking is already cancelled.' });
            return response.status(409).json({ error: 'This booking cannot be cancelled online. Please contact support.' });
        }
        try {
            await createNotification(request.user.id, 'booking_cancelled', 'Booking cancelled', `Your booking for ${booking.item_name} was cancelled.`, { bookingId: booking.id });
        }
        catch (error) {
            console.error('Could not create cancel notification', error);
        }
        return response.json({ success: true, bookingId: booking.id, status: 'cancelled' });
    }
    catch (error) {
        return next(error);
    }
});
export { router as bookingCancelRouter };
