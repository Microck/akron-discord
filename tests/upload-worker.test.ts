import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { akrMaxBytes, imageSourceMaxBytes } from "../src/submissions/types.js";
import { catalogCaptureTransformAttempts, enforceEdgeRateLimit } from "../src/upload-worker-cloudflare.js";
import {
  createUploadWorker as createUploadWorkerCore,
  buildPublication,
  InMemoryUploadStore,
  maxBatchDeclaredBytes,
  shouldDeleteQuarantineBatch,
  signBotRequest,
  type CatalogPack,
  type CatalogPublication,
  type PublishCatalogEntryInput,
  type UploadBatchRecord,
  type UploadObjectRecord,
  type UploadWorkerOptions
} from "../src/upload-worker.js";
import { canonicalStateForSection, zipJson } from "./archive-fixtures.js";

const baseUrl = "https://uploads.example.test";
const botSecret = "test-secret";
const installId = "install-123";
const mapSid = "SpringCollab2020/1-Beginner";

describe("upload worker", () => {
  it("enforces the route-specific Cloudflare edge rate limits", async () => {
    const calls: Record<string, string[]> = { prepare: [], object: [], complete: [], attribution: [] };
    const limiter = (name: keyof typeof calls, success = true) => ({
      async limit(input: { key: string }): Promise<{ success: boolean }> {
        calls[name].push(input.key);
        return { success };
      }
    });
    const env = {
      UPLOAD_PREPARE_RATE_LIMITER: limiter("prepare"),
      UPLOAD_OBJECT_RATE_LIMITER: limiter("object"),
      UPLOAD_COMPLETE_RATE_LIMITER: limiter("complete", false),
      UPLOAD_ATTRIBUTION_RATE_LIMITER: limiter("attribution")
    };
    const request = (method: string, path: string) => new Request(`${baseUrl}${path}`, {
      method,
      headers: { "cf-connecting-ip": "203.0.113.42" }
    });

    expect(await enforceEdgeRateLimit(request("POST", "/uploads/prepare"), env)).toBeUndefined();
    expect(await enforceEdgeRateLimit(request("PUT", "/uploads/objects/object-id?token=value"), env)).toBeUndefined();
    const blocked = await enforceEdgeRateLimit(request("POST", "/uploads/complete"), env);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBe("60");
    await expect(blocked?.json()).resolves.toEqual({ error: "edge_rate_limit_exceeded" });
    expect(await enforceEdgeRateLimit(request("POST", "/bot/attribution/submission/confirm"), env)).toBeUndefined();
    expect(await enforceEdgeRateLimit(request("GET", "/uploads/challenge"), env)).toBeUndefined();

    expect(Object.fromEntries(Object.entries(calls).map(([name, keys]) => [name, keys.length]))).toEqual({
      prepare: 1,
      object: 1,
      complete: 1,
      attribution: 1
    });
    expect(new Set(Object.values(calls).flat()).size).toBe(1);
    expect(calls.prepare[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed before a limited route reaches storage without Cloudflare identity", async () => {
    let calls = 0;
    const limiter = { async limit(): Promise<{ success: boolean }> { calls += 1; return { success: true }; } };
    const response = await enforceEdgeRateLimit(new Request(`${baseUrl}/uploads/prepare`, { method: "POST" }), {
      UPLOAD_PREPARE_RATE_LIMITER: limiter,
      UPLOAD_OBJECT_RATE_LIMITER: limiter,
      UPLOAD_COMPLETE_RATE_LIMITER: limiter,
      UPLOAD_ATTRIBUTION_RATE_LIMITER: limiter
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: "network_identity_required" });
    expect(calls).toBe(0);
  });

  it("tries progressively smaller public capture transforms", () => {
    expect(catalogCaptureTransformAttempts[0]).toEqual({ width: 2048, quality: 82 });
    expect(catalogCaptureTransformAttempts.length).toBeGreaterThan(1);

    for (let index = 1; index < catalogCaptureTransformAttempts.length; index++) {
      const previous = catalogCaptureTransformAttempts[index - 1];
      const current = catalogCaptureTransformAttempts[index];
      expect(current.width).toBeLessThan(previous.width);
      expect(current.quality).toBeLessThan(previous.quality);
    }
  });

  it("exposes upload caps and supported sections", async () => {
    const worker = testWorker();

    const response = await worker.fetch(new Request(`${baseUrl}/uploads/challenge`));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      termsVersion: 1,
      acceptedSections: ["StartPos", "AutoKill", "AutoDeafen"],
      limits: {
        packMaxBytes: akrMaxBytes,
        captureMaxBytes: imageSourceMaxBytes,
        batchMaxBytes: maxBatchDeclaredBytes,
        capturesMaxCount: 10,
        titleMaxLength: 120,
        descriptionMaxLength: 1_000,
        mapSidMaxLength: 512,
        roomNameMaxLength: 200,
        submissionsMaxCount: 8
      },
      serverTimeUtc: "2026-01-01T00:00:00.000Z"
    });
  });

  it("fails closed when public prepare requests lack a trusted network identity", async () => {
    const worker = testWorker();
    const response = await worker.fetch(new Request(`${baseUrl}/uploads/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installId,
        termsVersion: 1,
        submissions: [submissionInput()]
      })
    }));

    expect(response.status).toBe(403);
    await expectJson(response, { error: "network_identity_required" });
  });

  it("rejects aggregate batches before reserving storage", async () => {
    const worker = testWorker();
    const response = await prepare(worker, {
      captures: [
        { roomName: "a", sizeBytes: imageSourceMaxBytes, contentType: "image/png" },
        { roomName: "b", sizeBytes: imageSourceMaxBytes, contentType: "image/png" },
        { roomName: "c", sizeBytes: imageSourceMaxBytes, contentType: "image/png" }
      ],
      submissions: [submissionInput({ packSizeBytes: 1 })]
    });

    expect(response.status).toBe(413);
    await expectJson(response, { error: "batch_too_large", maxBytes: maxBatchDeclaredBytes });
  });

  it("enforces store-backed prepare quotas per install and network", async () => {
    const worker = testWorker();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await prepare(worker, { captures: [] })).status).toBe(201);
    }

    const blocked = await prepare(worker, { captures: [] });
    expect(blocked.status).toBe(429);
    await expectJson(blocked, { error: "upload_quota_exceeded" });
  });

  it("keeps quota reservations after an expired prepared batch is reclaimed", async () => {
    const store = new InMemoryUploadStore();
    const created = new Date("2026-01-01T00:00:00.000Z");
    const reservation = {
      reservationId: "batch-1", installIdHash: "install", networkKeyHash: "network", reservedBytes: 100,
      createdUtc: created.toISOString(), expiresUtc: "2026-01-01T01:00:00.000Z",
      windowStartUtc: "2025-12-31T23:00:00.000Z", maxInstallReservations: 1, maxInstallBytes: 1_000,
      maxNetworkReservations: 1, maxNetworkBytes: 1_000
    };
    expect(await store.reserveUploadQuota(reservation)).toBe(true);
    await store.putBatch({
      id: "batch-1", installIdHash: "install", termsVersion: 1, status: "prepared",
      createdUtc: created.toISOString(), updatedUtc: created.toISOString(), expiresUtc: "2026-01-01T00:30:00.000Z",
      submissions: []
    });

    await store.cleanupExpired(new Date("2026-01-01T00:31:00.000Z"), 10);
    expect(await store.reserveUploadQuota({ ...reservation, reservationId: "batch-2" })).toBe(false);
    await store.cleanupExpired(new Date("2026-01-01T01:01:00.000Z"), 10);
    expect(await store.reserveUploadQuota({
      ...reservation, reservationId: "batch-3", createdUtc: "2026-01-01T01:01:00.000Z",
      expiresUtc: "2026-01-01T02:01:00.000Z", windowStartUtc: "2026-01-01T00:01:00.000Z"
    })).toBe(true);
  });

  it("groups rotating IPv6 addresses by /64 for network quotas", async () => {
    const worker = testWorker();
    const prepareFrom = async (attempt: number): Promise<Response> => worker.fetch(new Request(`${baseUrl}/uploads/prepare`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `2001:db8:abcd:1234::${attempt.toString(16)}`
      },
      body: JSON.stringify({
        installId: `installation-${attempt}`,
        termsVersion: 1,
        captures: [],
        submissions: [submissionInput()]
      })
    }));

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect((await prepareFrom(attempt)).status).toBe(201);
    }
    expect((await prepareFrom(13)).status).toBe(429);
  });

  it("bounds public JSON before parsing", async () => {
    const worker = testWorker();
    const response = await worker.fetch(new Request(`${baseUrl}/uploads/prepare`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(256 * 1024),
        "cf-connecting-ip": "203.0.113.10"
      },
      body: "{}"
    }));

    expect(response.status).toBe(413);
    await expectJson(response, { error: "json_body_too_large" });
  });

  it("rejects oversized bot JSON before signature verification", async () => {
    const worker = testWorker();
    const response = await worker.fetch(new Request(`${baseUrl}/bot/jobs/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024),
        "x-akron-timestamp": "2026-01-01T00:00:00.000Z",
        "x-akron-nonce": "00000000-0000-4000-8000-000000000000",
        "x-akron-signature": "a".repeat(64)
      },
      body: "{}"
    }));

    expect(response.status).toBe(413);
    await expectJson(response, { error: "json_body_too_large" });
  });

  it("indexes delivered moderation jobs before Cloudflare claim limits are applied", () => {
    const workerSource = readFileSync("src/upload-worker-cloudflare.ts", "utf8");
    const migrationSource = readFileSync("migrations/0001_uploads.sql", "utf8");
    const securityMigrationSource = readFileSync("migrations/0002_runtime_security.sql", "utf8");
    const wranglerSource = readFileSync("wrangler.uploads.example.toml", "utf8");
    const productionWranglerSource = readFileSync("wrangler.uploads.toml", "utf8");

    expect(migrationSource).toContain("moderation_delivered_utc TEXT");
    expect(workerSource).toContain("WHERE moderation_delivered_utc IS NULL");
    expect(workerSource).toContain("moderation_delivered_utc = excluded.moderation_delivered_utc");
    expect(workerSource).toContain("UPLOAD_QUARANTINE_BUCKET");
    expect(workerSource).toContain("UPLOAD_PUBLIC_BUCKET");
    expect(workerSource).toContain("UPLOAD_PUBLIC_UPLOAD_BASE_URL");
    expect(workerSource).toContain("this.quarantineBucket.put");
    expect(workerSource).toContain("this.publicBucket.put");
    expect(workerSource).toContain("acquireCatalogLock");
    expect(workerSource).toContain("upload_catalog_locks");
    expect(migrationSource).toContain("CREATE TABLE IF NOT EXISTS upload_catalog_locks");
    expect(securityMigrationSource).toContain("CREATE TABLE IF NOT EXISTS upload_quota_reservations");
    expect(securityMigrationSource).toContain("CREATE TABLE IF NOT EXISTS upload_attribution_deliveries");
    expect(workerSource).toContain("async scheduled(");
    expect(workerSource).toContain("BOT_HMAC_SECRET.length < 32");
    expect(wranglerSource).toContain("binding = \"UPLOAD_QUARANTINE_BUCKET\"");
    expect(wranglerSource).toContain("binding = \"UPLOAD_PUBLIC_BUCKET\"");
    expect(wranglerSource).toContain("UPLOAD_PUBLIC_UPLOAD_BASE_URL");
    expect(wranglerSource).toContain("crons = [\"17 4 * * *\"]");
    expect(productionWranglerSource).toContain("crons = [\"17 4 * * *\"]");
  });

  it("rejects unsupported sections before allocating uploads", async () => {
    const worker = testWorker();

    const response = await prepare(worker, {
      submissions: [submissionInput({ section: "Whole" })]
    });

    expect(response.status).toBe(400);
    await expectJson(response, { error: "section_unsupported" });
  });

  it("rejects unsupported upload map URLs before allocating uploads", async () => {
    const worker = testWorker();

    const response = await prepare(worker, {
      submissions: [submissionInput({ mapUrl: "https://example.com/maps/1" })]
    });

    expect(response.status).toBe(400);
    await expectJson(response, { error: "mapUrl_unsupported" });
  });

  it("creates the batch before dependent object records", async () => {
    const worker = createUploadWorker({
      store: new ReferentialIntegrityUploadStore(),
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const response = await prepare(worker);

    expect(response.status).toBe(201);
  });

  it("returns canonical public upload URLs when the worker is behind a rewrite", async () => {
    const worker = createUploadWorker({
      store: new InMemoryUploadStore(),
      botSecret,
      publicUploadBaseUrl: "https://akron.micr.dev/uploads",
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const response = await worker.fetch(new Request("https://akron-upload-worker.example.workers.dev/uploads/prepare", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10"
      },
      body: JSON.stringify({
        installId,
        termsVersion: 1,
        captures: [{ roomName: "a-00", sizeBytes: 128, contentType: "image/png" }],
        submissions: [submissionInput()]
      })
    }));
    const body = await response.json() as {
      captures: Array<{ uploadUrl: string }>;
      submissions: Array<{ pack: { uploadUrl: string } }>;
    };

    expect(response.status).toBe(201);
    expect(body.captures[0]?.uploadUrl).toMatch(/^https:\/\/akron\.micr\.dev\/uploads\/objects\//);
    expect(body.submissions[0]?.pack.uploadUrl).toMatch(/^https:\/\/akron\.micr\.dev\/uploads\/objects\//);
  });

  it("prepares ordered room capture upload URLs for the current Akron client", async () => {
    const worker = testWorker();

    const response = await prepare(worker, {
      captures: [
        { roomName: "a-00", sizeBytes: 128, contentType: "image/png" },
        { roomName: "b-01", sizeBytes: 256, contentType: "image/webp" }
      ]
    });
    const body = await response.json() as {
      captures: Array<{ roomName: string; uploadUrl: string }>;
      submissions: Array<{ pack: { uploadUrl: string } }>;
    };

    expect(response.status).toBe(201);
    expect(body.captures).toHaveLength(2);
    expect(body.captures.map(capture => capture.roomName)).toEqual(["a-00", "b-01"]);
    expect(body.captures[0]?.uploadUrl).toMatch(/^https:\/\/uploads\.example\.test\/uploads\/objects\//);
    expect(body.captures[1]?.uploadUrl).toMatch(/^https:\/\/uploads\.example\.test\/uploads\/objects\//);
    expect(body.submissions[0]?.pack.uploadUrl).toMatch(/^https:\/\/uploads\.example\.test\/uploads\/objects\//);
  });

  it("accepts pack-only prepare requests when captures are omitted", async () => {
    const worker = testWorker();

    const response = await prepare(worker, { captures: undefined });
    const body = await response.json() as {
      captures: unknown[];
      submissions: Array<{ pack: { uploadUrl: string } }>;
    };

    expect(response.status).toBe(201);
    expect(body.captures).toEqual([]);
    expect(body.submissions[0]?.pack.uploadUrl).toMatch(/^https:\/\/uploads\.example\.test\/uploads\/objects\//);
  });

  it("keeps ordered room captures through moderation and catalog publication", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const pack = validArchive("StartPos");
    const preparedResponse = await prepare(worker, {
      captures: [
        { roomName: "Slot 1 StartPos", sizeBytes: 128, contentType: "image/png" },
        { roomName: "Slot 2 StartPos", sizeBytes: 128, contentType: "image/png" }
      ],
      submissions: [submissionInput({ packSizeBytes: pack.length })]
    });
    const prepared = await preparedResponse.json() as {
      batchId: string;
      captures: Array<{ objectId: string; uploadUrl: string }>;
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    for (const capture of prepared.captures) {
      expect((await worker.fetch(uploadRequest(capture.uploadUrl, Buffer.from("fake-png"), "image/png"))).status).toBe(200);
    }
    expect((await worker.fetch(uploadRequest(prepared.submissions[0]?.pack.uploadUrl ?? "", pack, "application/octet-stream"))).status).toBe(200);
    await postJson(worker, "/uploads/complete", { installId, batchId: prepared.batchId });

    const claim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "ordered-captures-claim");
    const job = (await claim.json() as {
      jobs: Array<{ captures: Array<{ objectId: string; roomName: string; sourceUrl: string }> }>;
    }).jobs[0];
    expect(job?.captures.map(capture => capture.roomName)).toEqual(["Slot 1 StartPos", "Slot 2 StartPos"]);
    expect(job?.captures.every(capture => capture.sourceUrl.includes("/uploads/source/"))).toBe(true);

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "ordered-captures-approve");
    const publication = (await approved.json() as UploadStatusBody).submissions[0]?.publication;

    expect(publication?.images.map(image => image.roomName)).toEqual(["Slot 1 StartPos", "Slot 2 StartPos"]);
    expect(publication?.images.map(image => image.url)).toEqual([
      expect.stringMatching(/\/captures\/01-slot-1-startpos\.jpg$/),
      expect.stringMatching(/\/captures\/02-slot-2-startpos\.jpg$/)
    ]);
    expect(store.getCatalogIndexForTesting().packs[0]?.images).toEqual(publication?.images.map(image => ({
      url: image.url,
      roomName: image.roomName
    })));
  });

  it("rejects packs and captures above the upload budget", async () => {
    const worker = testWorker();

    const packResponse = await prepare(worker, {
      submissions: [submissionInput({ packSizeBytes: akrMaxBytes + 1 })]
    });
    expect(packResponse.status).toBe(413);
    await expectJson(packResponse, { error: "pack_too_large", maxBytes: akrMaxBytes });

    const captureResponse = await prepare(worker, {
      captures: [{ roomName: "a-00", sizeBytes: imageSourceMaxBytes + 1, contentType: "image/png" }]
    });
    expect(captureResponse.status).toBe(413);
    await expectJson(captureResponse, { error: "capture_too_large", maxBytes: imageSourceMaxBytes });
  });

  it("bounds prepare batch size and Map SID length", async () => {
    const worker = testWorker();

    const tooMany = await prepare(worker, {
      submissions: Array.from({ length: 9 }, () => submissionInput())
    });
    expect(tooMany.status).toBe(413);
    await expectJson(tooMany, { error: "too_many_submissions", maxSubmissions: 8 });

    const longMapSid = await prepare(worker, {
      submissions: [submissionInput({ mapSid: "x".repeat(513) })]
    });
    expect(longMapSid.status).toBe(400);
    await expectJson(longMapSid, { error: "mapSid_too_long" });
  });

  it("rejects capture lists that exceed Discord's embed limit", async () => {
    const worker = testWorker();
    const captures = Array.from({ length: 11 }, (_, index) => ({
      roomName: `room-${index}`,
      sizeBytes: 128,
      contentType: "image/png"
    }));

    const response = await prepare(worker, { captures });

    expect(response.status).toBe(413);
    await expectJson(response, { error: "too_many_captures", maxCaptures: 10 });
  });

  it("rejects capture room names that exceed the public label limit", async () => {
    const worker = testWorker();

    const response = await prepare(worker, {
      captures: [{ roomName: "x".repeat(201), sizeBytes: 128, contentType: "image/png" }]
    });

    expect(response.status).toBe(400);
    await expectJson(response, { error: "roomName_too_long" });
  });

  it("rejects unsupported capture image types at prepare and PUT time", async () => {
    const worker = testWorker();

    const svgPrepare = await prepare(worker, {
      captures: [{ roomName: "a-00", sizeBytes: 128, contentType: "image/svg+xml" }]
    });
    expect(svgPrepare.status).toBe(415);
    await expectJson(svgPrepare, { error: "capture_type_unsupported" });

    const preparedResponse = await prepare(worker);
    const prepared = await preparedResponse.json() as {
      captures: Array<{ uploadUrl: string }>;
    };
    const svgPut = await worker.fetch(uploadRequest(prepared.captures[0]?.uploadUrl ?? "", Buffer.from("<svg />"), "image/svg+xml"));
    expect(svgPut.status).toBe(415);
    await expectJson(svgPut, { error: "capture_type_unsupported" });
  });

  it("requires uploaded objects to declare content length before streaming", async () => {
    const worker = testWorker();
    const preparedResponse = await prepare(worker);
    const prepared = await preparedResponse.json() as {
      captures: Array<{ uploadUrl: string }>;
    };

    const upload = await worker.fetch(new Request(prepared.captures[0]?.uploadUrl ?? "", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("fake-png"));
          controller.close();
        }
      }),
      duplex: "half"
    } as RequestInit));

    expect(upload.status).toBe(411);
    await expectJson(upload, { error: "upload_length_required" });
  });

  it("queues an anonymous upload after pack and capture objects are uploaded", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos",
      attribution: { mode: "anonymous" }
    });
    const completeResponse = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const complete = await completeResponse.json() as UploadStatusBody;

    expect(completeResponse.status).toBe(200);
    expect(complete.status).toBe("queued");
    expect(complete.submissions[0]).toMatchObject({
      section: "StartPos",
      mapSid,
      status: "queued",
      validationReasons: []
    });
  });

  it("accepts the map-scoped area sections used by Akron uploads", async () => {
    const worker = testWorker();

    for (const section of ["AutoKill", "AutoDeafen"]) {
      const prepared = await prepareAndUpload(worker, {
        pack: validArchive(section),
        section,
        attribution: { mode: "anonymous" }
      });
      const completeResponse = await postJson(worker, "/uploads/complete", {
        installId,
        batchId: prepared.batchId
      });
      const complete = await completeResponse.json() as UploadStatusBody;

      expect(completeResponse.status).toBe(200);
      expect(complete.status).toBe("queued");
      expect(complete.submissions[0]).toMatchObject({
        section,
        mapSid,
        status: "queued",
        validationReasons: []
      });
    }
  });

  it("keeps completion retryable when uploaded pack bytes are temporarily unavailable", async () => {
    const store = new MissingPackBytesOnceStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    store.packObjectId = new URL(prepared.submissions[0]?.pack.uploadUrl ?? "").pathname.split("/").at(-1) ?? "";

    const firstComplete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const retryableStatus = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const secondComplete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    expect(firstComplete.status).toBe(409);
    await expectJson(firstComplete, {
      error: "upload_objects_missing",
      submissionId: prepared.submissions[0]?.submissionId ?? ""
    });
    expect((await retryableStatus.json() as UploadStatusBody).status).toBe("prepared");
    expect(secondComplete.status).toBe(200);
    expect((await secondComplete.json() as UploadStatusBody).status).toBe("queued");
  });

  it("keeps completion retryable when pack validation throws after locking", async () => {
    const store = new ThrowingPackReadOnceStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    store.packObjectId = new URL(prepared.submissions[0]?.pack.uploadUrl ?? "").pathname.split("/").at(-1) ?? "";

    const firstComplete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const retryableStatus = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const secondComplete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    expect(firstComplete.status).toBe(500);
    await expectJson(firstComplete, { error: "internal_error" });
    expect((await retryableStatus.json() as UploadStatusBody).status).toBe("prepared");
    expect(secondComplete.status).toBe(200);
    expect((await secondComplete.json() as UploadStatusBody).status).toBe("queued");
  });

  it("rejects object overwrites after completion validation", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const overwrite = await worker.fetch(uploadRequest(
      prepared.submissions[0]?.pack.uploadUrl ?? "",
      validArchive("AutoKill"),
      "application/octet-stream"
    ));

    expect(overwrite.status).toBe(409);
    await expectJson(overwrite, { error: "batch_not_prepared", status: "queued" });
  });

  it("rejects duplicate object uploads before completion", async () => {
    const worker = testWorker();
    const pack = validArchive("StartPos");
    const preparedResponse = await prepare(worker, {
      submissions: [submissionInput({ packSizeBytes: pack.length })]
    });
    const prepared = await preparedResponse.json() as {
      submissions: Array<{ pack: { uploadUrl: string } }>;
    };
    const uploadUrl = prepared.submissions[0]?.pack.uploadUrl ?? "";

    const first = await worker.fetch(uploadRequest(uploadUrl, pack, "application/octet-stream"));
    const second = await worker.fetch(uploadRequest(uploadUrl, validArchive("StartPos"), "application/octet-stream"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expectJson(second, { error: "upload_object_locked" });
  });

  it("rejects object uploads whose body exceeds the declared upload budget", async () => {
    const worker = createUploadWorker({
      store: new TinyPackCapUploadStore(),
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const oversizedBody = Buffer.alloc(101, "x");
    const preparedResponse = await prepare(worker);
    const prepared = await preparedResponse.json() as {
      submissions: Array<{ pack: { uploadUrl: string } }>;
    };

    const response = await worker.fetch(uploadRequest(
      prepared.submissions[0]?.pack.uploadUrl ?? "",
      oversizedBody,
      "application/octet-stream",
      1
    ));

    expect(response.status).toBe(413);
    await expectJson(response, { error: "upload_object_too_large", maxBytes: 100 });
  });

  it("returns queued uploads through the signed bot job claim endpoint", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos",
      mapUrl: "https://www.gamebanana.com/mods/150453?source=akron#comments"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const response = await signedBotJson(worker, "/bot/jobs/claim", { limit: 5 }, "nonce-claim");
    const body = await response.json() as {
      jobs: Array<{
        batchId: string;
        submissionId: string;
        section: string;
        status: string;
        attribution: { label: string };
        archiveFacts: Record<string, unknown>;
        captures: Array<{ objectId: string; roomName: string; sourceUrl: string }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      batchId: prepared.batchId,
      submissionId: prepared.submissions[0]?.submissionId,
      section: "StartPos",
      status: "reviewing",
      attribution: { label: "Anonymous" },
      archiveFacts: { section: "StartPos", mapSid },
      captures: [{
        objectId: expect.any(String),
        roomName: "",
        sourceUrl: expect.stringContaining("/uploads/source/")
      }]
    });

    const empty = await signedBotJson(worker, "/bot/jobs/claim", { limit: 5 }, "nonce-claim-empty");
    expect((await empty.json() as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("requeues claimed jobs when moderation delivery fails", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const claimed = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-requeue-claim");
    expect((await claimed.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
    const submissionId = prepared.submissions[0]?.submissionId ?? "";

    const requeued = await signedBotJson(worker, "/bot/jobs/requeue", { submissionIds: [submissionId] }, "nonce-requeue");
    expect(requeued.status).toBe(200);

    const claimedAgain = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-requeue-claim-again");
    const body = await claimedAgain.json() as { jobs: Array<{ submissionId: string }> };
    expect(body.jobs.map(job => job.submissionId)).toEqual([submissionId]);
  });

  it("bounds repeated moderation delivery attempts", async () => {
    const worker = testWorker();
    const prepared = await prepareAndUpload(worker, { pack: validArchive("StartPos"), section: "StartPos" });
    await postJson(worker, "/uploads/complete", { installId, batchId: prepared.batchId });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claimed = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, `bounded-claim-${attempt}`);
      expect((await claimed.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
      await signedBotJson(worker, "/bot/jobs/requeue", { submissionIds: [submissionId] }, `bounded-requeue-${attempt}`);
    }
    const exhausted = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "bounded-claim-exhausted");
    expect((await exhausted.json() as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("reclaims reviewing jobs after the moderation claim lease expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const worker = createUploadWorker({
      store: new InMemoryUploadStore(),
      botSecret,
      now: () => now
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const firstClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-lease-claim", now.toISOString());
    expect((await firstClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
    const claimedTooSoon = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-lease-too-soon", now.toISOString());
    expect((await claimedTooSoon.json() as { jobs: unknown[] }).jobs).toEqual([]);

    now = new Date("2026-01-01T00:16:00.000Z");
    const reclaimed = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-lease-reclaim", now.toISOString());
    const body = await reclaimed.json() as { jobs: Array<{ submissionId: string }> };

    expect(body.jobs.map(job => job.submissionId)).toEqual([prepared.submissions[0]?.submissionId]);
  });

  it("does not reclaim delivered moderation jobs after the claim lease expires", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const worker = createUploadWorker({
      store: new InMemoryUploadStore(),
      botSecret,
      now: () => now
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const firstClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-delivered-claim", now.toISOString());
    expect((await firstClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
    const delivered = await signedBotJson(worker, "/bot/jobs/delivered", {
      submissionIds: [prepared.submissions[0]?.submissionId]
    }, "nonce-delivered-ack", now.toISOString());
    expect(delivered.status).toBe(200);

    now = new Date("2026-01-01T00:16:00.000Z");
    const reclaimed = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-delivered-reclaim", now.toISOString());

    expect((await reclaimed.json() as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it("rejects completion when the uploaded archive does not match prepared metadata", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      section: "StartPos",
      pack: validArchive("AutoKill")
    });
    const completeResponse = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const complete = await completeResponse.json() as UploadStatusBody;

    expect(completeResponse.status).toBe(200);
    expect(complete.status).toBe("rejected");
    expect(complete.submissions[0]?.validationReasons)
      .toContain("Uploaded archive section does not match prepared submission.");
  });

  it("blocks publication for Discord attribution until the claimed user confirms", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "123456789012345678" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    const complete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const completeBody = await complete.json() as UploadStatusBody;
    const submissionId = completeBody.submissions[0]?.submissionId ?? "";

    expect(completeBody.status).toBe("awaiting_attribution");

    const blockedApprove = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {});
    await expectJson(blockedApprove, { error: "attribution_pending" });
    expect(blockedApprove.status).toBe(409);

    const confirmed = await signedBotJson(worker, `/bot/attribution/${submissionId}/confirm`, {
      discordUserId: "123456789012345678"
    }, "nonce-confirm");
    const confirmedBody = await confirmed.json() as UploadStatusBody;
    expect(confirmed.status).toBe(200);
    expect(confirmedBody.status).toBe("queued");

    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {
      authorName: "Discord Author",
      authorAvatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/avatar.jpg"
    }, "nonce-approve");
    const approvedBody = await approved.json() as UploadStatusBody;
    expect(approved.status).toBe(200);
    expect(approvedBody.status).toBe("published");
    expect(approvedBody.submissions[0]?.status).toBe("published");
    expect(approvedBody.submissions[0]?.attribution).toMatchObject({
      mode: "discord",
      label: "Discord confirmed",
      confirmed: true,
      discordUserId: "123456789012345678"
    });

    const publicStatus = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const publicStatusBody = await publicStatus.json() as UploadStatusBody;
    expect(publicStatus.status).toBe(200);
    expect(publicStatusBody.submissions[0]?.attribution).toMatchObject({
      mode: "discord",
      label: "Discord confirmed",
      confirmed: true
    });
    expect(publicStatusBody.submissions[0]?.attribution?.discordUserId).toBeUndefined();
  });

  it("queues Discord attribution after the owner confirms a claimed job", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "123456789012345678" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const firstClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-confirm-claim");
    expect((await firstClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const delivered = await signedBotJson(worker, "/bot/jobs/delivered", {
      submissionIds: [submissionId]
    }, "nonce-confirm-delivered");
    expect(delivered.status).toBe(200);

    const confirmed = await signedBotJson(worker, `/bot/attribution/${submissionId}/confirm`, {
      discordUserId: "123456789012345678"
    }, "nonce-confirm-claimed");
    const confirmedBody = await confirmed.json() as UploadStatusBody;

    expect(confirmed.status).toBe(200);
    expect(confirmedBody.submissions[0]?.status).toBe("queued");
    const secondClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-confirm-claim-again");
    expect((await secondClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("requeues a claimed Discord attribution job when the client switches to anonymous", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "123456789012345678" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const firstClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-anonymous-claim");
    expect((await firstClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const delivered = await signedBotJson(worker, "/bot/jobs/delivered", {
      submissionIds: [submissionId]
    }, "nonce-anonymous-delivered");
    expect(delivered.status).toBe(200);

    const converted = await postJson(worker, `/uploads/${submissionId}/convert-to-anonymous`, {
      installId,
      batchId: prepared.batchId
    });
    const convertedBody = await converted.json() as UploadStatusBody;

    expect(converted.status).toBe(200);
    expect(convertedBody.submissions[0]).toMatchObject({
      status: "queued",
      attribution: { mode: "anonymous", label: "Anonymous" }
    });
    const secondClaim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-anonymous-claim-again");
    expect((await secondClaim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);
  });

  it("blocks anonymous conversion after publication", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "123456789012345678" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/attribution/${submissionId}/confirm`, {
      discordUserId: "123456789012345678"
    }, "nonce-published-confirm");
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {
      authorName: "Discord Author",
      authorAvatarUrl: "https://cdn.discordapp.com/avatars/123456789012345678/avatar.jpg"
    }, "nonce-published-approve");
    expect(approved.status).toBe(200);

    const converted = await postJson(worker, `/uploads/${submissionId}/convert-to-anonymous`, {
      installId,
      batchId: prepared.batchId
    });

    expect(converted.status).toBe(409);
    await expectJson(converted, { error: "submission_already_published" });
  });

  it("rejects client withdrawal after a submission is claimed for moderation", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const claim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 1 }, "nonce-withdraw-claim");
    expect((await claim.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const withdrawn = await postJson(worker, `/uploads/${submissionId}/withdraw`, {
      installId,
      batchId: prepared.batchId
    });

    expect(withdrawn.status).toBe(409);
    await expectJson(withdrawn, { error: "submission_locked", status: "reviewing" });
  });

  it("publishes approved uploads into public objects and the catalog index idempotently", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos",
      mapUrl: "https://www.gamebanana.com/mods/150453?source=akron#comments"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/discord-messages/${submissionId}`, {
      kind: "review",
      guildId: "123456789012345678",
      channelId: "345678901234567890",
      threadId: "234567890123456789",
      messageId: "456789012345678901"
    }, "catalog-review-thread");
    const first = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "publish-once");
    const second = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "publish-twice");
    const published = await second.json() as UploadStatusBody;
    const publication = published.submissions[0]?.publication;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(publication).toMatchObject({
      packKey: expect.stringMatching(/^packs\/springcollab2020-1-beginner\//),
      downloadUrl: expect.stringMatching(/^https:\/\/akron\.example\.test\/maps\/springcollab2020-1-beginner\/.+\.akr$/),
      images: [{
        key: expect.stringMatching(/^captures\/springcollab2020-1-beginner\/.+\/01-image\.jpg$/),
        url: expect.stringMatching(/^https:\/\/akron\.example\.test\/maps\/springcollab2020-1-beginner\/.+\/captures\/01-image\.jpg$/),
        roomName: ""
      }]
    });
    expect(store.getPublicObjectForTesting(publication?.packKey ?? "")?.contentType).toBe("application/octet-stream");
    expect(store.getPublicObjectForTesting(publication?.images[0]?.key ?? "")?.contentType).toBe("image/jpeg");
    const unpublishedCatalog = store.getCatalogIndexForTesting();
    expect(unpublishedCatalog.packs).toHaveLength(1);
    expect(unpublishedCatalog.packs[0]).toMatchObject({
      title: "Beginner StartPos",
      section: "StartPos",
      mapSid,
      mapUrl: "https://gamebanana.com/mods/150453",
      discordUrl: "",
      authorName: "Anonymous"
    });

    await signedBotJson(worker, `/bot/discord-messages/${submissionId}`, {
      kind: "publication",
      guildId: "123456789012345678",
      channelId: "345678901234567890",
      threadId: "234567890123456789",
      messageId: "456789012345678901"
    }, "catalog-publication-thread");
    expect(store.getCatalogIndexForTesting().packs[0]?.discordUrl)
      .toBe("https://discord.com/channels/123456789012345678/234567890123456789");
  });

  it("records Discord publication metadata for bot cleanup", async () => {
    const worker = testWorker();
    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const recorded = await signedBotJson(worker, `/bot/discord-messages/${submissionId}`, {
      kind: "publication",
      guildId: "guild",
      channelId: "forum",
      threadId: "thread",
      messageId: "message"
    }, "nonce-record-discord");
    const body = await recorded.json() as { discord?: { publication?: { threadId?: string; messageId?: string } } };

    expect(recorded.status).toBe(200);
    expect(body.discord?.publication).toMatchObject({
      threadId: "thread",
      messageId: "message"
    });
  });

  it("persists bot AI review and exposes it through submission context", async () => {
    const worker = testWorker();
    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";

    const recorded = await signedBotJson(worker, `/bot/reviews/${submissionId}`, {
      decision: "needs_review",
      severity: "medium",
      reasons: ["Manual check required."]
    }, "nonce-ai-review");
    const context = await signedBotJson(worker, `/bot/submissions/${submissionId}/context`, {}, "nonce-ai-context");
    const contextBody = await context.json() as { aiReview?: { decision: string; severity: string; reasons: string[] } };

    expect(recorded.status).toBe(200);
    expect(context.status).toBe(200);
    expect(contextBody.aiReview).toMatchObject({
      decision: "needs_review",
      severity: "medium",
      reasons: ["Manual check required."]
    });
  });

  it("transforms captures in the Worker before publication", async () => {
    const store = new InMemoryUploadStore();
    const transformedSourceUrls: string[] = [];
    const worker = createUploadWorker({
      store,
      botSecret,
      optimizeCatalogCapture: async sourceUrl => {
        transformedSourceUrls.push(sourceUrl);
        return catalogJpeg();
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";

    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-optimized-approve");
    const approvedBody = await approved.json() as UploadStatusBody;
    const publication = approvedBody.submissions[0]?.publication;

    expect(transformedSourceUrls).toHaveLength(1);
    expect(new URL(transformedSourceUrls[0] ?? "").pathname).toMatch(/^\/uploads\/source\//);
    expect(publication?.images[0]?.key).toMatch(/^captures\/springcollab2020-1-beginner\/.+\/01-image\.jpg$/);
    expect(publication?.images[0]?.url).toMatch(/\/captures\/01-image\.jpg$/);
    expect(store.getPublicObjectForTesting(publication?.images[0]?.key ?? "")?.contentType).toBe("image/jpeg");
    expect(store.getPublicObjectForTesting(publication?.images[0]?.key ?? "")?.bytes).toEqual(catalogJpeg().bytes);
    expect(store.getCatalogIndexForTesting().packs[0]?.images[0]?.url).toBe(publication?.images[0]?.url);
  });

  it("publishes confirmed Discord attribution with the profile metadata supplied by the bot", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "1267825421781831815" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", { installId, batchId: prepared.batchId });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/attribution/${submissionId}/confirm`, {
      discordUserId: "1267825421781831815"
    }, "nonce-author-confirm");

    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {
      authorName: "Microck",
      authorAvatarUrl: "https://cdn.discordapp.com/avatars/1267825421781831815/avatar.jpg"
    }, "nonce-author-approve");

    expect(approved.status).toBe(200);
    expect(store.getCatalogIndexForTesting().packs[0]).toMatchObject({
      authorName: "Microck",
      authorAvatarUrl: "https://cdn.discordapp.com/avatars/1267825421781831815/avatar.jpg"
    });
  });

  it("deletes published uploads from public objects and the catalog", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-delete-approve");
    const approvedBody = await approved.json() as UploadStatusBody;
    const publication = approvedBody.submissions[0]?.publication;
    await signedBotJson(worker, `/bot/discord-messages/${submissionId}`, {
      kind: "publication",
      guildId: "guild",
      channelId: "forum",
      threadId: "thread",
      messageId: "message"
    }, "nonce-delete-record");

    const deleted = await signedBotJson(worker, `/bot/submissions/${submissionId}/delete`, {
      reason: "Admin cleanup."
    }, "nonce-delete-pack");
    const deletedBody = await deleted.json() as {
      deleted?: {
        previousStatus: string;
        publication?: { packId: string };
        discord?: { publication?: { threadId?: string } };
      };
    };
    const status = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const statusBody = await status.json() as UploadStatusBody;

    expect(deleted.status).toBe(200);
    expect(deletedBody.deleted).toMatchObject({
      previousStatus: "published",
      publication: { packId: publication?.packId },
      discord: { publication: { threadId: "thread" } }
    });
    expect(store.getPublicObjectForTesting(publication?.packKey ?? "")).toBeUndefined();
    expect(store.getPublicObjectForTesting(publication?.images[0]?.key ?? "")).toBeUndefined();
    expect(store.getCatalogIndexForTesting().packs).toEqual([]);
    expect(statusBody.submissions[0]?.status).toBe("deleted");
    expect(statusBody.submissions[0]?.publication).toBeUndefined();
  });

  it("deletes published uploads by recorded Discord thread", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-delete-thread-approve");
    const approvedBody = await approved.json() as UploadStatusBody;
    const publication = approvedBody.submissions[0]?.publication;
    await signedBotJson(worker, `/bot/discord-messages/${submissionId}`, {
      kind: "publication",
      guildId: "guild",
      channelId: "forum",
      threadId: "thread-delete-target",
      messageId: "message"
    }, "nonce-delete-thread-record");

    const deleted = await signedBotJson(worker, "/bot/submissions/by-discord-thread/thread-delete-target/delete", {
      reason: "Admin cleanup from thread."
    }, "nonce-delete-thread-pack");
    const deletedBody = await deleted.json() as {
      deleted?: {
        submissionId: string;
        previousStatus: string;
        discord?: { publication?: { threadId?: string } };
      };
    };
    const status = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const statusBody = await status.json() as UploadStatusBody;

    expect(deleted.status).toBe(200);
    expect(deletedBody.deleted).toMatchObject({
      submissionId,
      previousStatus: "published",
      discord: { publication: { threadId: "thread-delete-target" } }
    });
    expect(store.getPublicObjectForTesting(publication?.packKey ?? "")).toBeUndefined();
    expect(store.getPublicObjectForTesting(publication?.images[0]?.key ?? "")).toBeUndefined();
    expect(store.getCatalogIndexForTesting().packs).toEqual([]);
    expect(statusBody.submissions[0]?.status).toBe("deleted");
  });

  it("publishes valid pack-only uploads with an empty catalog image URL", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const pack = validArchive("StartPos");
    const preparedResponse = await prepare(worker, {
      captures: [],
      submissions: [submissionInput({ packSizeBytes: pack.length })]
    });
    expect(preparedResponse.status).toBe(201);
    const prepared = await preparedResponse.json() as {
      batchId: string;
      captures: Array<{ uploadUrl: string }>;
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    expect(prepared.captures).toEqual([]);

    await worker.fetch(uploadRequest(prepared.submissions[0]?.pack.uploadUrl ?? "", pack, "application/octet-stream"));
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    await signedBotJson(worker, `/bot/moderation/${prepared.submissions[0]?.submissionId ?? ""}/approve`, {}, "pack-only-approve");
    const catalog = store.getCatalogIndexForTesting();

    expect(catalog.packs[0]).toMatchObject({
      images: [],
      mapSid
    });
  });

  it("serializes forum metadata and upload publication through one catalog writer", async () => {
    const store = new InMemoryUploadStore();
    const worker = createUploadWorker({ store, botSecret, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const submission: UploadBatchRecord["submissions"][number] = {
      id: "upload-entry", batchId: "batch", section: "StartPos", mapSid, mapUrl: "", title: "Upload Entry",
      description: "Upload path", packObjectId: "upload-pack", captures: [], attribution: { mode: "anonymous" },
      status: "moderating", validationReasons: []
    };
    const forumEntry: CatalogPack = {
      id: "forum-entry", title: "Forum Entry", description: "Forum path", section: "StartPos", mapSid, mapUrl: "",
      discordUrl: "https://discord.com/channels/123456789012345678/234567890123456789",
      downloadUrl: "https://akron.example.test/maps/map/forum.akr", authorName: "Forum Author", authorAvatarUrl: "",
      imageUrl: "", images: [], downloadCount: 0, updatedUtc: "2026-01-01T00:00:00.000Z", tags: ["startpos"],
      sha256: "b".repeat(64), sizeBytes: 128
    };

    const [, forumResponse] = await Promise.all([
      store.publishCatalogEntry({
        submission,
        pack: {
          id: "upload-pack", tokenHash: "token", kind: "pack", batchId: "batch", submissionId: submission.id,
          maxBytes: 128, contentType: "application/octet-stream", uploadedBytes: 128, bytes: Buffer.alloc(128)
        },
        captures: [], now: new Date("2026-01-01T00:00:00.000Z"), captureSourceUrls: [],
        optimizeCatalogCapture: async () => catalogJpeg(),
        authorName: "Anonymous", authorAvatarUrl: ""
      }),
      signedBotJson(worker, "/bot/catalog/entries", { entry: forumEntry }, "forum-catalog-entry")
    ]);

    expect(forumResponse.status).toBe(200);
    expect(store.getCatalogIndexForTesting().packs.map(pack => pack.id).sort()).toEqual(["forum-entry", "upload-entry-uploadentry"]);

    const invalidDiscordResponse = await signedBotJson(worker, "/bot/catalog/entries", {
      entry: {
        ...forumEntry,
        id: "invalid-discord-entry",
        discordUrl: "https://example.com/channels/123456789012345678/234567890123456789"
      }
    }, "invalid-discord-catalog-entry");
    expect(invalidDiscordResponse.status).toBe(400);
    await expectJson(invalidDiscordResponse, { error: "catalog_discord_url_invalid" });
  });

  it("removes newly uploaded public objects when catalog commit fails", async () => {
    const store = new FailingCatalogMetadataStore();
    const submission: UploadBatchRecord["submissions"][number] = {
      id: "orphan-test", batchId: "batch", section: "StartPos", mapSid, mapUrl: "", title: "Orphan Test",
      description: "", packObjectId: "pack", captures: [], attribution: { mode: "anonymous" }, status: "moderating",
      validationReasons: []
    };
    const packBytes = Buffer.alloc(64);
    const publication = buildPublication(submission, [], new Date("2026-01-01T00:00:00.000Z"), "https://akron.example.test", packBytes);

    await expect(store.publishCatalogEntry({
      submission,
      pack: {
        id: "pack", tokenHash: "token", kind: "pack", batchId: "batch", submissionId: submission.id,
        maxBytes: 64, contentType: "application/octet-stream", uploadedBytes: 64, bytes: packBytes
      },
      captures: [], now: new Date("2026-01-01T00:00:00.000Z"), captureSourceUrls: [],
      optimizeCatalogCapture: async () => catalogJpeg(),
      authorName: "Anonymous", authorAvatarUrl: ""
    })).rejects.toThrow("Catalog commit failed");
    expect(store.getPublicObjectForTesting(publication.packKey)).toBeUndefined();
  });

  it("transforms trusted Discord catalog captures through the signed bot endpoint", async () => {
    const sourceUrl = "https://cdn.discordapp.com/attachments/channel/capture.png";
    let signedSourceUrl = "";
    const worker = createUploadWorker({
      store: new InMemoryUploadStore(),
      botSecret,
      optimizeCatalogCapture: async receivedSourceUrl => {
        signedSourceUrl = receivedSourceUrl;
        return catalogJpeg();
      },
      fetchCatalogCaptureSource: async (receivedSourceUrl, signal) => {
        expect(receivedSourceUrl).toBe(sourceUrl);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
        return new Response("source-image", {
          headers: {
            "content-type": "image/png",
            "content-length": "999"
          }
        });
      },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const transformed = await signedBotJson(worker, "/bot/catalog/captures/transform", {
      sourceUrl
    }, "transform-forum-capture");

    expect(transformed.status).toBe(200);
    await expectJson(transformed, {
      contentType: "image/jpeg",
      bytesBase64: catalogJpeg().bytes.toString("base64")
    });

    const parsedSignedSourceUrl = new URL(signedSourceUrl);
    expect(parsedSignedSourceUrl.origin).toBe(baseUrl);
    expect(parsedSignedSourceUrl.pathname).toBe("/bot/catalog/captures/source");
    expect(parsedSignedSourceUrl.searchParams.get("sourceUrl")).toBe(sourceUrl);

    const proxiedSource = await worker.fetch(new Request(signedSourceUrl));
    expect(proxiedSource.status).toBe(200);
    expect(proxiedSource.headers.get("content-type")).toBe("image/png");
    expect(proxiedSource.headers.get("content-length")).toBeNull();
    await expect(proxiedSource.text()).resolves.toBe("source-image");

    const tamperedSourceUrl = new URL(signedSourceUrl);
    tamperedSourceUrl.searchParams.set("signature", "0".repeat(64));
    const tamperedSource = await worker.fetch(new Request(tamperedSourceUrl));
    expect(tamperedSource.status).toBe(403);
    await expectJson(tamperedSource, { error: "source_url_invalid" });

    const expiredSourceUrl = new URL(signedSourceUrl);
    expiredSourceUrl.searchParams.set("expires", "1");
    const expiredSource = await worker.fetch(new Request(expiredSourceUrl));
    expect(expiredSource.status).toBe(403);
    await expectJson(expiredSource, { error: "source_url_expired" });
  });

  it("rejects untrusted catalog capture source URLs", async () => {
    const worker = createUploadWorker({
      store: new InMemoryUploadStore(),
      botSecret,
      optimizeCatalogCapture: async () => catalogJpeg(),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const transformed = await signedBotJson(worker, "/bot/catalog/captures/transform", {
      sourceUrl: "https://internal.example.test/capture.png"
    }, "reject-untrusted-capture");

    expect(transformed.status).toBe(400);
    await expectJson(transformed, { error: "catalog_capture_source_invalid" });
  });

  it("preserves sibling moderation updates while saving an approved submission", async () => {
    const store = new SiblingMutationDuringPublicationStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const firstPack = validArchive("StartPos");
    const secondPack = validArchive("StartPos");
    const preparedResponse = await prepare(worker, {
      submissions: [
        submissionInput({ title: "First StartPos", packSizeBytes: firstPack.length }),
        submissionInput({ title: "Second StartPos", packSizeBytes: secondPack.length })
      ]
    });
    expect(preparedResponse.status).toBe(201);
    const prepared = await preparedResponse.json() as {
      batchId: string;
      captures: Array<{ uploadUrl: string }>;
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    const firstSubmissionId = prepared.submissions[0]?.submissionId ?? "";
    const secondSubmissionId = prepared.submissions[1]?.submissionId ?? "";

    await worker.fetch(uploadRequest(prepared.captures[0]?.uploadUrl ?? "", Buffer.from("fake-png"), "image/png"));
    await worker.fetch(uploadRequest(prepared.submissions[0]?.pack.uploadUrl ?? "", firstPack, "application/octet-stream"));
    await worker.fetch(uploadRequest(prepared.submissions[1]?.pack.uploadUrl ?? "", secondPack, "application/octet-stream"));
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const claim = await signedBotJson(worker, "/bot/jobs/claim", { limit: 2 }, "nonce-sibling-claim");
    expect((await claim.json() as { jobs: unknown[] }).jobs).toHaveLength(2);

    store.siblingSubmissionId = secondSubmissionId;
    const approved = await signedBotJson(worker, `/bot/moderation/${firstSubmissionId}/approve`, {}, "nonce-sibling-approve");
    const status = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const statusBody = await status.json() as UploadStatusBody;

    expect(approved.status).toBe(200);
    expect(statusBody.submissions.find(submission => submission.submissionId === firstSubmissionId)?.status).toBe("published");
    expect(statusBody.submissions.find(submission => submission.submissionId === secondSubmissionId)?.status).toBe("rejected");
  });

  it("publishes with attribution changes made before the moderation lock is observed", async () => {
    const store = new AttributionMutationDuringReservationStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const prepared = await prepareAndUpload(worker, {
      attribution: { mode: "discord", discordUserId: "123456789012345678" },
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/attribution/${submissionId}/confirm`, {
      discordUserId: "123456789012345678"
    }, "nonce-reread-confirm");

    store.submissionId = submissionId;
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-reread-approve");

    expect(approved.status).toBe(200);
    expect(store.getCatalogIndexForTesting().packs[0]?.authorName).toBe("Anonymous");
  });

  it("rejects client withdrawal after publication", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-withdraw-published-approve");
    const withdrawn = await postJson(worker, `/uploads/${submissionId}/withdraw`, {
      installId,
      batchId: prepared.batchId
    });

    expect(withdrawn.status).toBe(409);
    await expectJson(withdrawn, { error: "submission_already_published" });
  });

  it("does not hydrate capture bytes during completion or approval", async () => {
    const store = new CaptureHydrationTrackingStore();
    const worker = createUploadWorker({
      store,
      botSecret,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    store.resetCaptureReadCounts();
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-no-capture-hydration");

    expect(store.captureMetadataReads).toBeGreaterThanOrEqual(2);
    expect(store.captureHydratedReads).toBe(0);
  });

  it("keeps mixed terminal batches published when one submission is live", async () => {
    const worker = testWorker();
    const firstPack = validArchive("StartPos");
    const secondPack = validArchive("AutoKill");
    const preparedResponse = await prepare(worker, {
      submissions: [
        submissionInput({ section: "StartPos", packSizeBytes: firstPack.length }),
        submissionInput({ section: "StartPos", packSizeBytes: secondPack.length })
      ]
    });
    const prepared = await preparedResponse.json() as {
      batchId: string;
      captures: Array<{ uploadUrl: string }>;
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    await worker.fetch(uploadRequest(prepared.captures[0]?.uploadUrl ?? "", Buffer.from("fake-png"), "image/png"));
    await worker.fetch(uploadRequest(prepared.submissions[0]?.pack.uploadUrl ?? "", firstPack, "application/octet-stream"));
    await worker.fetch(uploadRequest(prepared.submissions[1]?.pack.uploadUrl ?? "", secondPack, "application/octet-stream"));

    const complete = await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    const completeBody = await complete.json() as UploadStatusBody;
    expect(completeBody.status).toBe("queued");
    expect(completeBody.submissions.map(submission => submission.status).sort()).toEqual(["queued", "rejected"]);

    await signedBotJson(worker, `/bot/moderation/${prepared.submissions[0]?.submissionId ?? ""}/approve`, {}, "nonce-mixed-approve");
    const status = await worker.fetch(new Request(`${baseUrl}/uploads/status/${prepared.batchId}?installId=${encodeURIComponent(installId)}`));
    const statusBody = await status.json() as UploadStatusBody;

    expect(statusBody.status).toBe("published");
  });

  it("does not expire a live queued sibling with an attribution batch", () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const batch: UploadBatchRecord = {
      id: "mixed-attribution", installIdHash: "install", termsVersion: 1, status: "awaiting_attribution",
      createdUtc: "2026-01-01T00:00:00.000Z", updatedUtc: "2026-01-01T00:00:00.000Z",
      expiresUtc: "2026-01-01T01:00:00.000Z",
      submissions: [
        { id: "waiting", batchId: "mixed-attribution", section: "StartPos", mapSid, mapUrl: "", title: "Waiting", description: "", packObjectId: "waiting-pack", captures: [], attribution: { mode: "discord", discordUserId: "user", confirmed: false }, status: "awaiting_attribution", validationReasons: [] },
        { id: "live", batchId: "mixed-attribution", section: "StartPos", mapSid, mapUrl: "", title: "Live", description: "", packObjectId: "live-pack", captures: [], attribution: { mode: "anonymous" }, status: "queued", queuedUtc: "2026-01-01T23:00:00.000Z", validationReasons: [] }
      ]
    };

    expect(shouldDeleteQuarantineBatch(batch, now)).toBe(false);
  });

  it("rejects replayed signed bot actions", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });

    const submissionId = prepared.submissions[0]?.submissionId ?? "";
    const first = await signedBotJson(worker, `/bot/moderation/${submissionId}/reject`, {}, "same-nonce");
    const replay = await signedBotJson(worker, `/bot/moderation/${submissionId}/reject`, {}, "same-nonce");

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    await expectJson(replay, { error: "bot_signature_replayed" });
  });

  it("does not expose source captures without a valid signed URL", async () => {
    const worker = testWorker();

    const prepared = await prepareAndUpload(worker, {
      pack: validArchive("StartPos"),
      section: "StartPos"
    });
    const captureObjectId = new URL(prepared.captures[0]?.uploadUrl ?? "").pathname.split("/").at(-1) ?? "";

    const missingSignature = await worker.fetch(new Request(`${baseUrl}/uploads/source/${captureObjectId}`));
    expect(missingSignature.status).toBe(403);
    await expectJson(missingSignature, { error: "source_url_expired" });

    const invalidSignature = await worker.fetch(new Request(`${baseUrl}/uploads/source/${captureObjectId}?expires=1767225900000&signature=bad`));
    expect(invalidSignature.status).toBe(403);
    await expectJson(invalidSignature, { error: "source_url_invalid" });
  });
});

type TestWorker = ReturnType<typeof createUploadWorker>;

function createUploadWorker(options: UploadWorkerOptions): ReturnType<typeof createUploadWorkerCore> {
  return createUploadWorkerCore({
    optimizeCatalogCapture: async () => catalogJpeg(),
    ...options
  });
}

type UploadStatusBody = {
  batchId: string;
  status: string;
  submissions: Array<{
    submissionId: string;
    section: string;
    mapSid: string;
    attribution?: {
      mode?: string;
      label?: string;
      confirmed?: boolean;
      discordUserId?: string;
    };
    status: string;
    validationReasons: string[];
    publication?: {
      packId: string;
      packKey: string;
      downloadUrl: string;
      images: Array<{ key: string; url: string; roomName: string }>;
    };
  }>;
};

function testWorker(): TestWorker {
  return createUploadWorker({
    store: new InMemoryUploadStore(),
    botSecret,
    optimizeCatalogCapture: async () => catalogJpeg(),
    now: () => new Date("2026-01-01T00:00:00.000Z")
  });
}

function catalogJpeg(): { bytes: Buffer; contentType: "image/jpeg"; extension: "jpg" } {
  return {
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    contentType: "image/jpeg",
    extension: "jpg"
  };
}

class SiblingMutationDuringPublicationStore extends InMemoryUploadStore {
  siblingSubmissionId = "";
  private mutated = false;

  override async publishCatalogEntry(input: PublishCatalogEntryInput): Promise<CatalogPublication> {
    if (!this.mutated && this.siblingSubmissionId) {
      this.mutated = true;
      const batch = await this.getBatch(input.submission.batchId);
      const sibling = batch?.submissions.find(submission => submission.id === this.siblingSubmissionId);
      if (batch && sibling) {
        sibling.status = "rejected";
        sibling.validationReasons.push("Rejected by another moderator.");
        await this.putBatch(batch);
      }
    }

    return super.publishCatalogEntry(input);
  }
}

class AttributionMutationDuringReservationStore extends InMemoryUploadStore {
  submissionId = "";
  private mutated = false;

  override async tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean> {
    const reserved = await super.tryReserveModerationAction(batch, submissionId, now);
    if (reserved && !this.mutated && submissionId === this.submissionId) {
      this.mutated = true;
      const current = await this.getBatch(batch.id);
      const submission = current?.submissions.find(candidate => candidate.id === submissionId);
      if (current && submission) {
        submission.attribution = { mode: "anonymous" };
        await this.putBatch(current);
      }
    }
    return reserved;
  }
}

class MissingPackBytesOnceStore extends InMemoryUploadStore {
  packObjectId = "";
  private consumed = false;

  override async getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined> {
    const object = await super.getObject(id, options);
    if (!this.consumed && id === this.packObjectId && options?.includeBytes !== false) {
      this.consumed = true;
      if (object) {
        delete object.bytes;
      }
    }

    return object;
  }
}

class ThrowingPackReadOnceStore extends InMemoryUploadStore {
  packObjectId = "";
  private consumed = false;

  override async getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined> {
    if (!this.consumed && id === this.packObjectId && options?.includeBytes !== false) {
      this.consumed = true;
      throw new Error("Transient pack read failed.");
    }
    return super.getObject(id, options);
  }
}

class TinyPackCapUploadStore extends InMemoryUploadStore {
  override async putObject(record: UploadObjectRecord): Promise<void> {
    await super.putObject(record.kind === "pack" ? { ...record, maxBytes: 100 } : record);
  }
}

class FailingCatalogMetadataStore extends InMemoryUploadStore {
  override async publishCatalogMetadata(): Promise<void> {
    throw new Error("Catalog commit failed");
  }
}

function validArchive(section: string): Buffer {
  return zipJson({
    "manifest.json": {
      format: "akron-archive",
      formatVersion: 1,
      kind: "setup",
      kindVersion: 1,
      createdBy: "Akron",
      createdAt: "2026-01-01T00:00:00.000Z",
      target: { game: "Celeste", mapSid }
    },
    "setup.json": {
      format: "akron-setup-v2",
      name: `${section} Test Pack`,
      createdUtc: "2026-01-01T00:00:00.000Z",
      section,
      state: canonicalStateForSection(section),
      ...(section === "StartPos" ? { startPositions: {} } : {}),
      ...(section === "Keybinds" ? { buttonBindings: {}, menuActionBindings: {} } : {})
    }
  });
}

function submissionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    section: "StartPos",
    mapSid,
    title: "Beginner StartPos",
    description: "Start positions for practicing Beginner.",
    packSizeBytes: 512,
    attribution: { mode: "anonymous" },
    ...overrides
  };
}

async function prepare(
  worker: TestWorker,
  overrides: Record<string, unknown> = {}
): Promise<Response> {
  return postJson(worker, "/uploads/prepare", {
    installId,
    termsVersion: 1,
    captures: [{ roomName: "", sizeBytes: 128, contentType: "image/png" }],
    submissions: [submissionInput()],
    ...overrides
  });
}

async function prepareAndUpload(
  worker: TestWorker,
  input: {
    section: string;
    pack: Buffer;
    attribution?: Record<string, unknown>;
    mapUrl?: string;
  }
): Promise<{
  batchId: string;
  captures: Array<{ objectId: string; uploadUrl: string }>;
  submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
}> {
  const response = await prepare(worker, {
    submissions: [
      submissionInput({
        section: input.section,
        mapUrl: input.mapUrl ?? "",
        packSizeBytes: input.pack.length,
        attribution: input.attribution ?? { mode: "anonymous" }
      })
    ]
  });
  expect(response.status).toBe(201);
  const prepared = await response.json() as {
    batchId: string;
    captures: Array<{ objectId: string; uploadUrl: string }>;
    submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
  };

  for (const capture of prepared.captures) {
    const captureUpload = await worker.fetch(uploadRequest(capture.uploadUrl, Buffer.from("fake-png"), "image/png"));
    expect(captureUpload.status).toBe(200);
  }

  const packUpload = await worker.fetch(uploadRequest(
    prepared.submissions[0]?.pack.uploadUrl ?? "",
    input.pack,
    "application/octet-stream"
  ));
  expect(packUpload.status).toBe(200);
  return prepared;
}

function uploadRequest(url: string, bytes: Buffer, contentType: string, declaredLength = bytes.length): Request {
  return new Request(url, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "content-length": String(declaredLength)
    },
    body: toArrayBuffer(bytes)
  });
}

async function postJson(worker: TestWorker, path: string, body: unknown): Promise<Response> {
  return worker.fetch(new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10"
    },
    body: JSON.stringify(body)
  }));
}

async function signedBotJson(
  worker: TestWorker,
  path: string,
  body: unknown,
  nonce = "nonce",
  timestamp = "2026-01-01T00:00:00.000Z"
): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const signature = signBotRequest({
    secret: botSecret,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyText
  });
  return worker.fetch(new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-akron-timestamp": timestamp,
      "x-akron-nonce": nonce,
      "x-akron-signature": signature
    },
    body: bodyText
  }));
}

async function expectJson(response: Response, expected: Record<string, unknown>): Promise<void> {
  expect(await response.json()).toMatchObject(expected);
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

class ReferentialIntegrityUploadStore extends InMemoryUploadStore {
  override async putObject(record: UploadObjectRecord): Promise<void> {
    const batch = await this.getBatch(record.batchId);
    if (!batch) {
      throw new Error("Object parent batch is missing.");
    }
    if (record.submissionId && !batch.submissions.some(submission => submission.id === record.submissionId)) {
      throw new Error("Object parent submission is missing.");
    }
    await super.putObject(record);
  }
}

class CaptureHydrationTrackingStore extends InMemoryUploadStore {
  captureMetadataReads = 0;
  captureHydratedReads = 0;

  override async getObject(
    id: string,
    options?: { includeBytes?: boolean }
  ): Promise<UploadObjectRecord | undefined> {
    const object = await super.getObject(id, options);
    if (object?.kind === "capture") {
      if (options?.includeBytes === false) {
        this.captureMetadataReads += 1;
      } else {
        this.captureHydratedReads += 1;
      }
    }
    return object;
  }

  resetCaptureReadCounts(): void {
    this.captureMetadataReads = 0;
    this.captureHydratedReads = 0;
  }
}
