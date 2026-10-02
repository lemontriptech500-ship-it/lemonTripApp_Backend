import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from './config.js';
import { query } from './db.js';
const refreshSecret = env.JWT_REFRESH_SECRET ?? createHmac('sha256', env.JWT_SECRET).update('lemontrip-refresh-v1').digest('hex');
const accessTokenTtlSeconds = 15 * 60;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;
export function hashPassword(password) {
    return bcrypt.hash(password, 12);
}
export function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function createToken(user) {
    return jwt.sign({ sub: user.id }, env.JWT_SECRET, { expiresIn: '7d' });
}
export function hashOpaqueToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
export async function createSession(user, platform, request) {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + refreshTokenTtlMs);
    const result = await query('INSERT INTO user_sessions (user_id, platform, refresh_token_hash, device_id, device_name, user_agent, ip_address, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [user.id, platform, hashOpaqueToken(refreshToken), request.get('x-device-id')?.slice(0, 200) ?? null, request.get('x-device-name')?.slice(0, 200) ?? null, request.get('user-agent')?.slice(0, 500) ?? null, request.ip || null, expiresAt]);
    const sessionId = result.rows[0].id;
    const accessToken = jwt.sign({ sub: user.id, sid: sessionId, platform }, env.JWT_SECRET, { expiresIn: accessTokenTtlSeconds });
    return { accessToken, refreshToken, sessionId, expiresAt };
}
export function createAccessToken(userId, sessionId, platform) {
    return jwt.sign({ sub: userId, sid: sessionId, platform }, env.JWT_SECRET, { expiresIn: accessTokenTtlSeconds });
}
export const refreshSessionTtlMs = refreshTokenTtlMs;
export const refreshTokenSecret = refreshSecret;
export function getBearerToken(request) {
    const header = request.header('authorization');
    return header?.startsWith('Bearer ') ? header.slice(7) : null;
}
export const requireAuth = (request, response, next) => {
    const token = getBearerToken(request);
    if (!token)
        return response.status(401).json({ error: 'Authentication required' });
    try {
        const payload = jwt.verify(token, env.JWT_SECRET);
        if (typeof payload === 'string' || typeof payload.sub !== 'string')
            return response.status(401).json({ error: 'Invalid token' });
        const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
        const platform = payload.platform === 'app' || payload.platform === 'website' ? payload.platform : undefined;
        if (sessionId && !platform)
            return response.status(401).json({ error: 'Invalid token' });
        const continueRequest = async () => {
            if (sessionId) {
                const session = await query('SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [sessionId, payload.sub]);
                if (!session.rowCount)
                    return response.status(401).json({ error: 'Session expired or revoked' });
            }
            request.user = { id: payload.sub, email: null, name: '', phone: null, platform, sessionId };
            return next();
        };
        void continueRequest().catch(next);
        return;
    }
    catch {
        return response.status(401).json({ error: 'Invalid or expired token' });
    }
};
export const optionalAuth = (request, _response, next) => {
    const token = getBearerToken(request);
    if (!token)
        return next();
    try {
        const payload = jwt.verify(token, env.JWT_SECRET);
        if (typeof payload !== 'string' && typeof payload.sub === 'string') {
            const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
            const platform = payload.platform === 'app' || payload.platform === 'website' ? payload.platform : undefined;
            const continueRequest = async () => {
                if (sessionId) {
                    const session = await query('SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [sessionId, payload.sub]);
                    if (!session.rowCount)
                        return next();
                }
                request.user = { id: payload.sub, email: null, name: '', phone: null, platform, sessionId };
                return next();
            };
            void continueRequest().catch(next);
            return;
        }
    }
    catch {
        // Anonymous context is safer than trusting an invalid token.
    }
    return next();
};
