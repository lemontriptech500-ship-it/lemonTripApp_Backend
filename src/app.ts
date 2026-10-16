import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { authRouter } from './routes/auth.js';
import { bookingCancelRouter } from './routes/bookingCancel.js';
import { bookingsRouter } from './routes/bookings.js';
import { supportRouter } from './routes/support.js';
import { chatRouter } from './routes/chat.js';
import { contentRouter } from './routes/content.js';
import { couponsRouter } from './routes/coupons.js';
import { notificationsRouter } from './routes/notifications.js';
import { passwordResetRouter, passwordResetLinkRouter } from './routes/passwordReset.js';
import { profileRouter } from './routes/profile.js';
import { walletRouter } from './routes/wallet.js';
import { trainCheckoutPageRouter } from './routes/trainCheckoutPage.js';
import { trainPaymentsRouter } from './routes/trainPayments.js';
import { bookingPaymentsRouter } from './routes/bookingPayments.js';
import { walletTopupsRouter } from './routes/walletTopups.js';

export const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

app.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
// The app's email reset form is hosted on the website, but uses this API.
app.use('/api/auth/reset-password', cors({ origin: [
  'https://lemontrip.in', 'https://www.lemontrip.in',
  ...env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
] }));
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean), credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'lemontrip-api', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/auth', passwordResetRouter);
app.use('/app', passwordResetLinkRouter);
app.use('/pay/train', trainCheckoutPageRouter);
app.use('/pay/checkout', trainCheckoutPageRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/bookings', bookingCancelRouter);
app.use('/api/chat', chatRouter);
app.use('/api/support', supportRouter);
app.use('/api/content', contentRouter);
app.use('/api/coupons', couponsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/payments/razorpay/trains', trainPaymentsRouter);
app.use('/api/payments/razorpay', bookingPaymentsRouter);
app.use('/api/wallet/topups', walletTopupsRouter);
app.use('/api/wallet', walletRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Route not found' });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});
