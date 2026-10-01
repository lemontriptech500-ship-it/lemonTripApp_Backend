import 'dotenv/config';
import { z } from 'zod';
const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    CORS_ORIGIN: z.string().default('http://localhost:8082'),
});
export const env = envSchema.parse(process.env);
