import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashOpaqueToken, hashPassword } from '../auth.js';
import { env } from '../config.js';
import { pool, query } from '../db.js';
import { rateAllowed } from '../rateLimit.js';
const router = Router();
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
// Sends the reset link by email. If no email provider is set up, the link is printed
// to the server console in development only, so the flow can be tested without email.
async function sendPasswordResetEmail(email, firstName, token) {
    const base = process.env.PASSWORD_RESET_URL ?? `${env.PUBLIC_API_URL.replace(/\/$/, '')}/reset-password`;
    const resetUrl = `${base}?token=${encodeURIComponent(token)}`;
    if (env.EMAIL_PROVIDER !== 'resend' || !env.EMAIL_API_KEY || !env.EMAIL_FROM) {
        if (process.env.NODE_ENV === 'production')
            throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
        console.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
        return;
    }
    const safeName = firstName.replace(/[<>"'&]/g, '');
    const result = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [email],
            subject: 'Reset your LemonTrip password',
            html: `<p>Hello ${safeName},</p><p>Use this link to reset your LemonTrip password:</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in 30 minutes and can only be used once. If you did not ask for this, you can ignore this email.</p>`,
        }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!result.ok)
        throw new Error('EMAIL_PROVIDER_SEND_FAILED');
}
// Always answers the same way, so nobody can find out which emails have accounts.
router.post('/forgot-password', async (request, response, next) => {
    const parsed = z.object({ email: emailSchema }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid email address.' });
    if (!rateAllowed(`reset-ip:${request.ip}`, 10, 3_600_000)) {
        return response.status(429).json({ error: 'Too many reset requests. Try again later.' });
    }
    const generic = { success: true, message: 'If an account exists for this email, a reset link will be sent.' };
    try {
        if (!rateAllowed(`reset-email:${parsed.data.email}`, 3, 3_600_000))
            return response.json(generic);
        const found = await query("SELECT id, email, first_name FROM users WHERE lower(email) = $1 AND account_status = 'active'", [parsed.data.email]);
        const user = found.rows[0];
        if (user) {
            const token = randomBytes(32).toString('base64url');
            await query('UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [user.id]);
            await query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [user.id, hashOpaqueToken(token)]);
            try {
                await sendPasswordResetEmail(user.email, user.first_name ?? '', token);
            }
            catch (error) {
                console.error('Password reset email failed:', error instanceof Error ? error.message : error);
            }
        }
        return response.json(generic);
    }
    catch (error) {
        return next(error);
    }
});
// Token works once and expires. A successful reset signs out every session of that user.
router.post('/reset-password', async (request, response, next) => {
    const parsed = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(8).max(128) }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid reset details.' });
    if (!rateAllowed(`reset-confirm:${request.ip}`, 10, 15 * 60 * 1000)) {
        return response.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    const invalid = { error: 'This reset link is invalid or has expired.' };
    try {
        const newHash = await hashPassword(parsed.data.newPassword);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const used = await client.query('UPDATE password_reset_tokens SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id', [hashOpaqueToken(parsed.data.token)]);
            const userId = used.rows[0]?.user_id;
            if (!userId) {
                await client.query('ROLLBACK');
                return response.status(400).json(invalid);
            }
            const updated = await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND account_status = 'active'", [userId, newHash]);
            if (!updated.rowCount) {
                await client.query('ROLLBACK');
                return response.status(400).json(invalid);
            }
            await client.query('UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [userId]);
            const revoked = await client.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
            await client.query('COMMIT');
            return response.json({ success: true, sessionsLoggedOut: revoked.rowCount ?? 0 });
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        }
        finally {
            client.release();
        }
    }
    catch (error) {
        return next(error);
    }
});
export { router as passwordResetRouter };
