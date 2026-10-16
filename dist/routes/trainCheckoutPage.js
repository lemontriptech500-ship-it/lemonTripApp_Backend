import { randomBytes } from 'node:crypto';
import { Router } from 'express';
// Public page that opens Razorpay Checkout (test mode) inside the mobile app's in-app browser.
// It never sees the user's session: the app has already created the order and will verify the
// payment itself after this page redirects back with the payment details.
const router = Router();
const ALLOWED_REDIRECT_PREFIXES = ['lemontripmobile://', 'exp+lemontripmobile://', 'exp://'];
function clean(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
router.get('/', (request, response) => {
    const keyId = process.env.RAZORPAY_KEY_ID?.trim();
    if (!keyId || !keyId.startsWith('rzp_test_')) {
        return response.status(503).type('text/plain').send('Payments are limited to Razorpay test mode.');
    }
    const order = clean(request.query.order, 60);
    const redirect = clean(request.query.redirect, 500);
    if (!/^order_[A-Za-z0-9]{6,40}$/.test(order))
        return response.status(400).type('text/plain').send('Invalid payment order.');
    if (!ALLOWED_REDIRECT_PREFIXES.some((prefix) => redirect.startsWith(prefix)))
        return response.status(400).type('text/plain').send('Invalid return address.');
    const config = {
        key: keyId,
        order_id: order,
        name: clean(request.query.name, 60) || 'LemonTrip',
        description: clean(request.query.description, 120),
        prefill: { email: clean(request.query.email, 120), contact: clean(request.query.contact, 20), name: clean(request.query.customer, 80) },
        redirect,
    };
    const nonce = randomBytes(16).toString('base64');
    response.setHeader('Content-Security-Policy', [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://checkout.razorpay.com`,
        "style-src 'unsafe-inline' https://checkout.razorpay.com",
        'frame-src https://api.razorpay.com https://checkout.razorpay.com',
        'connect-src https://api.razorpay.com https://lumberjack.razorpay.com https://checkout.razorpay.com',
        'img-src https: data:',
        'font-src https: data:',
        "base-uri 'none'",
    ].join('; '));
    response.setHeader('Cache-Control', 'no-store');
    const json = JSON.stringify(config).replace(/</g, '\\u003c');
    return response.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LemonTrip payment</title>
<style>body{font-family:system-ui,sans-serif;text-align:center;padding:48px 20px;color:#173f33}button{margin-top:20px;padding:14px 28px;font-size:16px;font-weight:700;border:0;border-radius:12px;background:#ffd21a;color:#173f33}</style></head>
<body><p id="m">Opening secure payment…</p><button id="b" type="button" hidden>Open payment</button>
<script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script nonce="${nonce}">
var cfg = ${json};
function back(params) { location.href = cfg.redirect + (cfg.redirect.indexOf('?') >= 0 ? '&' : '?') + new URLSearchParams(params).toString(); }
function start() {
  if (!window.Razorpay) { document.getElementById('m').textContent = 'Razorpay could not load. Check your connection.'; return; }
  var rzp = new Razorpay({
    key: cfg.key, order_id: cfg.order_id, name: cfg.name, description: cfg.description, prefill: cfg.prefill, theme: { color: '#ffd21a' },
    handler: function (r) { back({ status: 'success', razorpay_payment_id: r.razorpay_payment_id, razorpay_order_id: r.razorpay_order_id, razorpay_signature: r.razorpay_signature }); },
    modal: { ondismiss: function () { back({ status: 'cancelled' }); } }
  });
  rzp.on('payment.failed', function (r) { back({ status: 'failed', reason: (r.error && r.error.description) || 'Payment failed' }); });
  var b = document.getElementById('b');
  b.hidden = false; b.onclick = function () { rzp.open(); };
  rzp.open();
}
window.addEventListener('load', start);
</script></body></html>`);
});
export const trainCheckoutPageRouter = router;
