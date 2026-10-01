import { Router } from 'express';
import { z } from 'zod';
import { createToken, hashPassword, requireAuth, verifyPassword } from '../auth.js';
import { query } from '../db.js';
const router = Router();
const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(2).max(100).optional(), phone: z.string().max(30).optional() });
function publicUser(user) {
    return { id: user.id, email: user.email, name: user.name, phone: user.phone };
}
router.post('/register', async (request, response, next) => {
    try {
        const input = credentialsSchema.extend({ name: z.string().min(2).max(100), phone: z.string().max(30).optional() }).parse(request.body);
        const result = await query('INSERT INTO users (name, email, phone, password_hash) VALUES ($1, lower($2), $3, $4) RETURNING id, email, name, phone, password_hash', [input.name, input.email, input.phone ?? null, await hashPassword(input.password)]);
        const user = result.rows[0];
        return response.status(201).json({ user: publicUser(user), token: createToken(publicUser(user)) });
    }
    catch (error) {
        if (error?.code === '23505')
            return response.status(409).json({ error: 'An account with that email already exists' });
        if (error?.name === 'ZodError')
            return response.status(400).json({ error: 'Invalid registration details', issues: error.issues });
        return next(error);
    }
});
router.post('/login', async (request, response, next) => {
    try {
        const input = credentialsSchema.pick({ email: true, password: true }).parse(request.body);
        const result = await query('SELECT id, email, name, phone, password_hash FROM users WHERE email = lower($1)', [input.email]);
        const user = result.rows[0];
        if (!user || !(await verifyPassword(input.password, user.password_hash)))
            return response.status(401).json({ error: 'Invalid email or password' });
        return response.json({ user: publicUser(user), token: createToken(publicUser(user)) });
    }
    catch (error) {
        if (error?.name === 'ZodError')
            return response.status(400).json({ error: 'Invalid login details', issues: error.issues });
        return next(error);
    }
});
router.get('/me', requireAuth, async (request, response, next) => {
    try {
        const result = await query('SELECT id, email, name, phone, password_hash FROM users WHERE id = $1', [request.user?.id]);
        const user = result.rows[0];
        if (!user)
            return response.status(401).json({ error: 'User account not found' });
        return response.json({ user: publicUser(user) });
    }
    catch (error) {
        return next(error);
    }
});
export { router as authRouter };
