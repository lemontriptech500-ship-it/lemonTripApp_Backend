import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './db.js';
const migrationsDirectory = path.resolve(fileURLToPath(new URL('../migrations/', import.meta.url)));
const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
try {
    const client = await pool.connect();
    let locked = false;
    try {
        await client.query('SELECT pg_advisory_lock($1)', [748291036]);
        locked = true;
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
        for (const file of migrationFiles) {
            const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
            if (alreadyApplied.rowCount)
                continue;
            const migration = await readFile(path.join(migrationsDirectory, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(migration);
                await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`Applied migration ${file}.`);
            }
            catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
    }
    finally {
        if (locked)
            await client.query('SELECT pg_advisory_unlock($1)', [748291036]);
        client.release();
    }
}
finally {
    await pool.end();
}
