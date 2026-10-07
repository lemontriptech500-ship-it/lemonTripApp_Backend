-- 010_google_account_sync.sql
-- Keeps Google accounts in sync: website users.google_id and app oauth_accounts.
-- Additive only: nothing is dropped or renamed.
CREATE OR REPLACE FUNCTION users_mark_google_verified() RETURNS trigger AS $$
BEGIN
  IF NEW.provider = 'google' AND NEW.google_id IS NOT NULL THEN
    NEW.email_verified := true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_google_verified_trg ON users;
CREATE TRIGGER users_google_verified_trg
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_mark_google_verified();

INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, linked_from_platform)
SELECT id, 'google', google_id, email, 'website'
FROM users
WHERE google_id IS NOT NULL
ON CONFLICT (provider, provider_user_id) DO NOTHING;

UPDATE users
SET email_verified = true
WHERE provider = 'google' AND google_id IS NOT NULL AND email_verified = false;

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