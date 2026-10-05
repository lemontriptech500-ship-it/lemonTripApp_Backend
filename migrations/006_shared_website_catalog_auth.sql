-- Keep the mobile backend's shared database compatible with the website API.
-- These definitions match the website catalog schema while remaining safe if
-- that service has already created the tables.
CREATE TABLE IF NOT EXISTS blog_posts (
  id VARCHAR(80) PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL,
  image_fallback_color VARCHAR(120) NOT NULL,
  image_url TEXT,
  published_at DATE NOT NULL,
  read_time VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS travel_packages (
  id VARCHAR(80) PRIMARY KEY,
  destination VARCHAR(160) NOT NULL,
  duration VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  starting_price VARCHAR(80) NOT NULL,
  highlights TEXT[] NOT NULL DEFAULT '{}',
  image_fallback_color VARCHAR(120) NOT NULL,
  image_url TEXT,
  category VARCHAR(20) NOT NULL DEFAULT 'international' CHECK (category IN ('national', 'international')),
  price_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price_amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS visa_services (
  id VARCHAR(80) PRIMARY KEY,
  country VARCHAR(120) NOT NULL,
  visa_type VARCHAR(160) NOT NULL,
  processing_time VARCHAR(120) NOT NULL,
  starting_from VARCHAR(80) NOT NULL,
  image_url TEXT,
  documents TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_packages_created_at ON travel_packages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_packages_category ON travel_packages (category);
CREATE INDEX IF NOT EXISTS idx_visa_services_country ON visa_services (country);

-- The legacy website API inserts name/email/password fields without mobile
-- first_name/last_name. Keep the shared users row valid for both APIs.
ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE,
  ADD COLUMN IF NOT EXISTS avatar TEXT,
  ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'local';

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND conname = 'users_provider_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('local', 'google'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION lemontrip_sync_user_names()
RETURNS trigger AS $$
DECLARE
  normalized_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.first_name IS NULL OR BTRIM(NEW.first_name) = '' THEN
      normalized_name := BTRIM(COALESCE(NEW.name, ''));
      NEW.first_name := NULLIF(SPLIT_PART(normalized_name, ' ', 1), '');
      NEW.last_name := NULLIF(BTRIM(SUBSTRING(normalized_name FROM LENGTH(SPLIT_PART(normalized_name, ' ', 1)) + 2)), '');
    ELSIF NEW.name IS NULL OR BTRIM(NEW.name) = '' THEN
      NEW.name := BTRIM(CONCAT_WS(' ', NEW.first_name, NEW.last_name));
    END IF;
  ELSIF NEW.name IS DISTINCT FROM OLD.name THEN
    normalized_name := BTRIM(COALESCE(NEW.name, ''));
    NEW.first_name := NULLIF(SPLIT_PART(normalized_name, ' ', 1), '');
    NEW.last_name := NULLIF(BTRIM(SUBSTRING(normalized_name FROM LENGTH(SPLIT_PART(normalized_name, ' ', 1)) + 2)), '');
  ELSIF NEW.first_name IS DISTINCT FROM OLD.first_name OR NEW.last_name IS DISTINCT FROM OLD.last_name THEN
    NEW.name := BTRIM(CONCAT_WS(' ', NEW.first_name, NEW.last_name));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_sync_names ON users;
CREATE TRIGGER users_sync_names
BEFORE INSERT OR UPDATE OF name, first_name, last_name ON users
FOR EACH ROW EXECUTE FUNCTION lemontrip_sync_user_names();
