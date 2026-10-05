import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, RequestHandler } from 'express';
import { env } from './config.js';
import { query } from './db.js';

export type Platform = 'app' | 'website';
export type AuthUser = { id: string; email: string | null; name: string; phone: string | null; platform?: Platform; sessionId?: string };
type SessionUser = Pick<AuthUser, 'id'>;

const refreshSecret = env.JWT_REFRESH_SECRET ?? createHmac('sha256', env.JWT_SECRET).update('lemontrip-refresh-v1').digest('hex');
const accessTokenTtlSeconds = 15 * 60;
const refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function createToken(user: AuthUser) {
  return jwt.sign({ sub: user.id }, env.JWT_SECRET, { expiresIn: '7d' });
}

export function hashOpaqueToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(user: SessionUser, platform: Platform, request: Request) {
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + refreshTokenTtlMs);
  const result = await query<{ id: string }>(
    'INSERT INTO user_sessions (user_id, platform, refresh_token_hash, device_id, device_name, user_agent, ip_address, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [user.id, platform, hashOpaqueToken(refreshToken), request.get('x-device-id')?.slice(0, 200) ?? null, request.get('x-device-name')?.slice(0, 200) ?? null, request.get('user-agent')?.slice(0, 500) ?? null, request.ip || null, expiresAt],
  );
  const sessionId = result.rows[0].id;
  const accessToken = jwt.sign({ sub: user.id, sid: sessionId, platform }, env.JWT_SECRET, { expiresIn: accessTokenTtlSeconds });
  return { accessToken, refreshToken, sessionId, expiresAt };
}

export function createAccessToken(userId: string, sessionId: string, platform: Platform) {
  return jwt.sign({ sub: userId, sid: sessionId, platform }, env.JWT_SECRET, { expiresIn: accessTokenTtlSeconds });
}

export const refreshSessionTtlMs = refreshTokenTtlMs;
export const refreshTokenSecret = refreshSecret;

export function getBearerToken(request: Request) {
  const header = request.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export const requireAuth: RequestHandler = (request, response, next) => {
  const token = getBearerToken(request);
  if (!token) return response.status(401).json({ error: 'Authentication required' });

  try {
    const verified = jwt.verify(token, env.JWT_SECRET);
    if (typeof verified === 'string') return response.status(401).json({ error: 'Invalid token' });
    const payload = verified;
    // The website backend's legacy JWTs use `id`; the mobile auth service uses
    // the standard `sub` claim. Both identify the same UUID in the shared DB.
    const userId = typeof payload.sub === 'string' ? payload.sub : payload.id;
    if (typeof userId !== 'string') return response.status(401).json({ error: 'Invalid token' });
    const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
    const platform = payload.platform === 'app' || payload.platform === 'website' ? payload.platform : undefined;
    if (sessionId && !platform) return response.status(401).json({ error: 'Invalid token' });
    const continueRequest = async () => {
      if (sessionId) {
        const session = await query<{ id: string }>('SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [sessionId, userId]);
        if (!session.rowCount) return response.status(401).json({ error: 'Session expired or revoked' });
      }
      request.user = { id: userId, email: typeof payload.email === 'string' ? payload.email : null, name: '', phone: null, platform, sessionId };
      return next();
    };
    void continueRequest().catch(next);
    return;
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const optionalAuth: RequestHandler = (request, _response, next) => {
  const token = getBearerToken(request);
  if (!token) return next();

  try {
    const verified = jwt.verify(token, env.JWT_SECRET);
    if (typeof verified === 'string') return next();
    const payload = verified;
    const userId = typeof payload.sub === 'string' ? payload.sub : payload.id;
    if (typeof userId === 'string') {
      const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
      const platform = payload.platform === 'app' || payload.platform === 'website' ? payload.platform : undefined;
      const continueRequest = async () => {
        if (sessionId) {
          const session = await query<{ id: string }>('SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()', [sessionId, userId]);
          if (!session.rowCount) return next();
        }
        request.user = { id: userId, email: typeof payload.email === 'string' ? payload.email : null, name: '', phone: null, platform, sessionId };
        return next();
      };
      void continueRequest().catch(next);
      return;
    }
  } catch {
    // Anonymous context is safer than trusting an invalid token.
  }
  return next();
};
