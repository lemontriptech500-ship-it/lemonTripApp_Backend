import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './db.js';

const migrationPath = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url));
const migration = await readFile(path.resolve(migrationPath), 'utf8');

try {
  await pool.query(migration);
  console.log('Database migration complete.');
} finally {
  await pool.end();
}
