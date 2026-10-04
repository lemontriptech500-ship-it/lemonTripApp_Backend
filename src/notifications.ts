import { query } from './db.js';

export type NotificationType =
  | 'booking_confirmed'
  | 'booking_updated'
  | 'booking_cancelled'
  | 'payment_success'
  | 'payment_failed'
  | 'visa_update'
  | 'general';

export async function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
) {
  await query(
    'INSERT INTO notifications (user_id, type, title, body, data) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [userId, type, title, body, JSON.stringify(data)],
  );
}

type BookingForNotice = { id: string; item_name: string; payment_status: string };

// Called right after a booking is created. It never throws: a failed notification
// must not make the booking itself fail.
export async function notifyBookingCreated(userId: string | undefined, booking: BookingForNotice) {
  if (!userId) return;
  const item = booking.item_name;
  let type: NotificationType = 'booking_updated';
  let title = 'Booking received';
  let body = `We received your booking for ${item}. Payment is pending.`;

  if (booking.payment_status === 'paid') {
    type = 'booking_confirmed';
    title = 'Booking confirmed';
    body = `Your booking for ${item} is confirmed and payment was received.`;
  } else if (booking.payment_status === 'failed') {
    type = 'payment_failed';
    title = 'Payment failed';
    body = `Payment for ${item} could not be completed. Please try again.`;
  } else if (booking.payment_status === 'cancelled') {
    type = 'booking_cancelled';
    title = 'Booking cancelled';
    body = `Your booking for ${item} was cancelled.`;
  }

  try {
    await createNotification(userId, type, title, body, {
      bookingId: booking.id,
      paymentStatus: booking.payment_status,
    });
  } catch (error) {
    console.error('Could not create booking notification', error);
  }
}