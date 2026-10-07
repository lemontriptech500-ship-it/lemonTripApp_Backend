-- 006_notifications_profile.sql
-- Additive only: nothing is dropped or renamed, existing data is kept.

-- 1) User profile fields + notification preferences
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS date_of_birth date,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS nationality text,
  ADD COLUMN IF NOT EXISTS push_notifications_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_notifications_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_gender_check;
ALTER TABLE users
  ADD CONSTRAINT users_gender_check
  CHECK (gender IS NULL OR gender IN ('male', 'female', 'other'));

-- 2) Device tokens for push notifications (one user can have many devices)
CREATE TABLE IF NOT EXISTS device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  device_platform text NOT NULL CHECK (device_platform IN ('android', 'ios', 'web')),
  device_id text,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_tokens_user_active_idx
  ON device_tokens(user_id) WHERE is_active;

-- 3) Notifications inbox (shown in app and website, read/unread)
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'booking_confirmed', 'booking_updated', 'booking_cancelled',
    'payment_success', 'payment_failed',
    'visa_update', 'general'
  )),
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications(user_id) WHERE read_at IS NULL;

-- 4) Bookings: numeric amount + currency, and updated_at
--    The existing text column "price" (e.g. '₹24,999') is kept untouched.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS amount numeric(12, 2),
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill amount from the first number in the old price text, for example 'Rs. 24,999' or '24999.50'
UPDATE bookings
SET amount = replace(substring(price from '[0-9][0-9,]*(?:[.][0-9]{1,2})?'), ',', '')::numeric
WHERE amount IS NULL
  AND price ~ '[0-9]';

-- Keep updated_at current on every change
CREATE OR REPLACE FUNCTION lemontrip_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bookings_set_updated_at ON bookings;
CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION lemontrip_set_updated_at();

DROP TRIGGER IF EXISTS device_tokens_set_updated_at ON device_tokens;
CREATE TRIGGER device_tokens_set_updated_at
  BEFORE UPDATE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION lemontrip_set_updated_at();