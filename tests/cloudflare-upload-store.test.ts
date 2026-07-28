import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import uploadWorker, { CloudflareUploadStore, type CloudflareUploadEnv } from "../src/upload-worker-cloudflare.js";
import { signBotRequest, type UploadBatchRecord, type UploadObjectRecord, type UploadSubmissionRecord } from "../src/upload-worker.js";
import { diagnosticClaimLeaseMs, diagnosticMaxBytes, type DiagnosticReport } from "../src/upload-diagnostics.js";
import { ChannelType, Collection, EmbedBuilder, type Message, type MessageCreateOptions } from "discord.js";
import { diagnosticChannelId, type AppConfig } from "../src/config.js";
import { createUploadWorkerClient } from "../src/services/upload-worker-client.js";
import { pollDiagnosticQueue } from "../src/services/diagnostic-delivery.js";

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
  beforePut?: () => Promise<void>;
  private putCount = 0;
  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string,
    options?: { onlyIf?: { etagDoesNotMatch: string } }
  ): Promise<object | null> {
    this.putCount += 1;
    if (this.failPutAt === this.putCount || this.failPutKey === key) throw new Error("R2 put failed.");
    await this.beforePut?.();
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    this.objects.set(key, typeof value === "string" ? Buffer.from(value) : Buffer.from(value as ArrayBuffer));
    return {};
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
  it("rejects streamed uploads whose body length differs from the declaration", async () => {
    const { store, quarantine } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "prepared", "declared-length");
    const object = uploadObject(batch.id);
    delete object.uploadedBytes;
    await store.putBatch(batch);
    await store.putObject(object);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.close();
      }
    });

    await expect(store.putUploadedObject(object.id, {
      body,
      contentType: "application/octet-stream",
      declaredBytes: 4
    })).rejects.toThrow("Upload body length 3 does not match declared length 4.");
    expect((await store.getObject(object.id, { includeBytes: false }))?.uploadedBytes).toBeUndefined();
    expect(quarantine.objects.size).toBe(0);
  });

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

  it("adds the public Discord thread to an already published catalog entry", async () => {
    const { store, publicBucket } = testStore();
    const batch = uploadBatch("2026-01-01T00:00:00.000Z", "published");
    batch.submissions[0]!.publication = {
      packId: "pack",
      packKey: "packs/map/pack.akr",
      downloadUrl: "https://akron.example.test/maps/map/pack.akr",
      publishedUtc: "2026-01-01T00:00:00.000Z",
      sha256: "a".repeat(64),
      sizeBytes: 64,
      images: []
    };
    await store.putBatch(batch);
    await store.publishCatalogMetadata(catalogPack("Published pack", "2026-01-01T00:00:00.000Z"));

    await store.recordDiscordMessage({
      submissionId: "submission-a",
      kind: "publication",
      message: {
        guildId: "123456789012345678",
        channelId: "345678901234567890",
        threadId: "234567890123456789",
        messageId: "456789012345678901"
      },
      now: new Date("2026-01-02T00:00:00.000Z")
    });

    const index = JSON.parse(publicBucket.objects.get("catalog/index.json")!.toString("utf8")) as {
      packs: Array<{ discordUrl: string }>;
    };
    expect(index.packs[0]?.discordUrl)
      .toBe("https://discord.com/channels/123456789012345678/234567890123456789");
  });

  it("rolls back a partially written public publication", async () => {
    const { store, publicBucket } = testStore();
    const item = submission("submission", "batch", "moderating");
    item.captures = [{ objectId: "capture", roomName: "room" }];
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
      captureSourceUrls: ["https://uploads.example.test/uploads/source/capture"],
      optimizeCatalogCapture: async () => catalogJpeg(),
      authorName: "Anonymous",
      authorAvatarUrl: "",
      now: new Date("2026-01-02T00:00:00.000Z")
    })).rejects.toThrow("R2 put failed");
    expect(publicBucket.objects.size).toBe(0);
  });

  it("preserves pre-existing content-addressed assets when retry metadata fails", async () => {
    const { store, publicBucket } = testStore();
    const item = submission("submission", "batch", "moderating");
    item.captures = [{ objectId: "capture", roomName: "room" }];
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
      captureSourceUrls: ["https://uploads.example.test/uploads/source/capture"],
      optimizeCatalogCapture: async () => catalogJpeg(),
      authorName: "Anonymous",
      authorAvatarUrl: "",
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

  it("rejects an unsafe Discord URL already persisted in the public index", async () => {
    const { store, publicBucket } = testStore();
    const unsafePack = {
      ...catalogPack("Unsafe pack", "2026-01-01T00:00:00.000Z"),
      discordUrl: "https://example.com/channels/123/456"
    };
    publicBucket.objects.set("catalog/index.json", Buffer.from(JSON.stringify({
      format: "akron-community-pack-index-v3",
      version: 3,
      packs: [unsafePack]
    })));

    await expect(store.publishCatalogMetadata(
      catalogPack("Replacement", "2026-01-02T00:00:00.000Z")
    )).rejects.toThrow("unsupported format");
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

});

function testStore(): { store: CloudflareUploadStore; d1: TestD1; quarantine: TestR2; publicBucket: TestR2 } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(readFileSync("migrations/0001_uploads.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0002_runtime_security.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0003_catalog_lock_ownership.sql", "utf8"));
  sqlite.exec(readFileSync("migrations/0004_diagnostic_delivery.sql", "utf8"));
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
    discordUrl: "",
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

function catalogJpeg(): { bytes: Buffer; contentType: "image/jpeg"; extension: "jpg" } {
  return {
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    contentType: "image/jpeg",
    extension: "jpg"
  };
}

describe("Cloudflare private diagnostics", () => {
  it("persists a report privately and returns it only to a signed maintainer request", async () => {
    const { env, quarantine, publicBucket } = diagnosticStore();
    const report = diagnosticReport();
    const submitted = await uploadWorker.fetch(diagnosticRequest(report), env);
    expect(submitted.status).toBe(201);
    await expect(submitted.json()).resolves.toEqual({ reportId: report.reportId, status: "received" });
    expect([...quarantine.objects.keys()]).toEqual([`diagnostics/v1/${report.reportId}.json`]);
    expect(publicBucket.objects.size).toBe(0);

    for (const path of [`/uploads/diagnostics/${report.reportId}`, `/diagnostics/v1/${report.reportId}.json`, `/bot/diagnostics/${report.reportId}`, "/bot/diagnostics"]) {
      expect((await uploadWorker.fetch(new Request(`https://uploads.test${path}`), env)).status).toBe(404);
    }
    const anonymous = await uploadWorker.fetch(new Request(`https://uploads.test/bot/diagnostics/${report.reportId}`, {
      method: "POST", body: "{}"
    }), env);
    expect(anonymous.status).toBe(401);

    const signed = signedDiagnosticRequest(report.reportId, env.BOT_HMAC_SECRET);
    const replay = signed.clone();
    const retrieved = await uploadWorker.fetch(signed, env);
    expect(retrieved.status).toBe(200);
    expect(retrieved.headers.get("cache-control")).toBe("no-store");
    await expect(retrieved.json()).resolves.toEqual(report);
    const replayed = await uploadWorker.fetch(replay, env);
    expect(replayed.status).toBe(401);
    await expect(replayed.json()).resolves.toEqual({ error: "bot_signature_replayed" });
    const missing = await uploadWorker.fetch(signedDiagnosticRequest("b".repeat(32), env.BOT_HMAC_SECRET), env);
    expect(missing.status).toBe(404);
  });

  it("does not acknowledge success before R2 persistence completes", async () => {
    const { env, quarantine } = diagnosticStore();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    quarantine.beforePut = async () => { entered(); await pending; };
    let settled = false;
    const response = uploadWorker.fetch(diagnosticRequest(diagnosticReport()), env).then(value => {
      settled = true;
      return value;
    });
    await started;
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await response).status).toBe(201);
  });

  it("does not claim receipt after an R2 failure", async () => {
    const { env, quarantine } = diagnosticStore();
    quarantine.failPutAt = 1;
    const response = await uploadWorker.fetch(diagnosticRequest(diagnosticReport()), env);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal_error" });
    expect(quarantine.objects.size).toBe(0);
  });

  it("rejects concurrent report ID reuse without overwriting the winner", async () => {
    const { env } = diagnosticStore();
    const reports = [diagnosticReport(), { ...diagnosticReport(), context: { screen: "different" } }];
    const responses = await Promise.all(reports.map(report => uploadWorker.fetch(diagnosticRequest(report), env)));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = responses.findIndex(response => response.status === 201);
    const conflict = responses.find(response => response.status === 409)!;
    await expect(conflict.json()).resolves.toEqual({ error: "diagnostic_report_exists" });
    const retrieved = await uploadWorker.fetch(signedDiagnosticRequest(reports[0]!.reportId, env.BOT_HMAC_SECRET), env);
    await expect(retrieved.json()).resolves.toEqual(reports[winner]);
  });

  it("uses the existing edge limiter before reading a submission body", async () => {
    const { env, quarantine } = diagnosticStore();
    env.UPLOAD_PREPARE_RATE_LIMITER = { async limit() { return { success: false }; } };
    const response = await uploadWorker.fetch(diagnosticRequest(diagnosticReport()), env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(quarantine.objects.size).toBe(0);
  });

  it.each([undefined, "1"])("cancels oversized streams with content-length %s", async declaredLength => {
    const { env, quarantine } = diagnosticStore();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(diagnosticMaxBytes));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; }
    });
    const request = new Request("https://uploads.test/uploads/diagnostics", {
      method: "POST",
      headers: {
        "content-type": "application/json", "cf-connecting-ip": "192.0.2.1",
        ...(declaredLength ? { "content-length": declaredLength } : {})
      },
      body, duplex: "half"
    } as RequestInit);
    const response = await uploadWorker.fetch(request, env);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(quarantine.objects.size).toBe(0);
  });

  it("rejects oversized declarations without consuming the body", async () => {
    const { env } = diagnosticStore();
    const request = diagnosticRequest(diagnosticReport());
    request.headers.set("content-length", String(diagnosticMaxBytes + 1));
    const response = await uploadWorker.fetch(request, env);
    expect(response.status).toBe(413);
  });

  it.each([
    ["missing description", { description: undefined }],
    ["description type", { description: 42 }],
    ["description UTF-16 limit", { description: "\u{1f680}".repeat(2000) + "x" }],
    ["schema version", { schemaVersion: 2 }],
    ["report ID traversal", { reportId: "../quarantine/uploads/report" }],
    ["UTC timestamp", { createdUtc: "2026-02-30T12:00:00Z" }],
    ["extra report fields", { saves: "must not be persisted" }],
    ["unknown log files", { logs: [{ name: "save.celeste", text: "", truncated: false }] }],
    ["duplicate log files", { logs: Array.from({ length: 2 }, () => ({ name: "log.txt", text: "", truncated: false })) }],
    ["UTF-8 log bytes", { logs: [{ name: "log.txt", text: "é".repeat(524289), truncated: false }] }],
    ["metadata key count", { system: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, "value"])) }],
    ["metadata value size", { versions: { Akron: "x".repeat(1025) } }],
    ["mod count", { mods: Array.from({ length: 1025 }, () => ({ name: "mod", version: "1" })) }],
    ["mod name size", { mods: [{ name: "m".repeat(257), version: "1" }] }]
  ])("rejects invalid %s", async (_name, changes) => {
    const { env, quarantine } = diagnosticStore();
    const response = await uploadWorker.fetch(diagnosticRequest({ ...diagnosticReport(), ...changes }), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_diagnostic_report" });
    expect(quarantine.objects.size).toBe(0);
  });

  it("accepts a log at the UTF-8 byte boundary", async () => {
    const { env } = diagnosticStore();
    const report = diagnosticReport();
    report.logs[0]!.text = "é".repeat(524288);
    expect((await uploadWorker.fetch(diagnosticRequest(report), env)).status).toBe(201);
    const retrieved = await uploadWorker.fetch(signedDiagnosticRequest(report.reportId, env.BOT_HMAC_SECRET), env);
    await expect(retrieved.json()).resolves.toEqual(report);
  });

  it("rejects invalid UTF-8 rather than storing replacement characters", async () => {
    const { env, quarantine } = diagnosticStore();
    const response = await uploadWorker.fetch(new Request("https://uploads.test/uploads/diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
      body: Uint8Array.from([0x22, 0xff, 0x22])
    }), env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_json" });
    expect(quarantine.objects.size).toBe(0);
  });

  it.each(["invalid", "expired", "wrong-path"])("rejects %s bot authorization", async kind => {
    const { env } = diagnosticStore();
    const report = diagnosticReport();
    await uploadWorker.fetch(diagnosticRequest(report), env);
    let signed = signedDiagnosticRequest(
      kind === "wrong-path" ? "b".repeat(32) : report.reportId,
      kind === "invalid" ? "incorrect-secret" : env.BOT_HMAC_SECRET,
      kind === "expired" ? new Date(Date.now() - 10 * 60 * 1000).toISOString() : undefined
    );
    if (kind === "wrong-path") {
      signed = new Request(`https://uploads.test/bot/diagnostics/${report.reportId}`, signed);
    }
    const response = await uploadWorker.fetch(signed, env);
    expect(response.status).toBe(401);
  });

  it.each(["", "x".repeat(4000), "\u{1f680}".repeat(2000)])("preserves descriptions at the UTF-16 boundary", async description => {
    const { env } = diagnosticStore();
    const report = { ...diagnosticReport(), description };
    expect((await uploadWorker.fetch(diagnosticRequest(report), env)).status).toBe(201);
    const retrieved = await uploadWorker.fetch(signedDiagnosticRequest(report.reportId, env.BOT_HMAC_SECRET), env);
    await expect(retrieved.json()).resolves.toEqual(report);
  });

  it("recovers an R2 write whose durable queue insert failed without accepting a changed report", async () => {
    const { env, d1, store } = diagnosticStore();
    const report = diagnosticReport();
    d1.sqlite.exec("CREATE TRIGGER fail_diagnostic_queue BEFORE INSERT ON diagnostic_deliveries BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
    expect((await uploadWorker.fetch(diagnosticRequest(report), env)).status).toBe(500);
    expect(await store.claimDiagnostic(new Date())).toBeNull();
    expect((await uploadWorker.fetch(diagnosticRequest({ ...report, description: "changed" }), env)).status).toBe(409);
    d1.sqlite.exec("DROP TRIGGER fail_diagnostic_queue");
    expect((await uploadWorker.fetch(diagnosticRequest(report), env)).status).toBe(201);
    expect((await store.claimDiagnostic(new Date()))?.reportId).toBe(report.reportId);
  });

  it("excludes concurrent consumers and fences expired owners after a claim is recovered", async () => {
    const { store, d1, quarantine, publicBucket } = diagnosticStore();
    const now = new Date("2026-09-21T12:00:00Z");
    const reportId = diagnosticReport().reportId;
    await store.enqueueDiagnostic(reportId, now);
    const claims = await Promise.all([store.claimDiagnostic(now), store.claimDiagnostic(now)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(job => job !== null)!;
    const recoveredAt = new Date(now.getTime() + diagnosticClaimLeaseMs);
    const restarted = new CloudflareUploadStore(d1 as never, quarantine, publicBucket);
    const recovered = (await restarted.claimDiagnostic(recoveredAt))!;
    expect(recovered.reportId).toBe(first.reportId);
    expect(recovered.firstAttemptUtc).toBe(first.firstAttemptUtc);
    expect(await store.renewDiagnostic(reportId, first.claimToken, recoveredAt)).toBe(false);
    expect(await store.retryDiagnostic(reportId, first.claimToken, recoveredAt)).toBe(false);
    expect(await store.acknowledgeDiagnostic(reportId, first.claimToken, "1551700000000000000", recoveredAt)).toBe(false);
    expect(await restarted.acknowledgeDiagnostic(reportId, recovered.claimToken, "1551700000000000001", recoveredAt)).toBe(true);
    expect(await store.claimDiagnostic(new Date(recoveredAt.getTime() + diagnosticClaimLeaseMs))).toBeNull();
  });

  it("backs off failed delivery without dropping a report after repeated failures", async () => {
    const { store } = diagnosticStore();
    let now = new Date("2026-09-21T12:00:00Z");
    const reportId = diagnosticReport().reportId;
    await store.enqueueDiagnostic(reportId, now);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const job = (await store.claimDiagnostic(now))!;
      expect(job.reportId).toBe(reportId);
      expect(await store.retryDiagnostic(reportId, job.claimToken, now)).toBe(true);
      const delayMs = Math.min(3600, 30 * 2 ** (attempt - 1)) * 1000;
      expect(await store.claimDiagnostic(new Date(now.getTime() + delayMs - 1))).toBeNull();
      now = new Date(now.getTime() + delayMs);
    }
    expect((await store.claimDiagnostic(now))?.reportId).toBe(reportId);
  });

  it("requires authentication on delivery endpoints", async () => {
    const { env } = diagnosticStore();
    for (const suffix of ["claim", `${"a".repeat(32)}/renew`, `${"a".repeat(32)}/retry`, `${"a".repeat(32)}/delivered`]) {
      const response = await uploadWorker.fetch(new Request(`https://uploads.test/bot/diagnostics/${suffix}`, {
        method: "POST", body: "{}"
      }), env);
      expect(response.status).toBe(401);
    }
  });

  it.each(["send-timeout", "acknowledgement-failure"])("reconciles a posted attachment after %s without posting it twice", async failure => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    try {
      const { env, d1 } = diagnosticStore();
      const report = {
        ...diagnosticReport(),
        description: "@everyone <@&1551700000000000000> Repro: https://example.test/video?q=1\n" + "x".repeat(3900),
        context: { mapSid: "Spark in the Machine", room: "CP3-final" },
        versions: { Akron: "0.2.0", Everest: "1.6407.0", Celeste: "1.4.0.0" }
      };
      expect((await uploadWorker.fetch(diagnosticRequest(report), env)).status).toBe(201);
      const config = { discordGuildId: "guild", uploadWorkerUrl: "https://uploads.test", uploadWorkerBotSecret: env.BOT_HMAC_SECRET } as AppConfig;
      const worker = createUploadWorkerClient(config, async (url, init) => uploadWorker.fetch(new Request(url, init), env));
      const messages = new Collection<string, Message>();
      const sent: MessageCreateOptions[] = [];
      const errors: string[] = [];
      const messageId = "1551700000000000000";
      const botId = "1551700000000000001";
      const channel = {
        type: ChannelType.GuildText,
        guildId: "guild",
        permissionsFor: () => ({ has: () => true }),
        messages: { async fetch() { return messages; } },
        async send(message: MessageCreateOptions) {
          sent.push(message);
          messages.set(messageId, {
            id: messageId, author: { id: botId }, createdTimestamp: Date.now(),
            attachments: new Collection([["attachment", { name: `akron-diagnostic-${report.reportId}.json` }]])
          } as Message);
          if (failure === "send-timeout") throw new Error(`Timed out after posting private text: ${report.description}`);
          return { id: messageId };
        }
      };
      const client = {
        user: { id: botId },
        guilds: {
          async fetch() {
            return {
              channels: { async fetch(id: string) { expect(id).toBe(diagnosticChannelId); return channel; } },
              members: { async fetchMe() { return {}; } }
            };
          }
        }
      };
      if (failure === "acknowledgement-failure") {
        d1.sqlite.exec("CREATE TRIGGER fail_diagnostic_ack BEFORE UPDATE OF delivered_utc ON diagnostic_deliveries BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END");
      }
      const input = { client: client as never, config, worker, async onError(error: unknown) { errors.push(String(error)); } };
      await pollDiagnosticQueue(input);
      expect(sent).toHaveLength(1);
      expect(errors.join("\n")).not.toContain(report.description);
      const sentMessage = sent[0]!;
      expect(sentMessage.allowedMentions).toEqual({ parse: [], users: [], roles: [], repliedUser: false });
      const sentEmbed = sentMessage.embeds![0];
      if (!(sentEmbed instanceof EmbedBuilder)) throw new Error("Expected a diagnostic embed.");
      const embed = sentEmbed.toJSON();
      expect(sentMessage.enforceNonce).toBe(true);
      expect(String(sentMessage.nonce).length).toBeLessThanOrEqual(25);
      expect(embed.description).toBe(report.description);
      expect(embed.fields?.map(field => field.value).join("\n")).toContain("CP3-final");
      const attachment = sentMessage.files![0] as { attachment: Buffer; name: string };
      expect(JSON.parse(attachment.attachment.toString("utf8"))).toEqual(report);
      if (failure === "acknowledgement-failure") d1.sqlite.exec("DROP TRIGGER fail_diagnostic_ack");
      vi.setSystemTime(new Date(Date.now() + 31_000));
      await pollDiagnosticQueue(input);
      expect(sent).toHaveLength(1);
      expect(await worker.claimDiagnostic()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function diagnosticStore() {
  const fixture = testStore();
  const limiter = { async limit() { return { success: true }; } };
  const env: CloudflareUploadEnv = {
    UPLOAD_DB: fixture.d1 as never,
    UPLOAD_QUARANTINE_BUCKET: fixture.quarantine,
    UPLOAD_PUBLIC_BUCKET: fixture.publicBucket,
    UPLOAD_PREPARE_RATE_LIMITER: limiter,
    UPLOAD_OBJECT_RATE_LIMITER: limiter,
    UPLOAD_COMPLETE_RATE_LIMITER: limiter,
    UPLOAD_ATTRIBUTION_RATE_LIMITER: limiter,
    BOT_HMAC_SECRET: "test-diagnostic-secret-at-least-32-characters"
  };
  return { ...fixture, env };
}

function diagnosticReport(): DiagnosticReport {
  return {
    schemaVersion: 1,
    reportId: "a".repeat(32),
    createdUtc: "2026-09-21T12:00:00.1234567Z",
    description: "The last room transition freezes after unfreezing SRT.",
    context: { screen: "menu" },
    versions: { Akron: "0.2.0" },
    system: { platform: "Linux" },
    mods: [{ name: "Akron", version: "0.2.0" }],
    logs: [{ name: "akron-current.log", text: "Slow transition at <game>/Maps/map.bin", truncated: false }]
  };
}

function diagnosticRequest(report: unknown): Request {
  return new Request("https://uploads.test/uploads/diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
    body: JSON.stringify(report)
  });
}

function signedDiagnosticRequest(reportId: string, secret: string, timestamp = new Date().toISOString()): Request {
  const path = `/bot/diagnostics/${reportId}`;
  const nonce = randomUUID();
  const bodyText = "{}";
  const signature = signBotRequest({ secret, method: "POST", path, timestamp, nonce, bodyText });
  return new Request(`https://uploads.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-akron-timestamp": timestamp, "x-akron-nonce": nonce, "x-akron-signature": signature },
    body: bodyText
  });
}
