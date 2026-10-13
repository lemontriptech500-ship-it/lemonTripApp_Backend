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
        "SELECT id, category, title, excerpt, content, image_url, published_at, read_time FROM blog_posts WHERE publication_status = 'published' ORDER BY published_at DESC NULLS LAST, created_at DESC",
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
        short_description: string | null;
        location: string | null;
        best_for: string | null;
        itinerary: { day: string; title: string; description: string }[] | null;
        inclusions: string[] | null;
        exclusions: string[] | null;
        accommodation_details: string | null;
        meal_plan: string | null;
        transport_details: string | null;
        notes: string[] | null;
        gallery: string[] | null;
        available_dates: string[] | null;
        cancellation_policy: string | null;
        terms_and_conditions: string | null;
      }>(
        'SELECT id, destination, duration, description, starting_price, highlights, image_url, category, short_description, location, best_for, itinerary, inclusions, exclusions, accommodation_details, meal_plan, transport_details, notes, gallery, available_dates, cancellation_policy, terms_and_conditions FROM travel_packages ORDER BY created_at DESC, id',
      );
      return response.json({ items: result.rows.map((row) => ({
        id: row.id,
        title: row.destination,
        image: row.image_url ?? '',
        duration: row.duration,
        description: row.short_description || row.description,
        price: row.starting_price.replace(/^from\s+/i, '').replace(/\s*\(sample\)/i, ''),
        highlights: (row.highlights ?? []).map((highlight) => highlight.replace(/^[\s"']+|[\s"',]+$/g, '')).filter(Boolean),
        destination: row.destination,
        ...(row.gallery?.length ? { gallery: [row.image_url, ...row.gallery].filter(Boolean) } : {}),
        ...(row.itinerary?.length ? { itinerary: row.itinerary } : {}),
        ...(row.inclusions?.length ? { inclusions: row.inclusions } : {}),
        ...(row.exclusions?.length ? { exclusions: row.exclusions } : {}),
        ...(row.accommodation_details ? { hotels: [row.accommodation_details] } : {}),
        ...(row.meal_plan ? { meals: [row.meal_plan] } : {}),
        ...(row.transport_details ? { transfers: [row.transport_details] } : {}),
        ...(row.notes?.length ? { terms: row.notes.join(' ') } : {}),
        ...(row.cancellation_policy ? { cancellation: row.cancellation_policy } : {}),
        ...(row.terms_and_conditions ? { terms: [row.notes?.join(' '), row.terms_and_conditions].filter(Boolean).join(' ') } : {}),
        ...(row.available_dates?.length ? { availableDates: row.available_dates } : {}),
        ...(row.location ? { location: row.location } : {}),
        ...(row.best_for ? { bestFor: row.best_for } : {}),
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
        id: row.id,
        code: row.id,
        name: row.country,
        image: row.image_url ?? '',
        visaType: row.visa_type,
        processing: row.processing_time ?? '',
        ...(row.starting_from ? { fee: row.starting_from.replace(/^from\s+/i, '') } : {}),
        ...(row.documents?.length ? { documents: row.documents } : {}),
      })) });
    }

    const result = await query<{ data: Record<string, unknown> }>(
      'SELECT data FROM content_items WHERE content_type = $1 AND active = true ORDER BY id', [type],
    );
    return response.json({ items: result.rows.map((row) => row.data) });
  } catch (error) {
    if (type === 'blog' && isMissingBlogPublicationSchema(error)) {
      return response.status(503).json({
        error: 'Blog publication schema is unavailable. Apply the reviewed blog publication migration before serving public blog content.',
      });
    }
    return next(error);
  }
});

function isMissingBlogPublicationSchema(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = error.code;
  return code === '42703' || code === '42P01';
}

export { router as contentRouter };
