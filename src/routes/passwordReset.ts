import { Router, static as serveStatic } from 'express';
import { fileURLToPath } from 'node:url';
import { passwordResetPage } from '../passwordResetPage.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hashOpaqueToken, hashPassword } from '../auth.js';
import { env } from '../config.js';
import { pool, query } from '../db.js';
import { rateAllowed } from '../rateLimit.js';

const router = Router();
const linkRouter = Router();
linkRouter.use('/reset-password/assets', serveStatic(fileURLToPath(new URL('../../public/password-reset/', import.meta.url)), {
  index: false,
  dotfiles: 'deny',
}));
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

// An HTTPS email link works in email clients that filter custom URL schemes.
// The browser form also works for localhost previews; visiting never consumes the token.
linkRouter.get('/reset-password', (request, response) => {
  const parsed = z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/).safeParse(request.query.token);
  response.set('Cache-Control', 'no-store');
  if (!parsed.success) return response.status(400).type('html').send(passwordResetPage(null));
  const token = parsed.data;
  return response.type('html').send(passwordResetPage(token));
});

linkRouter.get('/reset-password/open.js', (_request, response) => {
  response.type('application/javascript').send(String.raw`
const form = document.getElementById('reset-password-form');
const status = document.getElementById('reset-status');
if (form && status) {
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const token = form.elements.namedItem('token').value;
    const newPassword = form.elements.namedItem('newPassword').value;
    const confirmPassword = form.elements.namedItem('confirmPassword').value;
    if (newPassword.length < 8 || newPassword.length > 128 || newPassword !== confirmPassword) {
      status.dataset.state = 'error';
      status.textContent = 'Passwords must match and contain 8–128 characters.';
      return;
    }
    button.disabled = true;
    status.dataset.state = 'loading';
    status.textContent = 'Updating your password…';
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({ token, newPassword }),
        signal: AbortSignal.timeout(90_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.success !== true) {
        status.dataset.state = 'error';
        status.textContent = typeof result?.error === 'string' ? result.error : 'Unable to reset your password. Please try again.';
        button.disabled = false;
        return;
      }
      form.reset();
      form.hidden = true;
      status.dataset.state = 'success';
      status.textContent = 'Your password has been updated. Return to LemonTrip in your browser or app and log in with your new password.';
    } catch {
      status.dataset.state = 'error';
      status.textContent = 'Could not reach the account service. Check your connection and try again.';
      button.disabled = false;
    }
  });
}
`);
});

// Sends the reset link by email. If no email provider is set up, the link is printed
// to the server console in development only, so the flow can be tested without email.
async function sendPasswordResetEmail(email: string, firstName: string, token: string) {
  const defaultLink = new URL('/app/reset-password', env.PUBLIC_API_URL);
  const base = process.env.APP_PASSWORD_RESET_URL?.trim() || process.env.PASSWORD_RESET_URL?.trim();
  let link = base ? new URL(base) : defaultLink;
  // Replace either old website reset page with the app backend opener.
  if (['http:', 'https:'].includes(link.protocol) && ['lemontrip.in', 'www.lemontrip.in'].includes(link.hostname) && /^\/(app\/)?reset-password\/?$/.test(link.pathname)) {
    defaultLink.search = link.search;
    link = defaultLink;
  }
  link.searchParams.set('token', token);
  const resetUrl = link.toString();
  if (env.EMAIL_PROVIDER !== 'resend' || !env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    if (process.env.NODE_ENV === 'production') throw new Error('EMAIL_PROVIDER_NOT_CONFIGURED');
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
      html: `<p>Hello ${safeName},</p><p>Use this link to reset your LemonTrip app password:</p><p><a href="${resetUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Reset app password</a></p><p>You can also paste this reset code into the app: <code>${token}</code></p><p>This link expires in 30 minutes and can only be used once. If you did not ask for this, you can ignore this email.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new Error('EMAIL_PROVIDER_SEND_FAILED');
}

// Always answers the same way, so nobody can find out which emails have accounts.
router.post('/forgot-password', async (request, response, next) => {
  const parsed = z.object({ email: emailSchema }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid email address.' });
  if (!rateAllowed(`reset-ip:${request.ip}`, 10, 3_600_000)) {
    return response.status(429).json({ error: 'Too many reset requests. Try again later.' });
  }
  const generic = { success: true, message: 'If an account exists for this email, a reset link will be sent.' };
  try {
    if (!rateAllowed(`reset-email:${parsed.data.email}`, 3, 3_600_000)) return response.json(generic);
    const found = await query<{ id: string; email: string; first_name: string | null }>(
      "SELECT id, email, first_name FROM users WHERE lower(email) = $1 AND account_status = 'active'",
      [parsed.data.email],
    );
    const user = found.rows[0];
    if (user) {
      const token = randomBytes(32).toString('base64url');
      await query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
        [user.id, hashOpaqueToken(token)],
      );
      try {
        await sendPasswordResetEmail(user.email, user.first_name ?? '', token);
      } catch (error) {
        console.error('Password reset email failed:', error instanceof Error ? error.message : error);
      }
    }
    return response.json(generic);
  } catch (error) {
    return next(error);
  }
});

// Token works once and expires. A successful reset signs out every session of that user.
router.post('/reset-password', async (request, response, next) => {
  const parsed = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(8).max(128) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid reset details.' });
  if (!rateAllowed(`reset-confirm:${request.ip}`, 10, 15 * 60 * 1000)) {
    return response.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const invalid = { error: 'This reset link is invalid or has expired.' };
  try {
    const newHash = await hashPassword(parsed.data.newPassword);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const used = await client.query<{ user_id: string }>(
        'UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id',
        [hashOpaqueToken(parsed.data.token)],
      );
      const userId = used.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
        return response.status(400).json(invalid);
      }
      const updated = await client.query(
        "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 AND account_status = 'active'",
        [userId, newHash],
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return response.status(400).json(invalid);
      }
      await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
      const revoked = await client.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await client.query('COMMIT');
      return response.json({ success: true, sessionsLoggedOut: revoked.rowCount ?? 0 });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
});

export { router as passwordResetRouter, linkRouter as passwordResetLinkRouter };
