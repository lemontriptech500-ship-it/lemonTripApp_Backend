import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { HttpError, s3Client, uploadVisaDocuments, visaBucket, visaErrorHandler } from '../visaUpload.js';
import type { UploadedVisaFile } from '../visaUpload.js';

const router = Router();

const serviceFields = `
  id, country,
  visa_type AS "visaType",
  processing_time AS "processingTime",
  starting_from AS "startingFrom",
  image_url AS "imageUrl",
  documents
`;

function parseJsonField(value: unknown): Record<string, any> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function idempotencyKeyOf(request: Request) {
  return String(request.get('Idempotency-Key') ?? '').trim().slice(0, 120);
}

router.get('/services', async (request, response, next) => {
  try {
    const country = String(request.query.country ?? '').toLowerCase();
    const visaType = String(request.query.visaType ?? '').toLowerCase();
    const filters: string[] = [];
    const values: unknown[] = [];
    if (country) {
      values.push(`%${country}%`);
      filters.push(`LOWER(country) LIKE $${values.length}`);
    }
    if (visaType) {
      values.push(`%${visaType}%`);
      filters.push(`LOWER(visa_type) LIKE $${values.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await query(`SELECT ${serviceFields} FROM visa_services ${where} ORDER BY country`, values);
    return response.json({ success: true, data: { services: result.rows, total: result.rowCount } });
  } catch (error) {
    return next(error);
  }
});

router.get('/services/:serviceId', async (request, response, next) => {
  try {
    const result = await query(`SELECT ${serviceFields} FROM visa_services WHERE id = $1 LIMIT 1`, [request.params.serviceId]);
    if (!result.rows[0]) return response.status(404).json({ success: false, error: { message: 'Visa service not found' } });
    return response.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

// Runs before the upload so a retried submit never re-uploads files.
const replayDuplicateApplication: RequestHandler = async (request, response, next) => {
  try {
    const key = idempotencyKeyOf(request);
    if (!key || !request.user?.id) return next();
    const existing = await query<{ id: string; status: string }>(
      'SELECT id, status FROM visa_applications WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1',
      [request.user.id, key],
    );
    if (!existing.rows[0]) return next();
    return response.status(200).json({ success: true, data: { applicationId: existing.rows[0].id, status: existing.rows[0].status } });
  } catch (error) {
    return next(error);
  }
};

const createApplication: RequestHandler = async (request, response, next) => {
  try {
    const serviceId = request.body?.serviceId;
    const personalDetails = parseJsonField(request.body?.personalDetails);
    const passportDetails = parseJsonField(request.body?.passportDetails);
    const travelDetails = parseJsonField(request.body?.travelDetails);

    if (!serviceId || !personalDetails || !passportDetails || !travelDetails) {
      return response.status(400).json({ success: false, error: { message: 'Visa service and application details are required' } });
    }

    const service = await query('SELECT id FROM visa_services WHERE id = $1', [serviceId]);
    if (!service.rows[0]) {
      return response.status(404).json({ success: false, error: { message: 'Visa service not found' } });
    }

    const rawDob = personalDetails.dateOfBirth;
    let dateOfBirth: string | null = null;
    if (rawDob) {
      const text = String(rawDob);
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text || parsed.getTime() > Date.now()) {
        return response.status(400).json({ success: false, error: { message: 'Date of birth must be a valid date in YYYY-MM-DD format' } });
      }
      dateOfBirth = text;
    }

    const idempotencyKey = idempotencyKeyOf(request) || null;
    const files = (request.files ?? {}) as Record<string, UploadedVisaFile[]>;
    const applicationId = `LT-VISA-${Date.now().toString(36).toUpperCase()}`;
    const userId = request.user?.id ?? null;

    const inserted = await query(
      `INSERT INTO visa_applications (
        id, service_id, user_id, full_name, email, passport_number,
        intended_entry_date, passport_front_path, passport_back_path, photograph_path, status, date_of_birth, idempotency_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitted',$11,$12)
      ON CONFLICT DO NOTHING`,
      [
        applicationId, serviceId, userId,
        personalDetails.fullName, personalDetails.email, passportDetails.passportNumber,
        travelDetails.intendedEntryDate || null,
        files.passportFront?.[0]?.location ?? null,
        files.passportBack?.[0]?.location ?? null,
        files.photograph?.[0]?.location ?? null,
        dateOfBirth,
        idempotencyKey,
      ],
    );

    if (!inserted.rowCount && idempotencyKey) {
      const existing = await query<{ id: string; status: string }>(
        'SELECT id, status FROM visa_applications WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1',
        [userId, idempotencyKey],
      );
      if (existing.rows[0]) {
        return response.status(200).json({ success: true, data: { applicationId: existing.rows[0].id, status: existing.rows[0].status } });
      }
    }

    return response.status(201).json({ success: true, data: { applicationId, status: 'submitted' } });
  } catch (error) {
    return next(error);
  }
};

router.post('/applications', requireAuth, replayDuplicateApplication, uploadVisaDocuments, createApplication);

router.get('/applications', requireAuth, async (request, response, next) => {
  try {
    const userId = request.user!.id;
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(request.query.offset), 10) || 0);
    type Row = {
      id: string; country: string; visaType: string; status: string; submittedAt: Date;
      passport_front_path: string | null; passport_back_path: string | null; photograph_path: string | null;
    };
    const [items, count] = await Promise.all([
      query<Row>(
        `SELECT a.id, s.country, s.visa_type AS "visaType", a.status,
                a.submitted_at AS "submittedAt", a.passport_front_path,
                a.passport_back_path, a.photograph_path
         FROM visa_applications a JOIN visa_services s ON s.id = a.service_id
         WHERE a.user_id = $1 ORDER BY a.submitted_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      query<{ total: number }>('SELECT count(*)::int AS total FROM visa_applications WHERE user_id = $1', [userId]),
    ]);
    const total = count.rows[0]?.total ?? 0;
    return response.json({
      items: items.rows.map((row) => ({
        id: row.id, referenceId: row.id, country: row.country, visaType: row.visaType,
        status: row.status, createdAt: new Date(row.submittedAt).toISOString(),
        documents: {
          passportFront: Boolean(row.passport_front_path),
          passportBack: Boolean(row.passport_back_path),
          applicantPhoto: Boolean(row.photograph_path),
        },
      })),
      pagination: { total, hasMore: offset + items.rows.length < total },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/applications/:applicationId', requireAuth, async (request, response, next) => {
  try {
    const result = await query(
      `SELECT a.id, s.country, s.visa_type AS "visaType",
              a.full_name AS "applicantName", a.status,
              TO_CHAR(a.submitted_at, 'YYYY-MM-DD') AS "submittedDate",
              TO_CHAR(a.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth",
              a.passport_number AS "passportNumber",
              TO_CHAR(a.intended_entry_date, 'YYYY-MM-DD') AS "intendedEntryDate",
              json_build_object('passportFront', a.passport_front_path IS NOT NULL, 'passportBack', a.passport_back_path IS NOT NULL, 'applicantPhoto', a.photograph_path IS NOT NULL) AS "uploadedDocuments"
       FROM visa_applications a
       JOIN visa_services s ON s.id = a.service_id
       WHERE a.id = $1 AND a.user_id = $2`,
      [request.params.applicationId, request.user!.id],
    );
    if (!result.rows[0]) return response.status(404).json({ success: false, error: { message: 'Application not found' } });
    return response.json({ success: true, data: { ...result.rows[0], documents: ['Passport', 'Photograph'] } });
  } catch (error) {
    return next(error);
  }
});

// Short-lived (5 min) signed URL for a private visa document.
router.get('/applications/:applicationId/documents/:documentType', requireAuth, async (request, response, next) => {
  try {
    const documentMap: Record<string, 'passport_front' | 'passport_back' | 'photograph'> = {
      passportFront: 'passport_front', passportBack: 'passport_back', applicantPhoto: 'photograph',
      passport_front: 'passport_front', passport_back: 'passport_back', photograph: 'photograph',
    };
    const column = documentMap[String(request.params.documentType)];
    if (!column) {
      return response.status(400).json({ success: false, error: { message: 'Invalid document type' } });
    }

    const result = await query<{ passport_front_path: string | null; passport_back_path: string | null; photograph_path: string | null }>(
      'SELECT passport_front_path, passport_back_path, photograph_path FROM visa_applications WHERE id = $1 AND user_id = $2',
      [request.params.applicationId, request.user!.id],
    );
    const row = result.rows[0];
    if (!row) return response.status(404).json({ success: false, error: { message: 'Application not found' } });

    const fileUrl = { passport_front: row.passport_front_path, passport_back: row.passport_back_path, photograph: row.photograph_path }[column];
    if (!fileUrl) return response.status(404).json({ success: false, error: { message: 'Document not found' } });

    const key = new URL(fileUrl).pathname.replace(/^\//, '');
    const url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: visaBucket(), Key: key }), { expiresIn: 300 });
    return response.json({ success: true, data: { url, expiresIn: 300 }, url, expiresIn: 300 });
  } catch (error) {
    return next(error);
  }
});

router.use(visaErrorHandler);

export const visaRouter = router;