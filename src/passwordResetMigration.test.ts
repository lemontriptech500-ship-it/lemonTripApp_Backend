import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/012_password_reset_compatibility.sql', import.meta.url), 'utf8');
const appMigration = await readFile(new URL('../migrations/013_app_password_reset_tokens.sql', import.meta.url), 'utf8');

test('app token migration works after 011 and 012 were already applied and preserves website tokens', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE users (id uuid PRIMARY KEY)');
    await db.exec(await readFile(new URL('../migrations/011_password_reset.sql', import.meta.url), 'utf8'));
    await db.exec(migration);
    await db.exec("INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001'); INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ('00000000-0000-0000-0000-000000000001', 'website-only', now() + interval '30 minutes')");
    await db.exec(appMigration);
    await db.exec(appMigration);
    assert.equal((await db.query('SELECT * FROM password_reset_tokens')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM app_password_reset_tokens')).rows.length, 0);
  } finally { await db.close(); }
});

test('app token migration preserves consumed tokens from the earlier app-only schema', async () => {
  const db = new PGlite();
  try {
    await db.exec("CREATE TABLE users (id uuid PRIMARY KEY); CREATE TABLE app_password_reset_tokens (user_id uuid, token_hash text, consumed_at timestamptz); INSERT INTO app_password_reset_tokens VALUES (NULL, 'used', '2026-01-01'), (NULL, 'unused', NULL)");
    await db.exec(appMigration);
    await db.exec(appMigration);
    const result = await db.query<{ token_hash: string; used: boolean }>('SELECT token_hash, used_at IS NOT NULL AS used FROM app_password_reset_tokens ORDER BY token_hash');
    assert.deepEqual(result.rows, [{ token_hash: 'unused', used: false }, { token_hash: 'used', used: true }]);
  } finally { await db.close(); }
});

for (const column of ['consumed_at', 'used_at']) {
  test(`password reset compatibility preserves consumed tokens in ${column} schemas`, async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE TABLE password_reset_tokens (user_id uuid, token_hash text, ${column} timestamptz);
        INSERT INTO password_reset_tokens (token_hash, ${column}) VALUES ('consumed', '2026-01-01'), ('unused', NULL)`);
      await db.exec(migration);
      await db.exec(migration);
      const result = await db.query<{ token_hash: string; used: boolean }>('SELECT token_hash, used_at IS NOT NULL AS used FROM password_reset_tokens ORDER BY token_hash');
      assert.deepEqual(result.rows, [{ token_hash: 'consumed', used: true }, { token_hash: 'unused', used: false }]);
    } finally {
      await db.close();
    }
  });
}
