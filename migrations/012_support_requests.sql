CREATE TABLE IF NOT EXISTS support_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(255) NOT NULL,
  topic VARCHAR(40) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  booking_reference VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'in_progress', 'closed')),
  submission_key VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, submission_key)
);
CREATE TABLE IF NOT EXISTS support_request_updates (
  id UUID PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  event_key VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, event_key)
);
CREATE INDEX IF NOT EXISTS support_requests_user_created ON support_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_request_updates_request ON support_request_updates (request_id, created_at);
