import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './db.js';
const migrationsDirectory = path.resolve(fileURLToPath(new URL('../migrations/', import.meta.url)));
const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
const ledgerTable = 'lemontrip_mobile_schema_migrations';
const migrationLock = 72416031;
const allowReviewedExistingSchema = process.argv.includes('--allow-existing-schema-reviewed');
const sharedSchemaStrategyApproved = process.argv.includes('--shared-schema-strategy-approved');
if (!sharedSchemaStrategyApproved) {
    throw new Error('Mobile migrations can change the shared LemonTrip schema. Stop: run only after the team has approved the shared-schema migration strategy and pass --shared-schema-strategy-approved.');
}
try {
    const client = await pool.connect();
    let locked = false;
    try {
        await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
        locked = true;
        const ownLedger = await client.query(`SELECT to_regclass('public.${ledgerTable}') AS name`);
        if (!ownLedger.rows[0]?.name) {
            const legacyLedger = await client.query("SELECT to_regclass('public.schema_migrations') AS name");
            let recordedHere = [];
            if (legacyLedger.rows[0]?.name) {
                const result = await client.query('SELECT version FROM schema_migrations');
                const recorded = new Set(result.rows.map((row) => row.version));
                recordedHere = migrationFiles.filter((file) => recorded.has(file));
            }
            if (!recordedHere.length && !allowReviewedExistingSchema) {
                const existing = await client.query(`SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             AND table_name NOT IN ('schema_migrations')`);
                if (existing.rowCount) {
                    throw new Error(`Existing database tables found without recorded mobile migrations (${existing.rows.map((row) => row.table_name).join(', ')}). Migration stopped; review and baseline adoption separately.`);
                }
            }
            await client.query(`CREATE TABLE IF NOT EXISTS ${ledgerTable} (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
            if (recordedHere.length) {
                await client.query(`INSERT INTO ${ledgerTable} (version, applied_at)
           SELECT version, applied_at FROM schema_migrations WHERE version = ANY($1::text[])
           ON CONFLICT (version) DO NOTHING`, [recordedHere]);
            }
        }
        for (const file of migrationFiles) {
            const alreadyApplied = await client.query(`SELECT 1 FROM ${ledgerTable} WHERE version = $1`, [file]);
            if (alreadyApplied.rowCount)
                continue;
            const migration = await readFile(path.join(migrationsDirectory, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(migration);
                await client.query(`INSERT INTO ${ledgerTable} (version) VALUES ($1)`, [file]);
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
            await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]);
        client.release();
    }
}
finally {
    await pool.end();
}
