# Booking cancel API



## POST /api/bookings/:id/cancel



Needs login (Authorization: Bearer token). No body.



A user can cancel only their own booking, and only while payment is still pending. A paid, completed or already cancelled booking cannot be cancelled online.



- 200 { success: true, bookingId, status: "cancelled" }: booking and payment status are set to cancelled, and a booking_cancelled notification is added to the user's inbox.

- 401: not logged in.

- 404 { error: "Booking not found" }: unknown id, invalid id, or a booking that belongs to someone else.

- 409 { error: "Booking is already cancelled." }: cancelled earlier.

- 409 { error: "This booking cannot be cancelled online. Please contact support." }: paid or completed booking. The user should contact support (refund policy is still undecided).

