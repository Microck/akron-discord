import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AkronDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(path: string) {
  const directory = dirname(path);
  const directoryAlreadyExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!directoryAlreadyExisted) {
    chmodSync(directory, 0o700);
  }
  const sqlite = new Database(path);
  chmodSync(path, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  for (const sqlitePath of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(sqlitePath)) {
      chmodSync(sqlitePath, 0o600);
    }
  }
  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}

const backupFilePattern = /^akron-\d{4}-\d{2}-\d{2}\.sqlite$/;

// Writes one snapshot per UTC day to `<database dir>/backups` and keeps the
// newest `keep` days. better-sqlite3's backup() uses SQLite's online backup
// API, so the copy is consistent while the bot keeps writing; copying the file
// directly can miss pages that still live in the -wal file. A later run on the
// same day replaces that day's snapshot, so restarts do not evict older days.
// The snapshots share the bot's disk: copy the directory off-host for
// protection against losing the VPS itself.
export async function backupDatabase(sqlite: Database.Database, now = new Date(), keep = 14): Promise<string> {
  const directory = join(dirname(sqlite.name), "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = join(directory, `akron-${now.toISOString().slice(0, 10)}.sqlite`);
  await sqlite.backup(target);
  chmodSync(target, 0o600);

  // ISO dates sort lexically, so everything before the newest `keep` names is older.
  const snapshots = readdirSync(directory).filter(name => backupFilePattern.test(name)).sort();
  for (const name of snapshots.slice(0, -keep)) {
    rmSync(join(directory, name));
  }
  return target;
}

function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_states (
      discord_thread_id TEXT PRIMARY KEY,
      parent_channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT,
      map_url TEXT,
      map_sid TEXT,
      title TEXT NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      github_issue_number INTEGER,
      r2_pack_key TEXT,
      r2_image_key TEXT,
      last_scanned_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      account_age_days INTEGER NOT NULL,
      verified_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upload_discord_publications (
      submission_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      updated_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS github_links (
      discord_thread_id TEXT PRIMARY KEY,
      github_issue_number INTEGER NOT NULL UNIQUE,
      github_issue_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      received_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playtester_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      status TEXT NOT NULL,
      review_thread_id TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL,
      contribution TEXT NOT NULL,
      availability TEXT NOT NULL,
      denial_reason TEXT NOT NULL DEFAULT '',
      created_utc TEXT NOT NULL,
      decided_utc TEXT,
      decided_by TEXT NOT NULL DEFAULT ''
    );
    DROP INDEX IF EXISTS playtester_applications_one_open_idx;
    CREATE UNIQUE INDEX playtester_applications_one_open_idx
      ON playtester_applications(user_id)
      WHERE status IN ('creating_thread', 'open', 'accepting', 'denying');

    CREATE TABLE IF NOT EXISTS tracked_playtesters (
      user_id TEXT PRIMARY KEY,
      accepted_application_id INTEGER NOT NULL,
      accepted_utc TEXT NOT NULL,
      missed_releases INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS playtest_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      attachment_name TEXT NOT NULL,
      created_utc TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS playtest_releases_message_idx
      ON playtest_releases(message_id);

    CREATE TABLE IF NOT EXISTS playtest_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      release_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_utc TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS playtest_activity_user_release_kind_idx
      ON playtest_activity(user_id, release_id, kind);
  `);
}
