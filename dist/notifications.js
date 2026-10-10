import { query } from './db.js';
export async function createNotification(userId, type, title, body, data = {}) {
    await query('INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, $2, $3, $4, $5::jsonb)', [userId, type, title, body, JSON.stringify(data)]);
}
// Called right after a booking is created. It never throws: a failed notification
// must not make the booking itself fail.
export async function notifyBookingCreated(userId, booking) {
    if (!userId)
        return;
    const item = booking.item_name;
    let type = 'booking_updated';
    let title = 'Booking received';
    let body = `We received your booking for ${item}. Payment is pending.`;
    if (booking.payment_status === 'paid') {
        type = 'booking_confirmed';
        title = 'Booking confirmed';
        body = `Your booking for ${item} is confirmed and payment was received.`;
    }
    else if (booking.payment_status === 'failed') {
        type = 'payment_failed';
        title = 'Payment failed';
        body = `Payment for ${item} could not be completed. Please try again.`;
    }
    else if (booking.payment_status === 'cancelled') {
        type = 'booking_cancelled';
        title = 'Booking cancelled';
        body = `Your booking for ${item} was cancelled.`;
    }
    try {
        await createNotification(userId, type, title, body, {
            bookingId: booking.id,
            paymentStatus: booking.payment_status,
        });
    }
    catch (error) {
        console.error('Could not create booking notification', error);
    }
}
