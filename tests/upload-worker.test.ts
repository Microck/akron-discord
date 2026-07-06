import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { akrMaxBytes, imageSourceMaxBytes } from "../src/submissions/types.js";
import {
  createUploadWorker,
  InMemoryUploadStore,
  signBotRequest,
  type CatalogPublication,
  type PublishCatalogEntryInput,
  type UploadBatchRecord,
  type UploadObjectRecord
} from "../src/upload-worker.js";
import { zipJson } from "./archive-fixtures.js";

const baseUrl = "https://uploads.example.test";
const botSecret = "test-secret";
const installId = "install-123";
const mapSid = "SpringCollab2020/1-Beginner";

describe("upload worker", () => {
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
        titleMaxLength: 120,
        descriptionMaxLength: 1_000,
        mapSidMaxLength: 512,
        submissionsMaxCount: 8
      },
      serverTimeUtc: "2026-01-01T00:00:00.000Z"
    });
  });

  it("indexes delivered moderation jobs before Cloudflare claim limits are applied", () => {
    const workerSource = readFileSync("src/upload-worker-cloudflare.ts", "utf8");
    const migrationSource = readFileSync("migrations/0001_uploads.sql", "utf8");
    const wranglerSource = readFileSync("wrangler.uploads.example.toml", "utf8");

    expect(migrationSource).toContain("moderation_delivered_utc TEXT");
    expect(workerSource).toContain("WHERE moderation_delivered_utc IS NULL");
    expect(workerSource).toContain("moderation_delivered_utc = excluded.moderation_delivered_utc");
    expect(workerSource).toContain("UPLOAD_QUARANTINE_BUCKET");
    expect(workerSource).toContain("UPLOAD_PUBLIC_BUCKET");
    expect(workerSource).toContain("this.quarantineBucket.put");
    expect(workerSource).toContain("this.publicBucket.put");
    expect(workerSource).toContain("acquireCatalogLock");
    expect(workerSource).toContain("upload_catalog_locks");
    expect(migrationSource).toContain("CREATE TABLE IF NOT EXISTS upload_catalog_locks");
    expect(wranglerSource).toContain("binding = \"UPLOAD_QUARANTINE_BUCKET\"");
    expect(wranglerSource).toContain("binding = \"UPLOAD_PUBLIC_BUCKET\"");
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

  it("rejects packs and captures above the upload budget", async () => {
    const worker = testWorker();

    const packResponse = await prepare(worker, {
      submissions: [submissionInput({ packSizeBytes: akrMaxBytes + 1 })]
    });
    expect(packResponse.status).toBe(413);
    await expectJson(packResponse, { error: "pack_too_large", maxBytes: akrMaxBytes });

    const captureResponse = await prepare(worker, {
      capture: { sizeBytes: imageSourceMaxBytes + 1, contentType: "image/png" }
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

  it("rejects unsupported capture image types at prepare and PUT time", async () => {
    const worker = testWorker();

    const svgPrepare = await prepare(worker, {
      capture: { sizeBytes: 128, contentType: "image/svg+xml" }
    });
    expect(svgPrepare.status).toBe(415);
    await expectJson(svgPrepare, { error: "capture_type_unsupported" });

    const preparedResponse = await prepare(worker);
    const prepared = await preparedResponse.json() as {
      capture: { uploadUrl: string };
    };
    const svgPut = await worker.fetch(uploadRequest(prepared.capture.uploadUrl, Buffer.from("<svg />"), "image/svg+xml"));
    expect(svgPut.status).toBe(415);
    await expectJson(svgPut, { error: "capture_type_unsupported" });
  });

  it("requires uploaded objects to declare content length before streaming", async () => {
    const worker = testWorker();
    const preparedResponse = await prepare(worker);
    const prepared = await preparedResponse.json() as {
      capture: { uploadUrl: string };
    };

    const upload = await worker.fetch(new Request(prepared.capture.uploadUrl, {
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
    await expectJson(firstComplete, { error: "internal_error", message: "Transient pack read failed." });
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
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      batchId: prepared.batchId,
      submissionId: prepared.submissions[0]?.submissionId,
      section: "StartPos",
      status: "reviewing",
      attribution: { label: "Anonymous" }
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

    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-approve");
    const approvedBody = await approved.json() as UploadStatusBody;
    expect(approved.status).toBe(200);
    expect(approvedBody.status).toBe("published");
    expect(approvedBody.submissions[0]?.status).toBe("published");
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
    const approved = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "nonce-published-approve");
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
    const first = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "publish-once");
    const second = await signedBotJson(worker, `/bot/moderation/${submissionId}/approve`, {}, "publish-twice");
    const published = await second.json() as UploadStatusBody;
    const publication = published.submissions[0]?.publication;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(publication).toMatchObject({
      packKey: expect.stringMatching(/^packs\/springcollab2020-1-beginner\//),
      imageKey: expect.stringMatching(/^captures\/springcollab2020-1-beginner\/.+\.webp$/),
      downloadUrl: expect.stringMatching(/^https:\/\/akron\.example\.test\/maps\/springcollab2020-1-beginner\/.+\.akr$/),
      imageUrl: expect.stringMatching(/^https:\/\/akron\.example\.test\/maps\/springcollab2020-1-beginner\/.+\/capture\.webp$/)
    });
    expect(store.getPublicObjectForTesting(publication?.packKey ?? "")?.contentType).toBe("application/octet-stream");
    expect(store.getPublicObjectForTesting(publication?.imageKey ?? "")?.contentType).toBe("image/webp");
    const catalog = store.getCatalogIndexForTesting();
    expect(catalog.packs).toHaveLength(1);
    expect(catalog.packs[0]).toMatchObject({
      title: "Beginner StartPos",
      section: "StartPos",
      mapSid,
      mapUrl: "https://gamebanana.com/mods/150453",
      authorName: "Anonymous"
    });
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
      capture: undefined,
      submissions: [submissionInput({ packSizeBytes: pack.length })]
    });
    expect(preparedResponse.status).toBe(201);
    const prepared = await preparedResponse.json() as {
      batchId: string;
      capture?: { uploadUrl: string };
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    expect(prepared.capture).toBeUndefined();

    await worker.fetch(uploadRequest(prepared.submissions[0]?.pack.uploadUrl ?? "", pack, "application/octet-stream"));
    await postJson(worker, "/uploads/complete", {
      installId,
      batchId: prepared.batchId
    });
    await signedBotJson(worker, `/bot/moderation/${prepared.submissions[0]?.submissionId ?? ""}/approve`, {}, "pack-only-approve");
    const catalog = store.getCatalogIndexForTesting();

    expect(catalog.packs[0]).toMatchObject({
      imageUrl: "",
      mapSid
    });
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
      capture: { uploadUrl: string };
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    const firstSubmissionId = prepared.submissions[0]?.submissionId ?? "";
    const secondSubmissionId = prepared.submissions[1]?.submissionId ?? "";

    await worker.fetch(uploadRequest(prepared.capture.uploadUrl, Buffer.from("fake-png"), "image/png"));
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
      capture: { uploadUrl: string };
      submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
    };
    await worker.fetch(uploadRequest(prepared.capture.uploadUrl, Buffer.from("fake-png"), "image/png"));
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
    const captureObjectId = new URL(prepared.capture.uploadUrl).pathname.split("/").at(-1) ?? "";

    const missingSignature = await worker.fetch(new Request(`${baseUrl}/uploads/source/${captureObjectId}`));
    expect(missingSignature.status).toBe(403);
    await expectJson(missingSignature, { error: "source_url_expired" });

    const invalidSignature = await worker.fetch(new Request(`${baseUrl}/uploads/source/${captureObjectId}?expires=1767225900000&signature=bad`));
    expect(invalidSignature.status).toBe(403);
    await expectJson(invalidSignature, { error: "source_url_invalid" });
  });
});

type TestWorker = ReturnType<typeof createUploadWorker>;

type UploadStatusBody = {
  batchId: string;
  status: string;
  submissions: Array<{
    submissionId: string;
    section: string;
    mapSid: string;
    status: string;
    validationReasons: string[];
    publication?: {
      packKey: string;
      imageKey: string;
      downloadUrl: string;
      imageUrl: string;
    };
  }>;
};

function testWorker(): TestWorker {
  return createUploadWorker({
    store: new InMemoryUploadStore(),
    botSecret,
    now: () => new Date("2026-01-01T00:00:00.000Z")
  });
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

function validArchive(section: string): Buffer {
  return zipJson({
    "manifest.json": {
      Format: "akron-archive",
      Kind: "setup",
      Target: { MapSid: mapSid }
    },
    "setup.json": {
      Format: "akron-setup-v1",
      Name: `${section} Test Pack`,
      Section: section
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
    capture: { sizeBytes: 128, contentType: "image/png" },
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
  capture: { uploadUrl: string };
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
    capture: { uploadUrl: string };
    submissions: Array<{ submissionId: string; pack: { uploadUrl: string } }>;
  };

  const captureUpload = await worker.fetch(uploadRequest(prepared.capture.uploadUrl, Buffer.from("fake-png"), "image/png"));
  expect(captureUpload.status).toBe(200);

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
    headers: { "content-type": "application/json" },
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
