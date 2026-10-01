import { Pool, type QueryResultRow } from 'pg';
import { env } from './config.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}
