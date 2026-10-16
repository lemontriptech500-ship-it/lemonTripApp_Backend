import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
const router = Router();
router.use(requireAuth);
const serviceAliases = {
    flight: 'flights',
    hotel: 'hotels',
    bus: 'bus',
    train: 'trains',
    package: 'packages',
};
const validateSchema = z.object({
    code: z.string().trim().min(1).max(40),
    serviceType: z.string().trim().min(1).max(40),
    orderAmount: z.coerce.number().min(0).max(10000000).optional(),
});
// Validate only: this never redeems or changes a coupon.
router.post('/validate', async (request, response, next) => {
    try {
        const parsed = validateSchema.safeParse(request.body);
        if (!parsed.success)
            return response.status(400).json({ error: 'Coupon code and service type are required.' });
        const { code, serviceType } = parsed.data;
        const subtotalPaise = Math.round((parsed.data.orderAmount ?? 0) * 100);
        const result = await query('SELECT code, discount_type, discount_value, min_order_paise, max_discount_paise, applicable_on ' +
            'FROM coupons WHERE UPPER(code) = UPPER($1) AND active = TRUE AND valid_until >= CURRENT_DATE LIMIT 1', [code]);
        const coupon = result.rows[0];
        if (!coupon)
            return response.status(400).json({ error: 'Invalid or expired coupon code.' });
        const service = serviceAliases[serviceType] ?? serviceType;
        if (!(coupon.applicable_on ?? []).includes(service)) {
            return response.status(400).json({ error: 'This coupon is not applicable on this service.' });
        }
        const minOrderPaise = Number(coupon.min_order_paise ?? 0);
        if (subtotalPaise < minOrderPaise) {
            return response.status(400).json({ error: 'Minimum order amount is INR ' + minOrderPaise / 100 + '.' });
        }
        const discountValue = Number(coupon.discount_value);
        const rawDiscount = coupon.discount_type === 'percentage'
            ? Math.round((subtotalPaise * discountValue) / 100)
            : Math.round(discountValue * 100);
        const cap = coupon.max_discount_paise === null ? Number.POSITIVE_INFINITY : Number(coupon.max_discount_paise);
        const discountPaise = Math.min(rawDiscount, cap, subtotalPaise);
        response.json({
            valid: true,
            code: coupon.code,
            discountType: coupon.discount_type,
            discountValue,
            discountAmount: discountPaise / 100,
        });
    }
    catch (error) {
        next(error);
    }
});
export const couponsRouter = router;
