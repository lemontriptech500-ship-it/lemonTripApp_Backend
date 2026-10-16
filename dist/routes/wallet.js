import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
const router = Router();
router.use(requireAuth);
// Read-only: does not create a wallet row. A user without a wallet sees a zero balance.
router.get('/', async (request, response, next) => {
    try {
        const result = await query('SELECT balance_paise, currency, status FROM wallets WHERE user_id = $1', [request.user.id]);
        const row = result.rows[0];
        response.json({
            balance: row ? Number(row.balance_paise) / 100 : 0,
            currency: row?.currency ?? 'INR',
            status: row?.status ?? 'ACTIVE',
        });
    }
    catch (error) {
        next(error);
    }
});
router.get('/transactions', async (request, response, next) => {
    try {
        const page = Math.max(1, Number.parseInt(String(request.query.page), 10) || 1);
        const limit = Math.min(50, Math.max(1, Number.parseInt(String(request.query.limit), 10) || 20));
        const offset = (page - 1) * limit;
        const userId = request.user.id;
        const values = [userId];
        let typeFilter = '';
        if (request.query.type === 'CREDIT' || request.query.type === 'DEBIT') {
            values.push(request.query.type);
            typeFilter = ' AND type = $2';
        }
        const count = await query('SELECT COUNT(*)::int AS total FROM wallet_transactions WHERE user_id = $1' + typeFilter, values);
        values.push(limit, offset);
        const result = await query('SELECT id, transaction_reference, type, source, amount_paise, status, description, booking_reference, created_at AS date ' +
            'FROM wallet_transactions WHERE user_id = $1' + typeFilter +
            ' ORDER BY created_at DESC LIMIT $' + (values.length - 1) + ' OFFSET $' + values.length, values);
        response.json({
            transactions: result.rows.map((row) => ({
                id: row.id,
                reference: row.transaction_reference,
                type: row.type,
                source: row.source,
                description: row.description ?? '',
                amount: Number(row.amount_paise) / 100,
                status: row.status,
                bookingReference: row.booking_reference,
                date: row.date,
            })),
            page,
            limit,
            total: count.rows[0].total,
        });
    }
    catch (error) {
        next(error);
    }
});
export const walletRouter = router;
