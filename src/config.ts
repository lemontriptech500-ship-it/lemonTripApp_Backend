import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Resolve the backend's .env file independently of the shell's working directory.
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: resolve(packageDir, '.env') });

const groqApiKeySchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim();
    return normalized === '' || normalized === 'your_groq_api_key_here' ? undefined : normalized;
  },
  z.string().min(1).optional(),
);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CORS_ORIGIN: z.string().default('http://localhost:8081,http://localhost:8082'),
  GROQ_API_KEY: groqApiKeySchema,
  GROQ_MODEL: z.string().default('qwen/qwen3.8-27b'),
});

export const env = envSchema.parse(process.env);
