-- Visa applications for the shared LemonTrip database.
-- Safe to run where the website API has already created these objects.
CREATE TABLE IF NOT EXISTS visa_applications (
  id VARCHAR(80) PRIMARY KEY,
  service_id VARCHAR(80) NOT NULL REFERENCES visa_services(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name VARCHAR(160) NOT NULL,
  email VARCHAR(255) NOT NULL,
  passport_number VARCHAR(80) NOT NULL,
  intended_entry_date DATE,
  passport_front_path TEXT,
  passport_back_path TEXT,
  photograph_path TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'in_review', 'approved', 'rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE visa_applications ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(120);

CREATE INDEX IF NOT EXISTS idx_visa_applications_submitted_at
  ON visa_applications (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_visa_applications_user_submitted
  ON visa_applications (user_id, submitted_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visa_applications_service
  ON visa_applications (service_id);
CREATE UNIQUE INDEX IF NOT EXISTS visa_applications_user_idempotency
  ON visa_applications (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;