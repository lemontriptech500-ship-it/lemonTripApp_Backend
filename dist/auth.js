import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from './config.js';
export function hashPassword(password) {
    return bcrypt.hash(password, 12);
}
export function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function createToken(user) {
    return jwt.sign({ sub: user.id }, env.JWT_SECRET, { expiresIn: '7d' });
}
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
        if (typeof payload === 'string' || !payload.sub)
            return response.status(401).json({ error: 'Invalid token' });
        request.user = { id: payload.sub, email: '', name: '', phone: null };
        return next();
    }
    catch {
        return response.status(401).json({ error: 'Invalid or expired token' });
    }
};
