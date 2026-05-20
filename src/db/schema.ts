import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const botSettings = sqliteTable("bot_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedUtc: text("updated_utc").notNull()
});

export const scanStates = sqliteTable("scan_states", {
  discordThreadId: text("discord_thread_id").primaryKey(),
  parentChannelId: text("parent_channel_id").notNull(),
  authorId: text("author_id").notNull(),
  status: text("status").notNull(),
  scope: text("scope"),
  mapUrl: text("map_url"),
  mapSid: text("map_sid"),
  title: text("title").notNull(),
  reasonsJson: text("reasons_json").notNull().default("[]"),
  githubIssueNumber: integer("github_issue_number"),
  r2PackKey: text("r2_pack_key"),
  r2ImageKey: text("r2_image_key"),
  lastScannedUtc: text("last_scanned_utc").notNull()
});

export const catalogEntries = sqliteTable(
  "catalog_entries",
  {
    id: text("id").primaryKey(),
    discordThreadId: text("discord_thread_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    section: text("section").notNull(),
    mapSid: text("map_sid").notNull(),
    mapUrl: text("map_url").notNull(),
    downloadUrl: text("download_url").notNull(),
    authorName: text("author_name").notNull(),
    authorAvatarUrl: text("author_avatar_url").notNull().default(""),
    imageUrl: text("image_url").notNull().default(""),
    downloadCount: integer("download_count").notNull().default(0),
    updatedUtc: text("updated_utc").notNull(),
    tagsJson: text("tags_json").notNull().default("[]")
  },
  table => ({
    discordThreadIdIdx: uniqueIndex("catalog_entries_discord_thread_id_idx").on(table.discordThreadId)
  })
);

export const mapMappings = sqliteTable("map_mappings", {
  mapUrl: text("map_url").primaryKey(),
  mapSid: text("map_sid").notNull(),
  displayName: text("display_name").notNull(),
  createdBy: text("created_by").notNull(),
  createdUtc: text("created_utc").notNull()
});

export const verificationLogs = sqliteTable("verification_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  accountAgeDays: integer("account_age_days").notNull(),
  verifiedUtc: text("verified_utc").notNull()
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  createdUtc: text("created_utc").notNull()
});

export const githubLinks = sqliteTable(
  "github_links",
  {
    discordThreadId: text("discord_thread_id").primaryKey(),
    githubIssueNumber: integer("github_issue_number").notNull(),
    githubIssueUrl: text("github_issue_url").notNull(),
    kind: text("kind").notNull(),
    createdUtc: text("created_utc").notNull()
  },
  table => ({
    issueNumberIdx: uniqueIndex("github_links_issue_number_idx").on(table.githubIssueNumber)
  })
);
