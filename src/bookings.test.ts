import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBookingInput } from './routes/bookings.js';

test('booking creation never trusts client-supplied payment state', () => {
  const input = normalizeBookingInput({
    serviceName: 'Package',
    itemName: 'Kashmir',
    price: '15999',
    paymentStatus: 'paid',
    status: 'confirmed',
  });

  assert.equal(input.paymentStatus, 'pending');
  assert.equal(input.status, 'upcoming');
});
