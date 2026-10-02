import { Router } from 'express';
import { query } from '../db.js';

const router = Router();
const contentTypes = ['package', 'blog', 'visa', 'service', 'destination', 'listing', 'hotel'] as const;
type ContentType = typeof contentTypes[number];

router.get('/:type', async (request, response, next) => {
  const type = request.params.type as ContentType;
  if (!contentTypes.includes(type)) return response.status(404).json({ error: 'Content type not found' });
  try {
    if (type === 'blog') {
      const result = await query<{
        id: string;
        category: string;
        title: string;
        excerpt: string;
        content: string;
        image_url: string | null;
        published_at: string | Date | null;
        read_time: string | null;
      }>(
        'SELECT id, category, title, excerpt, content, image_url, published_at, read_time FROM blog_posts ORDER BY published_at DESC NULLS LAST, created_at DESC',
      );
      return response.json({ items: result.rows.map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        excerpt: row.excerpt,
        image: row.image_url ?? '',
        readingTime: row.read_time ?? '',
        date: row.published_at ? new Date(row.published_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '',
        content: row.content.split(/\r?\n\s*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean),
      })) });
    }

    if (type === 'package') {
      const result = await query<{
        id: string;
        destination: string;
        duration: string;
        description: string;
        starting_price: string;
        highlights: string[] | null;
        image_url: string | null;
        category: string | null;
      }>(
        'SELECT id, destination, duration, description, starting_price, highlights, image_url, category FROM travel_packages ORDER BY created_at DESC, id',
      );
      return response.json({ items: result.rows.map((row) => ({
        id: row.id,
        title: row.destination,
        image: row.image_url ?? '',
        duration: row.duration,
        description: row.description,
        price: row.starting_price.replace(/^from\s+/i, '').replace(/\s*\(sample\)/i, ''),
        highlights: (row.highlights ?? []).map((highlight) => highlight.replace(/^[\s"']+|[\s"',]+$/g, '')).filter(Boolean),
        destination: row.destination,
        categories: row.category ? [row.category.toLowerCase() === 'international' ? 'International' : 'Domestic'] : [],
      })) });
    }

    if (type === 'visa') {
      const result = await query<{
        id: string;
        country: string;
        visa_type: string;
        processing_time: string | null;
        starting_from: string | null;
        image_url: string | null;
        documents: string[] | null;
      }>(
        'SELECT id, country, visa_type, processing_time, starting_from, image_url, documents FROM visa_services ORDER BY country, visa_type',
      );
      return response.json({ items: result.rows.map((row) => ({
        code: row.id,
        name: row.country,
        image: row.image_url ?? '',
        visaTypes: [row.visa_type],
        processing: row.processing_time ?? '',
        ...(row.starting_from ? { fee: row.starting_from } : {}),
        ...(row.documents?.length ? { documents: row.documents } : {}),
      })) });
    }

    const result = await query<{ data: Record<string, unknown> }>(
      'SELECT data FROM content_items WHERE content_type = $1 AND active = true ORDER BY id', [type],
    );
    return response.json({ items: result.rows.map((row) => row.data) });
  } catch (error) {
    return next(error);
  }
});

export { router as contentRouter };
