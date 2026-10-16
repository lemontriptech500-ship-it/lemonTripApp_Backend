import multer from 'multer';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { env } from './config.js';
import { query } from './db.js';

const FILE_MAX_BYTES = 5 * 1024 * 1024;
const PHOTOGRAPH_MAX_BYTES = 2 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export const s3Client = new S3Client({
  region: env.AWS_REGION,
  ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        },
      }
    : {}),
});

function slugify(value: unknown) {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'unknown'
  );
}

function extname(filename: string) {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

const allowedTypes: Record<string, string[]> = {
  passportFront: ['application/pdf', 'image/jpeg', 'image/png'],
  passportBack: ['application/pdf', 'image/jpeg', 'image/png'],
  photograph: ['image/jpeg', 'image/png'],
};
const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png'];

const visaUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_request, file, callback) => {
    const types = allowedTypes[file.fieldname] ?? [];
    if (!types.includes(file.mimetype) || !allowedExtensions.includes(extname(file.originalname))) {
      return callback(new HttpError('Unsupported file type. Use PDF, JPG or PNG (photograph: JPG or PNG).', 400));
    }
    return callback(null, true);
  },
  limits: { fileSize: FILE_MAX_BYTES },
}).fields([
  { name: 'passportFront', maxCount: 1 },
  { name: 'passportBack', maxCount: 1 },
  { name: 'photograph', maxCount: 1 },
]);

// Key format: visa/<country-visa_type>/<applicant>/<field>-<time>-<rand>.<ext>
async function buildKey(request: Request, file: Express.Multer.File) {
  let visaTypeSlug = 'unknown-visa-type';
  if (request.body?.serviceId) {
    const result = await query<{ country: string; visa_type: string }>(
      'SELECT country, visa_type FROM visa_services WHERE id = $1',
      [request.body.serviceId],
    );
    const service = result.rows[0];
    if (service) visaTypeSlug = slugify(`${service.country}-${service.visa_type}`);
  }

  let applicantSlug = 'unknown-applicant';
  if (request.body?.personalDetails) {
    try {
      applicantSlug = slugify(JSON.parse(request.body.personalDetails).fullName);
    } catch {
      // malformed JSON: keep 'unknown-applicant'
    }
  }

  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `visa/${visaTypeSlug}/${applicantSlug}/${file.fieldname}-${unique}${extname(file.originalname)}`;
}

export function visaBucket() {
  if (!env.VISA_S3_BUCKET) throw new HttpError('Visa document storage is not configured.', 503);
  return env.VISA_S3_BUCKET;
}

function publicUrl(bucket: string, key: string) {
  return `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

async function removeUploaded(bucket: string, keys: string[]) {
  if (!keys.length) return;
  try {
    await s3Client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
  } catch (error) {
    console.error('Could not remove partially uploaded visa files', error);
  }
}

export type UploadedVisaFile = Express.Multer.File & { key?: string; location?: string };

export const uploadVisaDocuments: RequestHandler = (request, response, next) => {
  visaUpload(request, response, async (error: unknown) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        return next(new HttpError(
          error.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 5 MB.' : 'Unexpected file upload field.',
          400,
        ));
      }
      return next(error);
    }

    const grouped = (request.files ?? {}) as Record<string, UploadedVisaFile[]>;
    const files = Object.values(grouped).flat();
    if (!files.length) return next();

    const photo = grouped.photograph?.[0];
    if (photo && photo.size > PHOTOGRAPH_MAX_BYTES) {
      return next(new HttpError('Photograph must be 2 MB or smaller.', 400));
    }

    let bucket: string;
    try {
      bucket = visaBucket();
    } catch (configError) {
      return next(configError);
    }

    const uploadedKeys: string[] = [];
    try {
      await Promise.all(files.map(async (file) => {
        const key = await buildKey(request, file);
        await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file.buffer, ContentType: file.mimetype }));
        uploadedKeys.push(key);
        file.key = key;
        file.location = publicUrl(bucket, key);
        file.buffer = undefined as unknown as Buffer;
      }));
    } catch (uploadError) {
      console.error('Visa document upload to S3 failed', uploadError);
      await removeUploaded(bucket, uploadedKeys);
      return next(new HttpError('Could not store documents. Please try again.', 502));
    }
    return next();
  });
};

// app.ts's global handler always returns 500, so visa routes handle their own errors.
export const visaErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (error instanceof HttpError) {
    return response.status(error.status).json({ success: false, error: { message: error.message } });
  }
  return next(error);
};