ALTER TABLE upload_submissions ADD COLUMN attribution_discord_user_id TEXT;
ALTER TABLE upload_submissions ADD COLUMN queued_utc TEXT;
ALTER TABLE upload_submissions ADD COLUMN moderation_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS upload_submissions_attribution_idx
  ON upload_submissions (attribution_discord_user_id, status, updated_utc);

CREATE TABLE IF NOT EXISTS upload_quota_reservations (
  id TEXT PRIMARY KEY,
  install_id_hash TEXT NOT NULL,
  network_key_hash TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  created_utc TEXT NOT NULL,
  expires_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_quota_install_idx
  ON upload_quota_reservations (install_id_hash, created_utc);

CREATE INDEX IF NOT EXISTS upload_quota_network_idx
  ON upload_quota_reservations (network_key_hash, created_utc);

CREATE INDEX IF NOT EXISTS upload_quota_expiry_idx
  ON upload_quota_reservations (expires_utc);

CREATE TABLE IF NOT EXISTS upload_attribution_deliveries (
  discord_user_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  delivered_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_attribution_delivery_expiry_idx
  ON upload_attribution_deliveries (delivered_utc);
