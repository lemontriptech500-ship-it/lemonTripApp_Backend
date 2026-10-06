import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { authRouter } from './routes/auth.js';
import { bookingsRouter } from './routes/bookings.js';
import { chatRouter } from './routes/chat.js';
import { contentRouter } from './routes/content.js';
import { notificationsRouter } from './routes/notifications.js';
import { passwordResetRouter } from './routes/passwordReset.js';
import { profileRouter } from './routes/profile.js';

export const app = express();

app.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean), credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'lemontrip-api', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/auth', passwordResetRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/content', contentRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/profile', profileRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Route not found' });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});