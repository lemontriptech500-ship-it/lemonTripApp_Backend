-- 007_legacy_website_compat.sql
-- Keeps the older website signup/login code working on the shared users table,
-- and keeps Google accounts in sync between the website (users.google_id / users.provider)
-- and the app backend (oauth_accounts). Additive only: nothing is dropped or renamed.

-- 1) The website signup does not send first_name / last_name (migration 002 made first_name
--    required). Fill them from "name" when they are missing. Google users created by the
--    website are verified by Google, so mark their email as verified.
CREATE OR REPLACE FUNCTION users_fill_names() RETURNS trigger AS $$
DECLARE
  full_name text := btrim(COALESCE(NEW.name, ''));
  first_word text := split_part(btrim(COALESCE(NEW.name, '')), ' ', 1);
BEGIN
  IF NEW.first_name IS NULL OR btrim(NEW.first_name) = '' THEN
    NEW.first_name := COALESCE(NULLIF(first_word, ''), 'User');
    IF NEW.last_name IS NULL THEN
      NEW.last_name := NULLIF(btrim(substr(full_name, length(first_word) + 1)), '');
    END IF;
  END IF;
  IF NEW.provider = 'google' AND NEW.google_id IS NOT NULL THEN
    NEW.email_verified := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_fill_names ON users;
CREATE TRIGGER users_fill_names
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_fill_names();

-- 2) Existing website Google users: link them in oauth_accounts so Google login in the app
--    finds the same user. Their email was verified by Google.
INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, linked_from_platform)
SELECT id, 'google', google_id, email, 'website'
FROM users
WHERE google_id IS NOT NULL
ON CONFLICT (provider, provider_user_id) DO NOTHING;

UPDATE users
SET email_verified = true
WHERE provider = 'google' AND google_id IS NOT NULL AND email_verified = false;

-- 3) Website writes users.google_id  ->  create the matching oauth_accounts row.
CREATE OR REPLACE FUNCTION users_sync_google_to_oauth() RETURNS trigger AS $$
BEGIN
  IF NEW.google_id IS NOT NULL THEN
    INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, linked_from_platform)
    VALUES (NEW.id, 'google', NEW.google_id, NEW.email, 'website')
    ON CONFLICT (provider, provider_user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_sync_google_to_oauth ON users;
CREATE TRIGGER users_sync_google_to_oauth
  AFTER INSERT OR UPDATE OF google_id ON users
  FOR EACH ROW EXECUTE FUNCTION users_sync_google_to_oauth();

-- 4) App links Google (oauth_accounts row)  ->  fill users.google_id so the website finds the
--    same user. Accounts without a password are marked provider = 'google'.
CREATE OR REPLACE FUNCTION oauth_sync_to_users() RETURNS trigger AS $$
BEGIN
  IF NEW.provider = 'google' THEN
    UPDATE users
    SET google_id = COALESCE(google_id, NEW.provider_user_id),
        provider = CASE WHEN password_hash IS NULL THEN 'google' ELSE provider END
    WHERE id = NEW.user_id
      AND NOT EXISTS (
        SELECT 1 FROM users other
        WHERE other.google_id = NEW.provider_user_id AND other.id <> NEW.user_id
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oauth_sync_to_users ON oauth_accounts;
CREATE TRIGGER oauth_sync_to_users
  AFTER INSERT ON oauth_accounts
  FOR EACH ROW EXECUTE FUNCTION oauth_sync_to_users();