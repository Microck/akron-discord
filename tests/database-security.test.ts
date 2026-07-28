import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/database.js";
import { claimGithubDelivery } from "../src/github-webhook.js";
import { logAudit } from "../src/services/audit.js";
import { createPlaytesterApplicationReview, recoverPlaytesterApplicationReview } from "../src/services/playtesting.js";

describe("database filesystem security", () => {
  it("retains recent webhook replay records and removes expired records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-webhook-retention-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      const insert = database.sqlite.prepare(
        "INSERT INTO github_webhook_deliveries (delivery_id, event_name, received_utc) VALUES (?, 'issues', ?)"
      );
      insert.run("expired", "2025-12-01T00:00:00.000Z");
      insert.run("recent", "2026-01-15T00:00:00.000Z");

      expect(await claimGithubDelivery(
        database.db,
        "current",
        "issues",
        new Date("2026-02-01T00:00:00.000Z")
      )).toBe(true);
      expect(await claimGithubDelivery(
        database.db,
        "recent",
        "issues",
        new Date("2026-02-01T00:00:00.000Z")
      )).toBe(false);
      expect(database.sqlite.prepare(
        "SELECT delivery_id FROM github_webhook_deliveries ORDER BY delivery_id"
      ).all()).toEqual([
        { delivery_id: "current" },
        { delivery_id: "recent" }
      ]);
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restricts the data directory and SQLite files to the bot account", () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-database-"));
    const databasePath = join(directory, "private", "akron.sqlite");
    const database = createDatabase(databasePath);
    try {
      expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not change permissions on an existing shared parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-shared-database-"));
    chmodSync(directory, 0o755);
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      expect(statSync(directory).mode & 0o777).toBe(0o755);
      expect(statSync(join(directory, "akron.sqlite")).mode & 0o777).toBe(0o600);
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("enforces one open or transitional playtester application per user", () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-applications-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      const insert = database.sqlite.prepare([
        "INSERT INTO playtester_applications",
        "(user_id, username, status, why, contribution, availability, created_utc)",
        "VALUES (?, 'user', ?, 'why', 'contribution', 'availability', '2026-01-01T00:00:00Z')"
      ].join(" "));
      insert.run("user-1", "open");
      expect(() => insert.run("user-1", "creating_thread")).toThrow(/unique/i);
      database.sqlite.prepare("UPDATE playtester_applications SET status = 'accepted' WHERE user_id = ?").run("user-1");
      expect(() => insert.run("user-1", "open")).not.toThrow();
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the application row when Discord thread creation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-application-create-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      await expect(createPlaytesterApplicationReview({
        db: database.db,
        application: applicationInput("user-create-failure"),
        async createThread(): Promise<never> { throw new Error("Discord thread failed."); }
      })).rejects.toThrow("Discord thread failed");
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM playtester_applications").get()).toEqual({ count: 0 });
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deletes a created thread when its id cannot be persisted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-application-compensate-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    let deleted = 0;
    try {
      database.sqlite.exec([
        "CREATE TRIGGER fail_thread_id BEFORE UPDATE ON playtester_applications",
        "WHEN NEW.review_thread_id != '' BEGIN SELECT RAISE(ABORT, 'thread id failed'); END;"
      ].join(" "));
      await expect(createPlaytesterApplicationReview({
        db: database.db,
        application: applicationInput("user-thread-id-failure"),
        async createThread() {
          return { id: "thread", async delete() { deleted += 1; } };
        }
      })).rejects.toThrow("thread id failed");
      expect(deleted).toBe(1);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM playtester_applications").get()).toEqual({ count: 0 });
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers a durable creating-thread transition after the final DB update fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-application-recover-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      database.sqlite.exec([
        "CREATE TRIGGER fail_open BEFORE UPDATE ON playtester_applications",
        "WHEN NEW.status = 'open' BEGIN SELECT RAISE(ABORT, 'open failed'); END;"
      ].join(" "));
      await expect(createPlaytesterApplicationReview({
        db: database.db,
        application: applicationInput("user-recover"),
        async createThread() { return { id: "thread-recover", async delete() {} }; }
      })).rejects.toThrow("open failed");
      expect(database.sqlite.prepare("SELECT status, review_thread_id FROM playtester_applications").get())
        .toEqual({ status: "creating_thread", review_thread_id: "thread-recover" });

      database.sqlite.exec("DROP TRIGGER fail_open");
      expect(await recoverPlaytesterApplicationReview({
        db: database.db, userId: "user-recover", async threadExists(threadId) { return threadId === "thread-recover"; }
      })).toBe("recovered");
      expect(database.sqlite.prepare("SELECT status FROM playtester_applications").get()).toEqual({ status: "open" });
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("discovers a created review thread after a crash before its id was persisted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-application-discover-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      const inserted = database.sqlite.prepare([
        "INSERT INTO playtester_applications",
        "(user_id, username, status, why, contribution, availability, created_utc)",
        "VALUES ('user-discover', 'user', 'creating_thread', 'why', 'contribution', 'availability', '2026-01-01T00:00:00Z')"
      ].join(" ")).run();
      const applicationId = Number(inserted.lastInsertRowid);

      expect(await recoverPlaytesterApplicationReview({
        db: database.db,
        userId: "user-discover",
        async findThreadId(id) { return id === applicationId ? "discovered-thread" : undefined; },
        async threadExists(threadId) { return threadId === "discovered-thread"; }
      })).toBe("recovered");
      expect(database.sqlite.prepare("SELECT status, review_thread_id FROM playtester_applications").get())
        .toEqual({ status: "open", review_thread_id: "discovered-thread" });
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not reclassify a completed side effect when audit persistence fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-audit-failure-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    database.sqlite.close();
    await expect(logAudit(database.db, {
      actorId: "moderator", action: "upload_discord_publish", target: "submission"
    })).resolves.toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });
});

function applicationInput(userId: string) {
  return { userId, username: userId, why: "why", contribution: "contribution", availability: "availability" };
}
