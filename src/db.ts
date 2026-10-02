import { Pool, type QueryResultRow } from 'pg';
import { env } from './config.js';

const databaseHost = new URL(env.DATABASE_URL).hostname;
const isLocalDatabase = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseHost);
const useSsl = env.DATABASE_SSL === 'true' || (env.DATABASE_SSL !== 'false' && !isLocalDatabase);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}
