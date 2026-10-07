import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pathToFileURL } from 'node:url';
const websiteRoot = process.env.WEBSITE_BACKEND_DIR ? new URL(pathToFileURL(process.env.WEBSITE_BACKEND_DIR).href + '/') : new URL('../../../website/backendLemonTrip/', import.meta.url);

const migration = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
const catalogMigration = await readFile(new URL('../migrations/003_catalog_content.sql', import.meta.url), 'utf8');
const dynamicCatalogMigration = await readFile(new URL('../migrations/004_dynamic_catalog.sql', import.meta.url), 'utf8');
const userPlatformMigration = await readFile(new URL('../migrations/005_user_platform.sql', import.meta.url), 'utf8');
const sharedCompatibilityMigration = await readFile(new URL('../migrations/006_shared_website_catalog_auth.sql', import.meta.url), 'utf8');
const websiteVisaApplicationMigration = await readFile(new URL('db/migrations/003_visa_applications.sql', websiteRoot), 'utf8');
const websiteSchema = await readFile(new URL('db/schema.sql', websiteRoot), 'utf8');
const websiteCatalogMigrations = await Promise.all(['001_catalog_tables.sql', '002_catalog_indexes.sql', '003_visa_applications.sql', '004_contact_message_resolved.sql', '005_blog_publication_status.sql'].map((file) => readFile(new URL(`db/migrations/${file}`, websiteRoot), 'utf8')));
const mobileMigrations = await Promise.all(['001_initial.sql', '002_shared_auth.sql', '003_catalog_content.sql', '004_dynamic_catalog.sql', '005_user_platform.sql', '006_shared_website_catalog_auth.sql'].map((file) => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')));
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

test('shared website compatibility migration provisions normalized catalogs and accepts legacy website user inserts', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.exec(migration);
    await db.exec(sharedCompatibilityMigration);
    await db.exec(sharedCompatibilityMigration);

    await db.query(
      "INSERT INTO users (name, email, password_hash) VALUES ('LemonTrip Website User', 'website-user@example.com', 'hash')",
    );
    const user = await db.query<{ first_name: string; last_name: string | null; provider: string }>(
      "SELECT first_name, last_name, provider FROM users WHERE email = 'website-user@example.com'",
    );
    assert.deepEqual(user.rows[0], { first_name: 'LemonTrip', last_name: 'Website User', provider: 'local' });

    const catalogs = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('blog_posts', 'travel_packages', 'visa_services') ORDER BY table_name",
    );
    assert.deepEqual(catalogs.rows.map((row) => row.table_name), ['blog_posts', 'travel_packages', 'visa_services']);

    await db.query("UPDATE users SET name = 'Updated Website Name' WHERE email = 'website-user@example.com'");
    const updated = await db.query<{ first_name: string; last_name: string | null }>(
      "SELECT first_name, last_name FROM users WHERE email = 'website-user@example.com'",
    );
    assert.deepEqual(updated.rows[0], { first_name: 'Updated', last_name: 'Website Name' });
  } finally {
    await db.close();
  }
});

test('website visa application migration enforces service and user relationships', async () => {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    await db.exec(migration);
    await db.exec(sharedCompatibilityMigration);
    await db.exec(websiteVisaApplicationMigration);
    await db.query("INSERT INTO visa_services (id, country, visa_type, processing_time, starting_from) VALUES ('visa-test', 'France', 'Visitor', '10 days', 'INR 1000')");
    await db.query("INSERT INTO users (id, name, first_name, email, password_hash) VALUES ('00000000-0000-4000-8000-000000000001', 'Test User', 'Test', 'visa-test@example.com', 'hash')");
    await db.query("INSERT INTO visa_applications (id, service_id, user_id, full_name, email, passport_number) VALUES ('LT-VISA-TEST', 'visa-test', '00000000-0000-4000-8000-000000000001', 'Test User', 'visa-test@example.com', 'P123456')");
    await db.query("DELETE FROM users WHERE id = '00000000-0000-4000-8000-000000000001'");
    const application = await db.query<{ user_id: string | null; status: string }>("SELECT user_id, status FROM visa_applications WHERE id = 'LT-VISA-TEST'");
    assert.deepEqual(application.rows[0], { user_id: null, status: 'submitted' });
    await assert.rejects(db.query("DELETE FROM visa_services WHERE id = 'visa-test'"));
  } finally {
    await db.close();
  }
});

test('fresh shared website/mobile PostgreSQL schema applies in documented order', async () => {
  const db = new PGlite();
  try {
    // PGlite bundles gen_random_uuid but not the pgcrypto extension installer.
    await db.exec(websiteSchema.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/i, ''));
    for (const sql of websiteCatalogMigrations) await db.exec(sql);
    for (const sql of mobileMigrations) {
      await db.exec(sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/gi, ''));
    }

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('blog_posts', 'travel_packages', 'visa_services', 'visa_applications', 'users', 'bookings') ORDER BY table_name",
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), ['blog_posts', 'bookings', 'travel_packages', 'users', 'visa_applications', 'visa_services']);

    await db.query("INSERT INTO contact_messages (name, email, phone, subject, message, status) VALUES ('Test User', 'test@example.com', '123456789', 'Test', 'A sufficiently long message', 'resolved')");
    const canonicalCatalogCounts = await db.query<{ table_name: string; count: number }>(
      "SELECT 'blog_posts' AS table_name, count(*)::int AS count FROM blog_posts UNION ALL SELECT 'travel_packages', count(*)::int FROM travel_packages UNION ALL SELECT 'visa_services', count(*)::int FROM visa_services",
    );
    assert.deepEqual(canonicalCatalogCounts.rows, [
      { table_name: 'blog_posts', count: 0 },
      { table_name: 'travel_packages', count: 0 },
      { table_name: 'visa_services', count: 0 },
    ]);

    await db.query(
      "INSERT INTO blog_posts (id, category, title, excerpt, content, image_fallback_color, published_at) VALUES ('blog-existing', 'Guide', 'Existing post', 'Excerpt', 'Content', 'bg', '2026-09-01')",
    );
    const existingStatus = await db.query<{ publication_status: string }>(
      "SELECT publication_status FROM blog_posts WHERE id = 'blog-existing'",
    );
    assert.equal(existingStatus.rows[0].publication_status, 'published');
    await assert.rejects(db.query(
      "UPDATE blog_posts SET publication_status = 'scheduled' WHERE id = 'blog-existing'",
    ));
  } finally {
    await db.close();
  }
});
