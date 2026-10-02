import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
// Resolve the backend's .env file independently of the shell's working directory.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: resolve(packageDir, '.env') });
const groqApiKeySchema = z.preprocess((value) => {
    if (typeof value !== 'string')
        return value;
    const normalized = value.trim();
    return normalized === '' || normalized === 'your_groq_api_key_here' ? undefined : normalized;
}, z.string().min(1).optional());
const envSchema = z.object({
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: z.enum(['true', 'false']).optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32).optional(),
    CORS_ORIGIN: z.string().default('http://localhost:8081,http://localhost:8082'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_IDS: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    OTP_PROVIDER: z.enum(['twilio']).optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    OTP_SENDER: z.string().optional(),
    EMAIL_PROVIDER: z.enum(['resend']).optional(),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
    DEFAULT_PHONE_REGION: z.string().length(2).default('IN'),
    GROQ_API_KEY: groqApiKeySchema,
    GROQ_MODEL: z.string().default('qwen/qwen3.8-27b'),
});
export const env = envSchema.parse(process.env);
