import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../migrations/012_password_reset_compatibility.sql', import.meta.url), 'utf8');

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
