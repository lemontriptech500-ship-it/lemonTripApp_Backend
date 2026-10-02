import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { authRouter } from './routes/auth.js';
import { bookingsRouter } from './routes/bookings.js';
import { chatRouter } from './routes/chat.js';
import { contentRouter } from './routes/content.js';

export const app = express();

app.use(helmet({ crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean), credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'lemontrip-api', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/content', contentRouter);

app.use((_request, response) => {
  response.status(404).json({ error: 'Route not found' });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: 'Internal server error' });
});
