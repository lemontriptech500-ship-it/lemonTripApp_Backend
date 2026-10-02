import { Router } from 'express';
import { query } from '../db.js';

const router = Router();
const contentTypes = ['package', 'blog', 'visa'] as const;
type ContentType = typeof contentTypes[number];

router.get('/:type', async (request, response, next) => {
  const type = request.params.type as ContentType;
  if (!contentTypes.includes(type)) return response.status(404).json({ error: 'Content type not found' });
  try {
    const result = await query<{ data: Record<string, unknown> }>(
      'SELECT data FROM content_items WHERE content_type = $1 AND active = true ORDER BY id', [type],
    );
    return response.json({ items: result.rows.map((row) => row.data) });
  } catch (error) {
    return next(error);
  }
});

export { router as contentRouter };
