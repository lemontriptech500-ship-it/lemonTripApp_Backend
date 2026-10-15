ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform text;

UPDATE users AS user_accounts
SET platform = COALESCE(
  (
    SELECT sessions.platform
    FROM user_sessions AS sessions
    WHERE sessions.user_id = user_accounts.id
    ORDER BY sessions.created_at DESC
    LIMIT 1
  ),
  (
    SELECT verifications.platform
    FROM email_verifications AS verifications
    WHERE verifications.user_id = user_accounts.id
    ORDER BY verifications.created_at DESC
    LIMIT 1
  ),
  (
    SELECT accounts.linked_from_platform
    FROM oauth_accounts AS accounts
    WHERE accounts.user_id = user_accounts.id
    ORDER BY accounts.created_at DESC
    LIMIT 1
  ),
  (
    SELECT challenges.platform
    FROM otp_verifications AS challenges
    WHERE user_accounts.phone IS NOT NULL
      AND regexp_replace(challenges.phone, '\D', '', 'g') = regexp_replace(user_accounts.phone, '\D', '', 'g')
    ORDER BY challenges.created_at DESC
    LIMIT 1
  ),
  'app'
)
WHERE user_accounts.platform IS NULL;

DO $$
BEGIN
  IF (
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'platform'
  ) IS NULL THEN
    ALTER TABLE users ALTER COLUMN platform SET DEFAULT 'app';
  END IF;
END $$;

ALTER TABLE users
  ALTER COLUMN platform SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_platform_check CHECK (platform IN ('app', 'website'));