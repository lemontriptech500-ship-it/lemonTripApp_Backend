import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, RequestHandler } from 'express';
import { env } from './config.js';

export type AuthUser = { id: string; email: string; name: string; phone: string | null };

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

export function getBearerToken(request: Request) {
  const header = request.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export const requireAuth: RequestHandler = (request, response, next) => {
  const token = getBearerToken(request);
  if (!token) return response.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload === 'string' || !payload.sub) return response.status(401).json({ error: 'Invalid token' });
    request.user = { id: payload.sub, email: '', name: '', phone: null };
    return next();
  } catch {
    return response.status(401).json({ error: 'Invalid or expired token' });
  }
};
