import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CloudflareUploadStore } from "../src/upload-worker-cloudflare.js";
import type { UploadBatchRecord, UploadObjectRecord, UploadSubmissionRecord } from "../src/upload-worker.js";

class TestD1Statement {
  constructor(private readonly owner: TestD1, private readonly database: Database.Database, private readonly query: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]): TestD1Statement { return new TestD1Statement(this.owner, this.database, this.query, values); }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.database.prepare(this.query).all(...this.values) as T[] }; }
  async run(): Promise<{ meta: { changes: number } }> { return this.runSync(); }
  runSync(): { meta: { changes: number } } {
    const result = { meta: { changes: this.database.prepare(this.query).run(...this.values).changes } };
    this.owner.afterRun?.(this.query);
    return result;
  }
}

class TestD1 {
  afterRun?: (query: string) => void;
  constructor(readonly sqlite: Database.Database) {}
  prepare(query: string): TestD1Statement { return new TestD1Statement(this, this.sqlite, query); }
  async batch(statements: TestD1Statement[]): Promise<Array<{ meta: { changes: number } }>> {
    return this.sqlite.transaction(() => statements.map(statement => statement.runSync()))();
  }
}

class TestR2 {
  readonly objects = new Map<string, Buffer>();
  failPutAt = 0;
  failPutKey = "";
  private putCount = 0;
  async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string): Promise<void> {
    this.putCount += 1;
    if (this.failPutAt === this.putCount || this.failPutKey === key) throw new Error("R2 put failed.");
    this.objects.set(key, typeof value === "string" ? Buffer.from(value) : Buffer.from(value as ArrayBuffer));
  }
  async get(key: string): Promise<null | { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from(bytes));
          controller.close();
        }
      }),
      async arrayBuffer(): Promise<ArrayBuffer> {
        return Uint8Array.from(bytes).buffer;
      }
    };
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

describe("Cloudflare upload store consistency", () => {
  it("keeps concurrent sibling reservations consistent in normalized rows and payload JSON", async () => {
    const { store, d1 } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "queued");
    await store.putBatch(batch);

    const [first, second] = await Promise.all([
      store.tryReserveModerationAction(batch, "submission-a", new Date("2026-01-02T00:00:00.000Z")),
      store.tryReserveModerationAction(batch, "submission-b", new Date("2026-01-02T00:00:00.000Z"))
    ]);
    const saved = await store.getBatch(batch.id);
    const rows = d1.sqlite.prepare("SELECT id, status FROM upload_submissions ORDER BY id").all() as Array<{ id: string; status: string }>;

    expect([first, second]).toEqual([true, true]);
    expect(saved?.submissions.map(submission => [submission.id, submission.status])).toEqual([
      ["submission-a", "moderating"],
      ["submission-b", "moderating"]
    ]);
    expect(rows).toEqual([
      { id: "submission-a", status: "moderating" },
      { id: "submission-b", status: "moderating" }
    ]);
  });

  it("reclaims abandoned queued and reviewing quarantine objects but preserves active reviews", async () => {
    const { store, quarantine } = testStore();
    const now = new Date("2026-02-01T00:00:00.000Z");
    for (const [id, updatedUtc, status] of [
      ["old-queued", "2026-01-01T00:00:00.000Z", "queued"],
      ["old-review", "2026-01-01T00:00:00.000Z", "reviewing"],
      ["old-moderating", "2026-01-01T00:00:00.000Z", "moderating"],
      ["active-review", "2026-01-31T23:00:00.000Z", "reviewing"]
    ] as const) {
      const batch = uploadBatch(updatedUtc, status, id);
      await store.putBatch(batch);
      const object = uploadObject(id);
      await store.putObject(object);
      quarantine.objects.set(`quarantine/uploads/${id}/${object.id}`, Buffer.from("quarantine"));
    }

    expect(await store.cleanupExpired(now, 10)).toBe(3);
    expect(await store.getBatch("old-queued")).toBeUndefined();
    expect(await store.getBatch("old-review")).toBeUndefined();
    expect(await store.getBatch("old-moderating")).toBeUndefined();
    expect(await store.getBatch("active-review")).toBeDefined();
    expect([...quarantine.objects.keys()]).toEqual(["quarantine/uploads/active-review/object-active-review"]);
  });

  it("preserves a published sibling while withdrawing an abandoned review", async () => {
    const { store, quarantine } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "reviewing", "mixed");
    batch.submissions[0]!.status = "published";
    batch.submissions[0]!.publication = {
      packId: "published-pack", packKey: "packs/map/published.akr", downloadUrl: "https://example/published.akr",
      images: [], publishedUtc: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64), sizeBytes: 64
    };
    batch.submissions[1]!.queuedUtc = "2026-01-01T00:00:00.000Z";
    await store.putBatch(batch);
    const object = uploadObject(batch.id);
    await store.putObject(object);
    quarantine.objects.set(`quarantine/uploads/${batch.id}/${object.id}`, Buffer.from("quarantine"));

    expect(await store.cleanupExpired(new Date("2026-02-01T00:00:00.000Z"), 10)).toBe(1);
    const saved = await store.getBatch(batch.id);
    expect(saved?.status).toBe("published");
    expect(saved?.submissions.map(submission => submission.status)).toEqual(["published", "withdrawn"]);
    expect(quarantine.objects.size).toBe(0);
  });

  it("uses queued age rather than refreshed delivery timestamps for retention", async () => {
    const { store } = testStore();
    const batch = uploadBatch("2026-01-31T23:00:00.000Z", "reviewing", "churned");
    for (const item of batch.submissions) item.queuedUtc = "2026-01-01T00:00:00.000Z";
    await store.putBatch(batch);

    expect(await store.cleanupExpired(new Date("2026-02-01T00:00:00.000Z"), 10)).toBe(1);
    expect(await store.getBatch(batch.id)).toBeUndefined();
  });

  it("reclaims a stale moderating lease for retry", async () => {
    const { store } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "moderating");
    for (const submission of batch.submissions) submission.reviewClaimedUtc = "2026-01-01T00:00:00.000Z";
    await store.putBatch(batch);

    const jobs = await store.claimModerationJobs(10, new Date("2026-01-01T00:16:00.000Z"));

    expect(jobs).toHaveLength(2);
    expect(jobs.every(job => job.submission.status === "reviewing")).toBe(true);
  });

  it("merges concurrent same-submission field updates under the batch lock", async () => {
    const { store } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "reviewing");
    await store.putBatch(batch);
    await Promise.all([
      store.recordAiReview({
        submissionId: "submission-a", now: new Date("2026-01-02T00:00:00.000Z"),
        review: { decision: "allow", severity: "low", reasons: [] }
      }),
      store.recordDiscordMessage({
        submissionId: "submission-a", kind: "review", now: new Date("2026-01-02T00:00:00.000Z"),
        message: { guildId: "guild", channelId: "channel", messageId: "message" }
      })
    ]);

    const saved = (await store.findSubmission("submission-a"))?.submission;
    expect(saved?.aiReview?.decision).toBe("allow");
    expect(saved?.discord?.review?.messageId).toBe("message");
  });

  it("rolls back a partially written public publication", async () => {
    const { store, quarantine, publicBucket } = testStore();
    const item = submission("submission", "batch", "moderating");
    item.captures = [{
      objectId: "capture", roomName: "room",
      optimized: { r2Key: "optimized/capture.webp", contentType: "image/webp", uploadedBytes: 3, extension: "webp" }
    }];
    quarantine.objects.set("optimized/capture.webp", Buffer.from("webp"));
    publicBucket.failPutAt = 2;

    await expect(store.publishCatalogEntry({
      submission: item,
      pack: {
        id: "pack", tokenHash: "token", kind: "pack", batchId: "batch", submissionId: item.id,
        maxBytes: 64, contentType: "application/octet-stream", uploadedBytes: 64, bytes: Buffer.alloc(64)
      },
      captures: [{
        id: "capture", tokenHash: "token", kind: "capture", batchId: "batch", maxBytes: 4,
        contentType: "image/webp", uploadedBytes: 4
      }],
      captureSourceUrls: [""],
      now: new Date("2026-01-02T00:00:00.000Z")
    })).rejects.toThrow("R2 put failed");
    expect(publicBucket.objects.size).toBe(0);
  });

  it("preserves pre-existing content-addressed assets when retry metadata fails", async () => {
    const { store, quarantine, publicBucket } = testStore();
    const item = submission("submission", "batch", "moderating");
    item.captures = [{
      objectId: "capture", roomName: "room",
      optimized: { r2Key: "optimized/capture.webp", contentType: "image/webp", uploadedBytes: 4, extension: "webp" }
    }];
    quarantine.objects.set("optimized/capture.webp", Buffer.from("webp"));
    const input = {
      submission: item,
      pack: {
        id: "pack", tokenHash: "token", kind: "pack" as const, batchId: "batch", submissionId: item.id,
        maxBytes: 64, contentType: "application/octet-stream", uploadedBytes: 64, bytes: Buffer.alloc(64)
      },
      captures: [{
        id: "capture", tokenHash: "token", kind: "capture" as const, batchId: "batch", maxBytes: 4,
        contentType: "image/webp", uploadedBytes: 4
      }],
      captureSourceUrls: [""],
      now: new Date("2026-01-02T00:00:00.000Z")
    };
    const publication = await store.publishCatalogEntry(input);
    input.pack.bytes = Buffer.alloc(64, 1);
    publicBucket.failPutKey = "catalog/index.json";

    await expect(store.publishCatalogEntry(input)).rejects.toThrow("R2 put failed");

    expect(publicBucket.objects.has(publication.packKey)).toBe(true);
    expect(publicBucket.objects.has(publication.images[0]!.key)).toBe(true);
    expect(publicBucket.objects.get(publication.packKey)).toEqual(Buffer.alloc(64));
  });

  it("restores the prior catalog row when an updated index write fails", async () => {
    const { store, d1, publicBucket } = testStore();
    const oldEntry = catalogPack("Old title", "2026-01-01T00:00:00.000Z");
    const newEntry = catalogPack("New title", "2026-01-02T00:00:00.000Z");
    await store.publishCatalogMetadata(oldEntry);
    publicBucket.failPutAt = 2;

    await expect(store.publishCatalogMetadata(newEntry)).rejects.toThrow("R2 put failed");

    const row = d1.sqlite.prepare("SELECT entry_json FROM upload_catalog_entries WHERE id = ?")
      .get(oldEntry.id) as { entry_json: string };
    expect(JSON.parse(row.entry_json)).toEqual(oldEntry);
    const index = JSON.parse(publicBucket.objects.get("catalog/index.json")?.toString("utf8") ?? "{}") as { packs?: Array<{ title: string }> };
    expect(index.packs?.[0]?.title).toBe("Old title");
  });

  it("restores a deleted catalog row when the index write fails", async () => {
    const { store, d1, publicBucket } = testStore();
    const entry = catalogPack("Published title", "2026-01-01T00:00:00.000Z");
    await store.publishCatalogMetadata(entry);
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "published");
    batch.submissions = [submission("submission-a", batch.id, "published")];
    batch.submissions[0]!.publication = {
      packId: entry.id, packKey: "packs/map/pack.akr", downloadUrl: entry.downloadUrl,
      images: [], publishedUtc: entry.updatedUtc, sha256: entry.sha256, sizeBytes: entry.sizeBytes
    };
    await store.putBatch(batch);
    publicBucket.failPutAt = 2;

    await expect(store.deleteSubmission({
      submissionId: "submission-a", now: new Date("2026-01-02T00:00:00.000Z")
    })).rejects.toThrow("R2 put failed");

    const row = d1.sqlite.prepare("SELECT entry_json FROM upload_catalog_entries WHERE id = ?")
      .get(entry.id) as { entry_json: string };
    expect(JSON.parse(row.entry_json)).toEqual(entry);
    const nextEntry = catalogPack("Unrelated title", "2026-01-03T00:00:00.000Z", "unrelated-pack");
    await store.publishCatalogMetadata(nextEntry);
    const index = JSON.parse(publicBucket.objects.get("catalog/index.json")?.toString("utf8") ?? "{}") as { packs?: Array<{ id: string }> };
    expect(index.packs?.map(pack => pack.id)).toEqual([entry.id, nextEntry.id]);
  });

  it("refuses to write the public index after catalog lock ownership is lost", async () => {
    const { store, d1, publicBucket } = testStore();
    d1.afterRun = query => {
      if (!query.startsWith("INSERT INTO upload_catalog_entries")) return;
      d1.afterRun = undefined;
      d1.sqlite.prepare("UPDATE upload_catalog_locks SET owner_token = ?, locked_until_utc = ? WHERE id = ?")
        .run("new-owner", "2099-01-01T00:00:00.000Z", "catalog-index");
    };

    await expect(store.publishCatalogMetadata(
      catalogPack("Stale writer", "2026-01-01T00:00:00.000Z")
    )).rejects.toThrow("Lost durable lock catalog-index");
    expect(publicBucket.objects.has("catalog/index.json")).toBe(false);
  });

  it("deletes a newly optimized object when the payload transaction fails", async () => {
    const { store, d1, quarantine } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "reviewing");
    batch.submissions[0]!.captures = [{ objectId: "capture", roomName: "room" }];
    await store.putBatch(batch);
    d1.sqlite.exec([
      "CREATE TRIGGER fail_payload BEFORE UPDATE ON upload_batches",
      "BEGIN SELECT RAISE(ABORT, 'payload failed'); END;"
    ].join(" "));

    await expect(store.putOptimizedCapture({
      submissionId: "submission-a", objectId: "capture", bytes: Buffer.from("webp"),
      contentType: "image/webp", now: new Date("2026-01-02T00:00:00.000Z")
    })).rejects.toThrow("payload failed");
    expect([...quarantine.objects.keys()].filter(key => key.includes("optimized-captures"))).toEqual([]);
  });
});

function testStore(): { store: CloudflareUploadStore; d1: TestD1; quarantine: TestR2; publicBucket: TestR2 } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync("migrations/0001_uploads.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_runtime_security.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_catalog_lock_ownership.sql", "utf8"));
  const d1 = new TestD1(sqlite);
  const quarantine = new TestR2();
  const publicBucket = new TestR2();
  return { store: new CloudflareUploadStore(d1 as never, quarantine as never, publicBucket as never), d1, quarantine, publicBucket };
}

function uploadBatch(updatedUtc: string, status: UploadBatchRecord["status"], id = "batch"): UploadBatchRecord {
  const suffix = id === "batch" ? "" : `-${id}`;
  return {
    id, installIdHash: "install", termsVersion: 1, status, createdUtc: updatedUtc, updatedUtc,
    expiresUtc: "2026-12-01T00:00:00.000Z",
    submissions: [submission(`submission-a${suffix}`, id, status), submission(`submission-b${suffix}`, id, status)]
  };
}

function catalogPack(title: string, updatedUtc: string, id = "pack") {
  return {
    id,
    title,
    description: "Description",
    section: "StartPos" as const,
    mapSid: "Map/Sid",
    mapUrl: "https://gamebanana.com/mods/150453",
    downloadUrl: "https://cdn.example/pack.akr",
    authorName: "Author",
    authorAvatarUrl: "",
    imageUrl: "",
    images: [],
    downloadCount: 0,
    updatedUtc,
    tags: [],
    sha256: "a".repeat(64),
    sizeBytes: 64
  };
}

function submission(id: string, batchId: string, status: UploadSubmissionRecord["status"]): UploadSubmissionRecord {
  return {
    id, batchId, section: "StartPos", mapSid: "Map/Sid", mapUrl: "", title: id, description: "",
    packObjectId: `pack-${id}`, captures: [], attribution: { mode: "anonymous" }, status, validationReasons: []
  };
}

function uploadObject(batchId: string): UploadObjectRecord {
  return {
    id: `object-${batchId}`, tokenHash: "token", kind: "pack", batchId, submissionId: `submission-a-${batchId}`,
    maxBytes: 100, contentType: "application/octet-stream", uploadedBytes: 10
  };
}
