CREATE TABLE IF NOT EXISTS upload_batches (
  id TEXT PRIMARY KEY,
  install_id_hash TEXT NOT NULL,
  terms_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_utc TEXT NOT NULL,
  updated_utc TEXT NOT NULL,
  expires_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_batches_status_idx
  ON upload_batches (status, updated_utc);

CREATE INDEX IF NOT EXISTS upload_batches_expiry_idx
  ON upload_batches (expires_utc);

CREATE TABLE IF NOT EXISTS upload_submissions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  status TEXT NOT NULL,
  map_sid TEXT NOT NULL,
  updated_utc TEXT NOT NULL,
  moderation_delivered_utc TEXT
);

CREATE INDEX IF NOT EXISTS upload_submissions_batch_idx
  ON upload_submissions (batch_id);

CREATE INDEX IF NOT EXISTS upload_submissions_status_idx
  ON upload_submissions (status, moderation_delivered_utc, updated_utc);

CREATE TABLE IF NOT EXISTS upload_objects (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES upload_submissions(id) ON DELETE CASCADE,
  max_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_bytes INTEGER
);

CREATE INDEX IF NOT EXISTS upload_objects_batch_idx
  ON upload_objects (batch_id);

CREATE TABLE IF NOT EXISTS upload_bot_nonces (
  nonce TEXT PRIMARY KEY,
  expires_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_bot_nonces_expiry_idx
  ON upload_bot_nonces (expires_utc);

CREATE TABLE IF NOT EXISTS upload_catalog_entries (
  id TEXT PRIMARY KEY,
  entry_json TEXT NOT NULL,
  published_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_catalog_entries_published_utc_idx
  ON upload_catalog_entries (published_utc);

CREATE TABLE IF NOT EXISTS upload_catalog_locks (
  id TEXT PRIMARY KEY,
  locked_until_utc TEXT NOT NULL
);
