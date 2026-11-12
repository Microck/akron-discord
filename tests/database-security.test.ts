import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { backupDatabase, createDatabase } from "../src/db/database.js";
import { logAudit } from "../src/services/audit.js";
import { createPlaytesterApplicationReview, recoverPlaytesterApplicationReview } from "../src/services/playtesting.js";

describe("database backups", () => {
  it("keeps one private snapshot per day, refreshes today's, and prunes the oldest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "akron-backup-"));
    const database = createDatabase(join(directory, "akron.sqlite"));
    try {
      for (const day of ["2026-05-01", "2026-05-02", "2026-05-03"]) {
        await backupDatabase(database.sqlite, new Date(`${day}T12:00:00Z`), 2);
      }
      await logAudit(database.db, { actorId: "user", action: "after_first_backup", target: "t" });
      const latest = await backupDatabase(database.sqlite, new Date("2026-05-03T23:00:00Z"), 2);

      const backups = join(directory, "backups");
      expect(readdirSync(backups).sort()).toEqual(["akron-2026-05-02.sqlite", "akron-2026-05-03.sqlite"]);
      expect(statSync(backups).mode & 0o777).toBe(0o700);
      expect(statSync(latest).mode & 0o777).toBe(0o600);
      const snapshot = new Database(latest, { readonly: true });
      try {
        expect(snapshot.prepare("SELECT action FROM audit_logs").pluck().all()).toContain("after_first_backup");
      } finally {
        snapshot.close();
      }
    } finally {
      database.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("database filesystem security", () => {
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
