-- Keep app recovery tokens separate from the website's reset tokens.
-- Add a migration rather than relying on edits to an already-applied 011.
CREATE TABLE IF NOT EXISTS app_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_password_reset_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;

-- Support installations that ran the earlier app-only consumed_at schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'app_password_reset_tokens'
      AND column_name = 'consumed_at'
  ) THEN
    UPDATE app_password_reset_tokens SET used_at = consumed_at
      WHERE used_at IS NULL AND consumed_at IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS app_password_reset_tokens_unused_user_idx
  ON app_password_reset_tokens (user_id) WHERE used_at IS NULL;
