import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';

export const supportTopics = ['General Booking', 'Travel & Duration', 'Payments', 'Cancellation', 'Account & Login', 'Feedback', 'Visa', 'Other'] as const;
export const supportRequestSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  email: z.email().max(255), topic: z.enum(supportTopics),
  subject: z.string().trim().min(3).max(200), message: z.string().trim().min(10).max(5000),
  reference: z.string().trim().max(100).optional(), submissionKey: z.string().uuid(),
});
type SupportRow = { id: string; topic: string; subject: string; message: string; status: string; createdAt: string; updateCount: number };
const fields = `r.id, r.topic, r.subject, r.message, r.status, r.created_at AS "createdAt", (SELECT count(*)::int FROM support_request_updates u WHERE u.request_id = r.id) AS "updateCount"`;
type SupportDatabase = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
export function createSupportRouter(database: SupportDatabase = query) {
  const router = Router();
  router.use(requireAuth);
  router.get('/requests', async (request, response, next) => {
    try {
      const result = await database<SupportRow>(`SELECT ${fields} FROM support_requests r WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [request.user!.id]);
      return response.json({ items: result.rows });
    } catch (error) { if (schemaUnavailable(error)) return response.status(503).json({ error: 'Support tracking is not available yet. Please contact the team by email or WhatsApp.' }); return next(error); }
  });
  router.post('/requests', async (request, response, next) => {
    const parsed = supportRequestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Add your name, valid email, topic, subject, and a message of at least 10 characters.' });
    const input = parsed.data;
    try {
      const created = await database<{ id: string }>(`INSERT INTO support_requests (id, user_id, first_name, last_name, email, topic, subject, message, booking_reference, submission_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (user_id, submission_key) DO UPDATE SET id = support_requests.id RETURNING id`,
      [randomUUID(), request.user!.id, input.firstName, input.lastName, input.email, input.topic, input.subject, input.message, input.reference || null, input.submissionKey]);
      const id = created.rows[0].id;
      await database(`INSERT INTO support_request_updates (id, request_id, event_key, message) VALUES ($1,$2,'received','Your support request has been received.') ON CONFLICT (request_id, event_key) DO NOTHING`, [randomUUID(), id]);
      const result = await database<SupportRow>(`SELECT ${fields} FROM support_requests r WHERE r.id = $1 AND r.user_id = $2`, [id, request.user!.id]);
      return response.status(201).json({ request: result.rows[0] });
    } catch (error) { if (schemaUnavailable(error)) return response.status(503).json({ error: 'Support submission is not available yet. Please contact the team by email or WhatsApp.' }); return next(error); }
  });
  router.get('/requests/:id', async (request, response, next) => {
    if (!z.uuid().safeParse(request.params.id).success) return response.status(400).json({ error: 'Invalid request reference.' });
    try {
      const result = await database<SupportRow>(`SELECT ${fields} FROM support_requests r WHERE r.id = $1 AND r.user_id = $2`, [request.params.id, request.user!.id]);
      if (!result.rows[0]) return response.status(404).json({ error: 'Support request not found.' });
      const updates = await database(`SELECT u.id, u.message, u.created_at AS "createdAt" FROM support_request_updates u JOIN support_requests r ON r.id = u.request_id WHERE r.id = $1 AND r.user_id = $2 ORDER BY u.created_at`, [request.params.id, request.user!.id]);
      return response.json({ request: result.rows[0], updates: updates.rows });
    } catch (error) { if (schemaUnavailable(error)) return response.status(503).json({ error: 'Support tracking is not available yet.' }); return next(error); }
  });
  return router;
}
function schemaUnavailable(error: unknown) { return typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01'; }
export const supportRouter = createSupportRouter();
