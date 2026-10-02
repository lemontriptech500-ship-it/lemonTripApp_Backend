ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE users
SET first_name = COALESCE(NULLIF(first_name, ''), split_part(name, ' ', 1)),
    last_name = COALESCE(last_name, NULLIF(substr(name, length(split_part(name, ' ', 1)) + 2), ''))
WHERE first_name IS NULL OR first_name = '';

ALTER TABLE users
  ALTER COLUMN first_name SET NOT NULL,
  ADD CONSTRAINT users_account_status_check CHECK (account_status IN ('pending', 'active', 'disabled'));

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx
  ON users (lower(email)) WHERE email IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT regexp_replace(phone, '\D', '', 'g')
    FROM users
    WHERE phone IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') <> ''
    GROUP BY regexp_replace(phone, '\D', '', 'g')
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate existing phone numbers must be reviewed before applying shared auth migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_digits_unique_idx
  ON users (regexp_replace(phone, '\D', '', 'g'))
  WHERE phone IS NOT NULL AND regexp_replace(phone, '\D', '', 'g') <> '';

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('app', 'website')),
  refresh_token_hash text NOT NULL UNIQUE,
  device_id text,
  device_name text,
  user_agent text,
  ip_address inet,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_active_idx ON user_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  provider_user_id text NOT NULL,
  provider_email text,
  linked_from_platform text CHECK (linked_from_platform IN ('app', 'website')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS oauth_accounts_user_id_idx ON oauth_accounts(user_id);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('phone_signup', 'phone_login')),
  platform text NOT NULL CHECK (platform IN ('app', 'website')),
  code_hash text NOT NULL,
  signup_data jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS otp_verifications_phone_idx ON otp_verifications(phone, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_verifications_expiry_idx ON otp_verifications(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('app', 'website')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user_id_idx ON email_verifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_verifications_expiry_idx ON email_verifications(expires_at) WHERE consumed_at IS NULL;