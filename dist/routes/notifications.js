import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
const router = Router();
router.use(requireAuth);
const columns = 'id, type, title, body, data, read_at, created_at';
function serialize(row) {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        data: row.data,
        read: row.read_at !== null,
        readAt: row.read_at,
        createdAt: row.created_at,
    };
}
const deviceSchema = z.strictObject({
    token: z.string().trim().min(10).max(500),
    platform: z.enum(['android', 'ios', 'web']),
    deviceId: z.string().trim().max(200).optional(),
});
const removeDeviceSchema = z.strictObject({
    token: z.string().trim().min(10).max(500),
});
const listSchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    unread: z.enum(['true', 'false']).optional(),
});
const idSchema = z.string().uuid();
// Register (or refresh) this device for push notifications.
// If the same token was used by another account on this phone, it moves to the current user.
router.post('/devices', async (request, response, next) => {
    const parsed = deviceSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ error: 'Invalid device details.', issues: parsed.error.issues });
    }
    const { token, platform, deviceId } = parsed.data;
    try {
        await query(`INSERT INTO device_tokens (user_id, token, device_platform, device_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             device_platform = EXCLUDED.device_platform,
             device_id = EXCLUDED.device_id,
             is_active = true,
             last_used_at = now()`, [request.user?.id, token, platform, deviceId ?? null]);
        return response.status(201).json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
// Stop push notifications to this device (for example on logout).
router.delete('/devices', async (request, response, next) => {
    const parsed = removeDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
        return response.status(400).json({ error: 'Invalid device details.', issues: parsed.error.issues });
    }
    try {
        await query('UPDATE device_tokens SET is_active = false WHERE token = $1 AND user_id = $2', [
            parsed.data.token,
            request.user?.id,
        ]);
        return response.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
router.get('/', async (request, response, next) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) {
        return response.status(400).json({ error: 'Invalid query.', issues: parsed.error.issues });
    }
    try {
        const result = await query(`SELECT ${columns} FROM notifications
       WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
       ORDER BY created_at DESC
       LIMIT $3`, [request.user?.id, parsed.data.unread === 'true', parsed.data.limit]);
        return response.json({ notifications: result.rows.map(serialize) });
    }
    catch (error) {
        return next(error);
    }
});
router.get('/unread-count', async (request, response, next) => {
    try {
        const result = await query('SELECT count(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL', [request.user?.id]);
        return response.json({ unread: Number(result.rows[0].count) });
    }
    catch (error) {
        return next(error);
    }
});
router.post('/read-all', async (request, response, next) => {
    try {
        const result = await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [request.user?.id]);
        return response.json({ updated: result.rowCount ?? 0 });
    }
    catch (error) {
        return next(error);
    }
});
router.patch('/:id/read', async (request, response, next) => {
    const id = idSchema.safeParse(request.params.id);
    if (!id.success)
        return response.status(400).json({ error: 'Invalid notification id.' });
    try {
        const result = await query(`UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2
       RETURNING ${columns}`, [id.data, request.user?.id]);
        const row = result.rows[0];
        if (!row)
            return response.status(404).json({ error: 'Notification not found.' });
        return response.json({ notification: serialize(row) });
    }
    catch (error) {
        return next(error);
    }
});
export { router as notificationsRouter };
