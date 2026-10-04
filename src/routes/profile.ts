import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, requireAuth, verifyPassword } from '../auth.js';
import { query } from '../db.js';

const router = Router();
router.use(requireAuth);

const columns = `id, email, phone, name, first_name, last_name, email_verified, phone_verified,
  avatar_url, to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth, gender, nationality,
  push_notifications_enabled, email_notifications_enabled`;

type ProfileRow = {
  id: string;
  email: string | null;
  phone: string | null;
  name: string;
  first_name: string;
  last_name: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  avatar_url: string | null;
  date_of_birth: string | null;
  gender: string | null;
  nationality: string | null;
  push_notifications_enabled: boolean;
  email_notifications_enabled: boolean;
};

function serialize(row: ProfileRow) {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    emailVerified: row.email_verified,
    phoneVerified: row.phone_verified,
    avatarUrl: row.avatar_url,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    nationality: row.nationality,
    pushNotificationsEnabled: row.push_notifications_enabled,
    emailNotificationsEnabled: row.email_notifications_enabled,
  };
}

// Email and phone are intentionally NOT editable here: changing them needs re-verification.
// Unknown fields (including email/phone) are rejected.
const updateSchema = z.strictObject({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().max(80).nullable().optional(),
  dateOfBirth: z
    .string()
    .date()
    .refine((value) => {
      const date = new Date(value);
      return date <= new Date() && date.getUTCFullYear() >= 1900;
    }, 'Enter a valid date of birth.')
    .nullable()
    .optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  nationality: z.string().trim().min(1).max(80).nullable().optional(),
  avatarUrl: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((value) => value.startsWith('https://'), 'Avatar URL must start with https://')
    .nullable()
    .optional(),
  pushNotificationsEnabled: z.boolean().optional(),
  emailNotificationsEnabled: z.boolean().optional(),
});

router.get('/', async (request, response, next) => {
  try {
    const result = await query<ProfileRow>(
      `SELECT ${columns} FROM users WHERE id = $1 AND account_status = 'active'`,
      [request.user?.id],
    );
    const row = result.rows[0];
    if (!row) return response.status(401).json({ error: 'User account not found.' });
    return response.json({ profile: serialize(row) });
  } catch (error) {
    return next(error);
  }
});

router.patch('/', async (request, response, next) => {
  const parsed = updateSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid profile details.', issues: parsed.error.issues });
  }
  const input = parsed.data;
  if (Object.keys(input).length === 0) {
    return response.status(400).json({ error: 'Nothing to update.' });
  }

  try {
    const current = await query<ProfileRow>(
      `SELECT ${columns} FROM users WHERE id = $1 AND account_status = 'active'`,
      [request.user?.id],
    );
    const existing = current.rows[0];
    if (!existing) return response.status(401).json({ error: 'User account not found.' });

    // Column names below come from this fixed list only, never from user input.
    const updates: Record<string, unknown> = {};
    const firstName = input.firstName ?? existing.first_name;
    const lastName = input.lastName !== undefined ? input.lastName || null : existing.last_name;
    updates.first_name = firstName;
    updates.last_name = lastName;
    updates.name = [firstName, lastName].filter(Boolean).join(' ');
    if (input.dateOfBirth !== undefined) updates.date_of_birth = input.dateOfBirth;
    if (input.gender !== undefined) updates.gender = input.gender;
    if (input.nationality !== undefined) updates.nationality = input.nationality;
    if (input.avatarUrl !== undefined) updates.avatar_url = input.avatarUrl;
    if (input.pushNotificationsEnabled !== undefined) updates.push_notifications_enabled = input.pushNotificationsEnabled;
    if (input.emailNotificationsEnabled !== undefined) updates.email_notifications_enabled = input.emailNotificationsEnabled;

    const keys = Object.keys(updates);
    const setClause = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
    const result = await query<ProfileRow>(
      `UPDATE users SET ${setClause}, updated_at = now() WHERE id = $1 RETURNING ${columns}`,
      [request.user?.id, ...keys.map((key) => updates[key])],
    );
    return response.json({ profile: serialize(result.rows[0]) });
  } catch (error) {
    return next(error);
  }
});

const passwordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128).optional(),
  newPassword: z.string().min(8).max(128),
});

// Change password. Accounts that signed up with Google or phone OTP have no password yet,
// so they may set one without a current password. Everyone else must give the current one.
// After a change, every OTHER logged-in device is signed out.
router.post('/password', async (request, response, next) => {
  const parsed = passwordSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(400).json({ error: 'Invalid password details.', issues: parsed.error.issues });
  }
  const { currentPassword, newPassword } = parsed.data;
  try {
    const found = await query<{ password_hash: string | null }>(
      "SELECT password_hash FROM users WHERE id = $1 AND account_status = 'active'",
      [request.user?.id],
    );
    const user = found.rows[0];
    if (!user) return response.status(401).json({ error: 'User account not found.' });

    if (user.password_hash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
        return response.status(400).json({ error: 'Current password is incorrect.' });
      }
      if (await verifyPassword(newPassword, user.password_hash)) {
        return response.status(400).json({ error: 'New password must be different from the current password.' });
      }
    }

    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      request.user?.id,
      await hashPassword(newPassword),
    ]);
    const revoked = await query(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid',
      [request.user?.id, request.user?.sessionId ?? null],
    );
    return response.json({ success: true, otherSessionsLoggedOut: revoked.rowCount ?? 0 });
  } catch (error) {
    return next(error);
  }
});

export { router as profileRouter };