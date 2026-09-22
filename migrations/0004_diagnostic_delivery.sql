CREATE TABLE diagnostic_deliveries (
  report_id TEXT PRIMARY KEY,
  accepted_utc TEXT NOT NULL,
  available_utc TEXT NOT NULL,
  claim_token TEXT,
  claim_until_utc TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_utc TEXT,
  delivered_utc TEXT,
  discord_message_id TEXT
);

CREATE INDEX diagnostic_deliveries_pending_idx
  ON diagnostic_deliveries (available_utc, report_id)
  WHERE delivered_utc IS NULL;
