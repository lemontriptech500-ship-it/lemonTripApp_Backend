import { Router } from 'express';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createAccessToken, createSession, hashOpaqueToken, hashPassword, refreshSessionTtlMs, refreshTokenSecret, requireAuth, verifyPassword } from '../auth.js';
import { normalizePhone, sendSmsOtp, sendVerificationEmail, verifyGoogleIdToken } from '../authProviders.js';
import { env } from '../config.js';
import { pool, query } from '../db.js';
const router = Router();
const windows = new Map();
const platformSchema = z.enum(['app', 'website']).default('app');
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
function rateAllowed(key, limit, periodMs) {
    const now = Date.now();
    const hits = (windows.get(key) ?? []).filter((at) => at > now - periodMs);
    if (hits.length >= limit)
        return false;
    windows.set(key, [...hits, now]);
    return true;
}
function platform(value) {
    const parsed = platformSchema.safeParse(value ?? 'app');
    return parsed.success ? parsed.data : null;
}
function publicUser(user) {
    return { id: user.id, email: user.email, phone: user.phone, name: user.name, firstName: user.first_name, lastName: user.last_name, emailVerified: user.email_verified, phoneVerified: user.phone_verified };
}
function setRefreshCookie(response, token, maxAge = refreshSessionTtlMs) {
    const production = process.env.NODE_ENV === 'production';
    const security = production ? '; Secure; SameSite=None' : '; SameSite=Lax';
    response.append('Set-Cookie', `lemontrip_refresh=${encodeURIComponent(token)}; HttpOnly${security}; Path=/api/auth; Max-Age=${Math.floor(maxAge / 1000)}`);
}
function clearRefreshCookie(response) {
    const production = process.env.NODE_ENV === 'production';
    const security = production ? '; Secure; SameSite=None' : '; SameSite=Lax';
    response.append('Set-Cookie', `lemontrip_refresh=; HttpOnly${security}; Path=/api/auth; Max-Age=0`);
}
function responseWithSession(response, user, clientPlatform, session) {
    if (clientPlatform === 'website')
        setRefreshCookie(response, session.refreshToken);
    return {
        user: publicUser(user), platform: clientPlatform, accessToken: session.accessToken, token: session.accessToken,
        ...(clientPlatform === 'app' ? { refreshToken: session.refreshToken } : {}), expiresIn: 900,
    };
}
function cookieValue(request, name) {
    const cookies = request.headers.cookie?.split(';') ?? [];
    const entry = cookies.find((part) => part.trim().startsWith(`${name}=`));
    if (!entry)
        return undefined;
    try {
        return decodeURIComponent(entry.trim().slice(name.length + 1));
    }
    catch {
        return undefined;
    }
}
function parseName(firstName, lastName, name) {
    const parts = name?.trim().split(/\s+/) ?? [];
    const first = firstName?.trim() || parts.shift() || '';
    const last = lastName?.trim() || parts.join(' ') || null;
    return { firstName: first, lastName: last, name: [first, last].filter(Boolean).join(' ') };
}
async function storeAndSendEmailVerification(user, clientPlatform) {
    if (!user.email)
        return;
    const token = randomBytes(32).toString('base64url');
    await query('UPDATE email_verifications SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL', [user.id]);
    await query("INSERT INTO email_verifications (user_id, platform, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 minutes')", [user.id, clientPlatform, hashOpaqueToken(token)]);
    await sendVerificationEmail(user.email, user.first_name, token);
}
function providerUnavailable(error, provider) {
    return error instanceof Error && error.message === `${provider}_PROVIDER_NOT_CONFIGURED`;
}
const signupSchema = z.object({
    name: z.string().trim().min(2).max(100).optional(),
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().max(80).optional(),
    email: emailSchema,
    phone: z.string().trim().max(40).optional(),
    password: z.string().min(8).max(128),
    platform: platformSchema,
}).refine((value) => Boolean(value.name || value.firstName));
const register = async (request, response, next) => {
    if (!rateAllowed(`signup:${request.ip}`, 8, 3_600_000))
        return response.status(429).json({ error: 'Too many signup attempts. Try again later.' });
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid registration details.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    const names = parseName(parsed.data.firstName, parsed.data.lastName, parsed.data.name);
    let phone = null;
    try {
        phone = parsed.data.phone ? normalizePhone(parsed.data.phone) : null;
    }
    catch {
        return response.status(400).json({ error: 'Enter a valid phone number.' });
    }
    try {
        const created = await query(`INSERT INTO users (name, first_name, last_name, email, phone, password_hash, email_verified, phone_verified, account_status, platform)
       VALUES ($1, $2, $3, $4, $5, $6, false, false, 'pending', $7)
       RETURNING id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status`, [names.name, names.firstName, names.lastName, parsed.data.email, phone, await hashPassword(parsed.data.password), clientPlatform]);
        try {
            await storeAndSendEmailVerification(created.rows[0], clientPlatform);
        }
        catch (error) {
            if (providerUnavailable(error, 'EMAIL'))
                return response.status(503).json({ error: 'Email verification is not configured. Contact support.' });
            return response.status(502).json({ error: 'The verification email could not be sent. Request another email shortly.' });
        }
        return response.status(202).json({ success: true, verificationRequired: true, platform: clientPlatform, message: 'Check your email to verify your LemonTrip account.' });
    }
    catch (error) {
        if (error?.code === '23505')
            return response.status(202).json({ success: true, verificationRequired: true, platform: clientPlatform, message: 'If an account can be created, verification instructions will be sent.' });
        return next(error);
    }
};
router.post(['/signup', '/register'], register);
router.post('/login', async (request, response, next) => {
    if (!rateAllowed(`login:${request.ip}`, 20, 900_000))
        return response.status(429).json({ error: 'Too many login attempts. Try again later.' });
    const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(128), platform: platformSchema }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid login details.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    try {
        const result = await query('SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE lower(email) = $1', [parsed.data.email]);
        const user = result.rows[0];
        if (!user || !user.password_hash || !(await verifyPassword(parsed.data.password, user.password_hash)))
            return response.status(401).json({ error: 'Invalid email or password.' });
        if (user.account_status === 'disabled')
            return response.status(403).json({ error: 'This account is unavailable. Contact support.' });
        if (user.account_status === 'pending')
            return response.status(403).json({ error: 'Verify your email before signing in.' });
        await query('UPDATE users SET platform = $1, updated_at = now() WHERE id = $2', [clientPlatform, user.id]);
        return response.json(responseWithSession(response, user, clientPlatform, await createSession(user, clientPlatform, request)));
    }
    catch (error) {
        return next(error);
    }
});
router.post('/otp/send', async (request, response, next) => {
    const parsed = z.object({
        phone: z.string().trim().min(7).max(40), purpose: z.enum(['signup', 'login']), platform: platformSchema,
        firstName: z.string().trim().min(1).max(80).optional(), lastName: z.string().trim().max(80).optional(), name: z.string().trim().min(2).max(100).optional(),
        email: emailSchema.optional(),
    }).refine((value) => value.purpose !== 'signup' || Boolean(value.firstName || value.name)).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid phone verification request.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    let phone;
    try {
        phone = normalizePhone(parsed.data.phone);
    }
    catch {
        return response.status(400).json({ error: 'Enter a valid phone number.' });
    }
    if (!rateAllowed(`otp-send:${request.ip}:${phone}`, 5, 3_600_000))
        return response.status(429).json({ error: 'Too many code requests. Try again later.' });
    const purpose = parsed.data.purpose === 'signup' ? 'phone_signup' : 'phone_login';
    try {
        const found = await query("SELECT id FROM users WHERE regexp_replace(phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1", [phone]);
        if ((purpose === 'phone_signup' && found.rowCount) || (purpose === 'phone_login' && !found.rowCount))
            return response.status(202).json({ success: true, message: 'If this number can be used, a verification code will be sent.' });
        const recent = await query("SELECT count(*)::int AS count, max(last_sent_at) AS last_sent_at FROM otp_verifications WHERE phone = $1 AND purpose = $2 AND last_sent_at > now() - interval '1 hour'", [phone, purpose]);
        if ((recent.rows[0]?.count ?? 0) >= 3)
            return response.status(429).json({ error: 'Code resend limit reached. Try again later.' });
        if (recent.rows[0]?.last_sent_at && Date.now() - new Date(recent.rows[0].last_sent_at).getTime() < 60_000)
            return response.status(429).json({ error: 'Wait before requesting another code.' });
        await query('UPDATE otp_verifications SET consumed_at = now() WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL', [phone, purpose]);
        const code = String(randomInt(100_000, 1_000_000));
        const codeHash = createHmac('sha256', refreshTokenSecret).update(`${phone}:${purpose}:${code}`).digest('hex');
        const names = parseName(parsed.data.firstName, parsed.data.lastName, parsed.data.name);
        const signupData = purpose === 'phone_signup' ? { ...names, email: parsed.data.email ?? null } : null;
        await query("INSERT INTO otp_verifications (phone, purpose, platform, code_hash, signup_data, expires_at) VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')", [phone, purpose, clientPlatform, codeHash, signupData]);
        try {
            await sendSmsOtp(phone, code);
        }
        catch (error) {
            await query('UPDATE otp_verifications SET consumed_at = now() WHERE phone = $1 AND purpose = $2 AND platform = $3 AND code_hash = $4', [phone, purpose, clientPlatform, codeHash]);
            if (providerUnavailable(error, 'OTP'))
                return response.status(503).json({ error: 'Phone verification is not configured. Contact support.' });
            return response.status(502).json({ error: 'The verification message could not be sent. Try again later.' });
        }
        return response.status(202).json({ success: true, message: 'If this number can be used, a verification code will be sent.' });
    }
    catch (error) {
        return next(error);
    }
});
router.post('/otp/verify', async (request, response, next) => {
    const parsed = z.object({ phone: z.string().min(7).max(40), code: z.string().regex(/^\d{6}$/), purpose: z.enum(['signup', 'login']), platform: platformSchema }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid verification code.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    let phone;
    try {
        phone = normalizePhone(parsed.data.phone);
    }
    catch {
        return response.status(400).json({ error: 'Invalid verification request.' });
    }
    if (!rateAllowed(`otp-verify:${request.ip}:${phone}`, 10, 3_600_000))
        return response.status(429).json({ error: 'Too many verification attempts. Try again later.' });
    const purpose = parsed.data.purpose === 'signup' ? 'phone_signup' : 'phone_login';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query('SELECT id, code_hash, signup_data, attempts, expires_at FROM otp_verifications WHERE phone = $1 AND purpose = $2 AND platform = $3 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [phone, purpose, clientPlatform]);
        const challenge = result.rows[0];
        if (!challenge) {
            await client.query('ROLLBACK');
            return response.status(400).json({ error: 'The code is invalid or expired. Request a new code.' });
        }
        if (new Date(challenge.expires_at).getTime() <= Date.now()) {
            await client.query('UPDATE otp_verifications SET consumed_at = now() WHERE id = $1', [challenge.id]);
            await client.query('COMMIT');
            return response.status(400).json({ error: 'The code has expired. Request a new code.' });
        }
        if (challenge.attempts >= 5) {
            await client.query('UPDATE otp_verifications SET consumed_at = now() WHERE id = $1', [challenge.id]);
            await client.query('COMMIT');
            return response.status(429).json({ error: 'Too many incorrect codes. Request a new code.' });
        }
        await client.query('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = $1', [challenge.id]);
        const supplied = createHmac('sha256', refreshTokenSecret).update(`${phone}:${purpose}:${parsed.data.code}`).digest();
        const expected = Buffer.from(challenge.code_hash, 'hex');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            await client.query('COMMIT');
            return response.status(400).json({ error: 'The code is incorrect.' });
        }
        await client.query('UPDATE otp_verifications SET consumed_at = now() WHERE id = $1', [challenge.id]);
        let user;
        if (purpose === 'phone_signup') {
            const data = challenge.signup_data;
            if (!data || typeof data.firstName !== 'string' || typeof data.name !== 'string') {
                await client.query('ROLLBACK');
                return response.status(400).json({ error: 'This signup could not be completed. Start again.' });
            }
            const inserted = await client.query(`INSERT INTO users (name, first_name, last_name, email, phone, password_hash, email_verified, phone_verified, account_status, platform)
         VALUES ($1, $2, $3, $4, $5, $6, false, true, 'active', $7)
         RETURNING id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status`, [data.name, data.firstName, data.lastName ?? null, data.email ?? null, phone, null, clientPlatform]);
            user = inserted.rows[0];
        }
        else {
            const found = await client.query("SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE regexp_replace(phone, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') AND account_status = 'active'", [phone]);
            user = found.rows[0];
            if (!user) {
                await client.query('ROLLBACK');
                return response.status(400).json({ error: 'The code is invalid or expired. Request a new code.' });
            }
            await client.query('UPDATE users SET phone_verified = true, platform = $1, updated_at = now() WHERE id = $2', [clientPlatform, user.id]);
            user.phone_verified = true;
        }
        await client.query('COMMIT');
        return response.json(responseWithSession(response, user, clientPlatform, await createSession(user, clientPlatform, request)));
    }
    catch (error) {
        await client.query('ROLLBACK');
        if (error?.code === '23505')
            return response.status(409).json({ error: 'An account with those details already exists.' });
        return next(error);
    }
    finally {
        client.release();
    }
});
const verifyEmail = async (request, response, next) => {
    const token = typeof request.query.token === 'string' ? request.query.token : request.body?.token;
    if (typeof token !== 'string' || token.length < 32 || token.length > 200)
        return response.status(400).json({ error: 'Invalid or expired verification link.' });
    try {
        const result = await query(`WITH consumed AS (
         UPDATE email_verifications SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id
       )
       UPDATE users SET email_verified = true, account_status = 'active', updated_at = now() FROM consumed
       WHERE users.id = consumed.user_id
       RETURNING users.id, users.email, users.name, users.first_name, users.last_name, users.phone, users.password_hash, users.email_verified, users.phone_verified, users.account_status`, [hashOpaqueToken(token)]);
        if (!result.rowCount)
            return response.status(400).json({ error: 'Invalid or expired verification link.' });
        return response.json({ success: true, user: publicUser(result.rows[0]), message: 'Email verified. You can now sign in.' });
    }
    catch (error) {
        return next(error);
    }
};
router.post('/email/verify', verifyEmail);
router.get('/email/verify', verifyEmail);
router.post('/email/send', async (request, response, next) => {
    const parsed = z.object({ email: emailSchema, platform: platformSchema }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid email address.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    if (!rateAllowed(`email-send:${request.ip}`, 5, 3_600_000))
        return response.status(429).json({ error: 'Too many verification requests. Try again later.' });
    try {
        const found = await query('SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE lower(email) = $1', [parsed.data.email]);
        if (found.rows[0] && !found.rows[0].email_verified) {
            try {
                await storeAndSendEmailVerification(found.rows[0], clientPlatform);
            }
            catch (error) {
                if (providerUnavailable(error, 'EMAIL'))
                    return response.status(503).json({ error: 'Email verification is temporarily unavailable.' });
                return response.status(502).json({ error: 'The verification email could not be sent. Try again later.' });
            }
        }
        return response.json({ success: true, message: 'If the account needs verification, an email will be sent.' });
    }
    catch (error) {
        return next(error);
    }
});
router.post('/google', async (request, response, next) => {
    const parsed = z.object({ idToken: z.string().min(20).max(10_000), platform: platformSchema }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid Google sign-in request.' });
    const clientPlatform = platform(parsed.data.platform);
    if (!clientPlatform)
        return response.status(400).json({ error: 'Platform must be app or website.' });
    if (!rateAllowed(`google:${request.ip}`, 20, 900_000))
        return response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
    try {
        const identity = await verifyGoogleIdToken(parsed.data.idToken);
        let user = (await query(`SELECT users.id, users.email, users.name, users.first_name, users.last_name, users.phone, users.password_hash, users.email_verified, users.phone_verified, users.account_status
       FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id WHERE oauth_accounts.provider = 'google' AND oauth_accounts.provider_user_id = $1`, [identity.providerUserId])).rows[0];
        if (!user) {
            user = (await query('SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE lower(email) = $1', [identity.email])).rows[0];
            if (user && !user.email_verified) {
                const verified = await query(`UPDATE users SET email_verified = true, account_status = 'active', updated_at = now()
           WHERE id = $1
           RETURNING id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status`, [user.id]);
                user = verified.rows[0];
            }
            if (!user) {
                user = (await query(`INSERT INTO users (name, first_name, last_name, email, password_hash, email_verified, account_status, platform)
           VALUES ($1, $2, $3, $4, NULL, true, 'active', $5)
           RETURNING id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status`, [identity.name, identity.firstName, identity.lastName, identity.email, clientPlatform])).rows[0];
            }
            await query("INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, linked_from_platform) VALUES ($1, 'google', $2, $3, $4) ON CONFLICT (provider, provider_user_id) DO NOTHING", [user.id, identity.providerUserId, identity.email, clientPlatform]);
        }
        if (user.account_status !== 'active')
            return response.status(403).json({ error: 'This account is unavailable. Verify your email or contact support.' });
        await query('UPDATE users SET platform = $1, updated_at = now() WHERE id = $2', [clientPlatform, user.id]);
        return response.json(responseWithSession(response, user, clientPlatform, await createSession(user, clientPlatform, request)));
    }
    catch (error) {
        if (error instanceof Error && error.message === 'GOOGLE_PROVIDER_NOT_CONFIGURED')
            return response.status(503).json({ error: 'Google sign-in is not configured.' });
        if (error instanceof Error && error.message === 'GOOGLE_IDENTITY_NOT_VERIFIED')
            return response.status(401).json({ error: 'Google could not verify this account.' });
        if (error instanceof Error && /Token used too late|Wrong recipient|Invalid token|No pem found/i.test(error.message))
            return response.status(401).json({ error: 'Google sign-in token is invalid or expired.' });
        return next(error);
    }
});
router.post('/refresh', async (request, response, next) => {
    const parsed = z.object({ refreshToken: z.string().min(40).max(200).optional(), platform: z.enum(['app', 'website']).optional() }).safeParse(request.body);
    if (!parsed.success)
        return response.status(400).json({ error: 'Invalid refresh request.' });
    const cookieToken = cookieValue(request, 'lemontrip_refresh');
    if (cookieToken) {
        const origin = request.get('origin');
        const allowedOrigins = env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
        if (!origin || !allowedOrigins.includes(origin))
            return response.status(403).json({ error: 'Refresh request origin is not allowed.' });
    }
    const presentedToken = parsed.data.refreshToken ?? cookieToken;
    if (!presentedToken)
        return response.status(400).json({ error: 'Invalid refresh request.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const found = await client.query(`SELECT sessions.id, sessions.user_id, sessions.platform, sessions.expires_at, users.account_status
       FROM user_sessions sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.refresh_token_hash = $1 AND sessions.revoked_at IS NULL FOR UPDATE OF sessions`, [hashOpaqueToken(presentedToken)]);
        const session = found.rows[0];
        if (!session || new Date(session.expires_at).getTime() <= Date.now() || session.account_status !== 'active' || (parsed.data.platform && parsed.data.platform !== session.platform)) {
            await client.query('ROLLBACK');
            return response.status(401).json({ error: 'Refresh token is invalid, expired, or revoked.' });
        }
        const refreshToken = randomBytes(48).toString('base64url');
        await client.query("UPDATE user_sessions SET refresh_token_hash = $1, last_used_at = now(), expires_at = now() + $2 * interval '1 millisecond' WHERE id = $3", [hashOpaqueToken(refreshToken), refreshSessionTtlMs, session.id]);
        const user = await client.query('SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE id = $1', [session.user_id]);
        await client.query('COMMIT');
        if (session.platform === 'website')
            setRefreshCookie(response, refreshToken);
        return response.json({ user: publicUser(user.rows[0]), platform: session.platform, accessToken: createAccessToken(session.user_id, session.id, session.platform), ...(session.platform === 'app' ? { refreshToken } : {}), expiresIn: 900 });
    }
    catch (error) {
        await client.query('ROLLBACK');
        return next(error);
    }
    finally {
        client.release();
    }
});
router.post('/logout', requireAuth, async (request, response, next) => {
    try {
        if (request.user?.sessionId)
            await query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [request.user.sessionId, request.user.id]);
        if (request.user?.platform === 'website')
            clearRefreshCookie(response);
        return response.status(204).end();
    }
    catch (error) {
        return next(error);
    }
});
router.post('/logout-all', requireAuth, async (request, response, next) => {
    try {
        await query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [request.user?.id]);
        if (request.user?.platform === 'website')
            clearRefreshCookie(response);
        return response.json({ success: true });
    }
    catch (error) {
        return next(error);
    }
});
router.get('/me', requireAuth, async (request, response, next) => {
    try {
        const result = await query('SELECT id, email, name, first_name, last_name, phone, password_hash, email_verified, phone_verified, account_status FROM users WHERE id = $1', [request.user?.id]);
        const user = result.rows[0];
        if (!user)
            return response.status(401).json({ error: 'User account not found.' });
        return response.json({ user: publicUser(user), platform: request.user?.platform ?? 'app' });
    }
    catch (error) {
        return next(error);
    }
});
export { router as authRouter };
