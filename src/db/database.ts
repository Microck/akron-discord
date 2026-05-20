import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type AkronDatabase = ReturnType<typeof createDatabase>["db"];

export function createDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);
  return {
    sqlite,
    db: drizzle(sqlite, { schema })
  };
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

    CREATE TABLE IF NOT EXISTS catalog_entries (
      id TEXT PRIMARY KEY,
      discord_thread_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      section TEXT NOT NULL,
      map_sid TEXT NOT NULL,
      map_url TEXT NOT NULL,
      download_url TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_avatar_url TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      download_count INTEGER NOT NULL DEFAULT 0,
      updated_utc TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS map_mappings (
      map_url TEXT PRIMARY KEY,
      map_sid TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_utc TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS github_links (
      discord_thread_id TEXT PRIMARY KEY,
      github_issue_number INTEGER NOT NULL UNIQUE,
      github_issue_url TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_utc TEXT NOT NULL
    );
  `);
}
