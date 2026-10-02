import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
const catalogMigration = await readFile(new URL('../migrations/003_catalog_content.sql', import.meta.url), 'utf8');
const dynamicCatalogMigration = await readFile(new URL('../migrations/004_dynamic_catalog.sql', import.meta.url), 'utf8');
const userPlatformMigration = await readFile(new URL('../migrations/005_user_platform.sql', import.meta.url), 'utf8');
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

test('user platform migration backfills from auth history and constrains values', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.exec(`INSERT INTO users (id, name, email, phone, password_hash) VALUES
      ('00000000-0000-4000-8000-000000000001', 'Website User', 'website@example.com', '+14155552671', 'hash'),
      ('00000000-0000-4000-8000-000000000002', 'Verified User', 'verified@example.com', NULL, 'hash'),
      ('00000000-0000-4000-8000-000000000003', 'Default User', 'default@example.com', NULL, 'hash')`);
    await db.exec(migration);
    await db.query("INSERT INTO user_sessions (user_id, platform, refresh_token_hash, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', 'website', 'session-hash', now() + interval '1 day')");
    await db.query("INSERT INTO email_verifications (user_id, platform, token_hash, expires_at) VALUES ('00000000-0000-4000-8000-000000000002', 'website', 'email-hash', now() + interval '1 day')");
    await db.exec(userPlatformMigration);

    const users = await db.query<{ email: string; platform: string }>('SELECT email, platform FROM users ORDER BY email');
    assert.deepEqual(users.rows, [
      { email: 'default@example.com', platform: 'app' },
      { email: 'verified@example.com', platform: 'website' },
      { email: 'website@example.com', platform: 'website' },
    ]);
    await assert.rejects(db.query("UPDATE users SET platform = 'desktop' WHERE email = 'default@example.com'"));
  } finally {
    await db.close();
  }
});

test('dynamic catalog migration adds database-backed services and destinations', async () => {
  const db = new PGlite();
  try {
    await db.exec(catalogMigration);
    await db.exec(dynamicCatalogMigration);

    const result = await db.query<{ content_type: string; count: number }>(
      'SELECT content_type, count(*)::int AS count FROM content_items GROUP BY content_type ORDER BY content_type',
    );
    assert.deepEqual(result.rows, [
      { content_type: 'blog', count: 3 },
      { content_type: 'package', count: 3 },
      { content_type: 'service', count: 6 },
      { content_type: 'visa', count: 8 },
    ]);
    const activeSeeds = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM content_items WHERE active = true AND id IN (\'pkg-1\', \'pkg-2\', \'pkg-3\', \'blog-1\', \'blog-2\', \'blog-3\', \'visa-uae\', \'visa-uk\', \'visa-usa\', \'visa-canada\', \'visa-australia\', \'visa-schengen\', \'visa-singapore\', \'visa-thailand\')');
    assert.equal(activeSeeds.rows[0].count, 0);

    await db.query(
      "INSERT INTO content_items (id, content_type, data) VALUES ('train-listing-1', 'listing', '{\"serviceId\":\"trains\"}')",
    );
    const listing = await db.query<{ content_type: string }>("SELECT content_type FROM content_items WHERE id = 'train-listing-1'");
    assert.equal(listing.rows[0].content_type, 'listing');
  } finally {
    await db.close();
  }
});