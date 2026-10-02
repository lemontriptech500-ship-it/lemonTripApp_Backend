import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
const legacySchema = `
  CREATE TABLE users (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    phone text,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

test('shared auth migration preserves existing user data and adds auth constraints', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.query("INSERT INTO users (id, name, email, phone, password_hash) VALUES ('00000000-0000-4000-8000-000000000001', 'Asha Rao', 'asha@example.com', '+1 (415) 555-2671', 'bcrypt-hash')");
    await db.exec('BEGIN');
    await db.exec(migration);
    await db.exec('COMMIT');

    const result = await db.query<{ name: string; first_name: string; last_name: string; email_verified: boolean; account_status: string }>(
      'SELECT name, first_name, last_name, email_verified, account_status FROM users WHERE email = $1', ['asha@example.com'],
    );
    assert.deepEqual(result.rows[0], { name: 'Asha Rao', first_name: 'Asha', last_name: 'Rao', email_verified: false, account_status: 'active' });

    await assert.rejects(db.query("INSERT INTO user_sessions (user_id, platform, refresh_token_hash, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', 'desktop', 'hashed', now() + interval '1 day')"));
    await db.query("INSERT INTO user_sessions (user_id, platform, refresh_token_hash, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', 'app', 'hashed', now() + interval '1 day')");
  } finally {
    await db.close();
  }
});

test('shared auth migration refuses duplicate normalized legacy phones without data loss', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.exec(`INSERT INTO users (id, name, email, phone, password_hash) VALUES
      ('00000000-0000-4000-8000-000000000001', 'Asha Rao', 'asha@example.com', '+1 (415) 555-2671', 'hash'),
      ('00000000-0000-4000-8000-000000000002', 'Asha R', 'asha2@example.com', '+14155552671', 'hash')`);
    await db.exec('BEGIN');
    await assert.rejects(db.exec(migration), /Duplicate existing phone numbers/);
    await db.exec('ROLLBACK');
    const users = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
    assert.equal(users.rows[0].count, 2);
    const columns = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'account_status'");
    assert.equal(columns.rows[0].count, 0);
  } finally {
    await db.close();
  }
});