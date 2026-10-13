-- The website and mobile reset handlers use used_at. Older mobile schemas
-- recorded consumption in consumed_at; preserve it so tokens cannot be reused.
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'password_reset_tokens'
      AND column_name = 'consumed_at'
  ) THEN
    UPDATE password_reset_tokens
      SET used_at = consumed_at WHERE used_at IS NULL AND consumed_at IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS password_reset_tokens_unused_user_idx
  ON password_reset_tokens (user_id) WHERE used_at IS NULL;
