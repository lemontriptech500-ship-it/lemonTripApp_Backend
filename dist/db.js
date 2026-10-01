import { Pool } from 'pg';
import { env } from './config.js';
export const pool = new Pool({ connectionString: env.DATABASE_URL });
export function query(text, values = []) {
    return pool.query(text, values);
}
