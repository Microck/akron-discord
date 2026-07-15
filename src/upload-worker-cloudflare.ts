import {
  buildCatalogPack,
  buildPublication,
  capUploadBodyStream,
  createUploadWorker,
  emptyCatalogIndex,
  isCatalogDiscordUrl,
  mergeCatalogIndex,
  moderationClaimLeaseMs,
  shouldDeleteQuarantineBatch,
  type CatalogIndex,
  type CatalogPack,
  type DeletedUploadSubmission,
  type DeleteSubmissionInput,
  type PendingUploadedObjectBody,
  type PublishCatalogEntryInput,
  type PutOptimizedCaptureInput,
  type RecordAiReviewInput,
  type RecordDiscordMessageInput,
  type UploadBatchRecord,
  type UploadObjectRecord,
  type UploadQuotaReservationInput,
  type UploadedObjectBody,
  type UploadedObjectWriteResult,
  type UploadSubmissionRecord,
  type UploadWorkerStore,
  UploadTooLargeError
} from "./upload-worker.js";
import { createHash, randomUUID } from "node:crypto";
import { catalogImageMaxBytes } from "./submissions/types.js";

export type CloudflareUploadEnv = {
  UPLOAD_DB: D1Database;
  UPLOAD_QUARANTINE_BUCKET: R2Bucket;
  UPLOAD_PUBLIC_BUCKET: R2Bucket;
  UPLOAD_PREPARE_RATE_LIMITER: RateLimitBinding;
  UPLOAD_OBJECT_RATE_LIMITER: RateLimitBinding;
  UPLOAD_COMPLETE_RATE_LIMITER: RateLimitBinding;
  UPLOAD_ATTRIBUTION_RATE_LIMITER: RateLimitBinding;
  BOT_HMAC_SECRET: string;
  UPLOAD_TERMS_VERSION?: string;
  UPLOAD_PUBLIC_BASE_URL?: string;
  UPLOAD_PUBLIC_UPLOAD_BASE_URL?: string;
};

type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

type EdgeRateLimitEnv = Pick<CloudflareUploadEnv,
  | "UPLOAD_PREPARE_RATE_LIMITER"
  | "UPLOAD_OBJECT_RATE_LIMITER"
  | "UPLOAD_COMPLETE_RATE_LIMITER"
  | "UPLOAD_ATTRIBUTION_RATE_LIMITER"
>;

type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]>;
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
};

type D1RunResult = {
  meta?: {
    changes?: number;
  };
};

type DurableLock = {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

type R2Bucket = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
};

type R2ObjectBody = {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: {
    contentType?: string;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
};

type FixedLengthStreamConstructor = new (expectedLength: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type ImageTransformInit = RequestInit & {
  cf: {
    image: {
      fit: "scale-down";
      width: number;
      format: "jpeg";
      quality: number;
      metadata: "none";
    };
  };
};

export const catalogCaptureTransformAttempts = [
  { width: 2048, quality: 82 },
  { width: 1792, quality: 78 },
  { width: 1536, quality: 74 },
  { width: 1280, quality: 70 },
  { width: 1024, quality: 66 }
] as const;

type BatchRow = {
  payload_json: string;
};

type ObjectRow = {
  id: string;
  token_hash: string;
  kind: "pack" | "capture";
  batch_id: string;
  submission_id: string | null;
  max_bytes: number;
  content_type: string;
  r2_key: string;
  uploaded_bytes: number | null;
};

type CatalogEntryRow = {
  entry_json: string;
};

const uploadObjectPrefix = "quarantine/uploads";
const optimizedCapturePrefix = "quarantine/optimized-captures";

export default {
  async fetch(request: Request, env: CloudflareUploadEnv): Promise<Response> {
    if (!env.BOT_HMAC_SECRET || env.BOT_HMAC_SECRET.length < 32) {
      return new Response(JSON.stringify({ error: "upload_service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const rateLimitResponse = await enforceEdgeRateLimit(request, env);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
    const worker = createUploadWorker({
      store: new CloudflareUploadStore(env.UPLOAD_DB, env.UPLOAD_QUARANTINE_BUCKET, env.UPLOAD_PUBLIC_BUCKET, env.UPLOAD_PUBLIC_BASE_URL),
      botSecret: env.BOT_HMAC_SECRET,
      publicUploadBaseUrl: env.UPLOAD_PUBLIC_UPLOAD_BASE_URL,
      termsVersion: readTermsVersion(env.UPLOAD_TERMS_VERSION)
    });
    return worker.fetch(request);
  },

  async scheduled(_controller: unknown, env: CloudflareUploadEnv): Promise<void> {
    if (!env.BOT_HMAC_SECRET || env.BOT_HMAC_SECRET.length < 32) {
      throw new Error("BOT_HMAC_SECRET must be at least 32 characters.");
    }
    const store = new CloudflareUploadStore(
      env.UPLOAD_DB,
      env.UPLOAD_QUARANTINE_BUCKET,
      env.UPLOAD_PUBLIC_BUCKET,
      env.UPLOAD_PUBLIC_BASE_URL
    );
    await store.cleanupExpired(new Date(), 100);
  }
};

export async function enforceEdgeRateLimit(request: Request, env: EdgeRateLimitEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const limiter = edgeLimiterForRequest(request.method, url.pathname, env);
  if (limiter === undefined) {
    return undefined;
  }
  if (limiter === null) {
    return edgeError("upload_service_unavailable", 503);
  }

  // Cloudflare supplies this header at the Worker boundary. Hashing keeps the
  // transient counter key from containing the client's raw network address.
  const clientAddress = request.headers.get("cf-connecting-ip")?.trim();
  if (!clientAddress) {
    return edgeError("network_identity_required", 403);
  }
  const key = createHash("sha256").update(clientAddress).digest("hex");
  try {
    const decision = await limiter.limit({ key });
    return decision.success ? undefined : edgeError("edge_rate_limit_exceeded", 429, { "retry-after": "60" });
  } catch (error) {
    console.error("Upload edge rate limiter failed.", error);
    return edgeError("upload_service_unavailable", 503);
  }
}

function edgeLimiterForRequest(method: string, pathname: string, env: EdgeRateLimitEnv): RateLimitBinding | null | undefined {
  if (method === "POST" && pathname === "/uploads/prepare") return env.UPLOAD_PREPARE_RATE_LIMITER ?? null;
  if (method === "PUT" && /^\/uploads\/objects\/[^/]+$/.test(pathname)) return env.UPLOAD_OBJECT_RATE_LIMITER ?? null;
  if (method === "POST" && pathname === "/uploads/complete") return env.UPLOAD_COMPLETE_RATE_LIMITER ?? null;
  if (method === "POST" && /^\/bot\/attribution\/[^/]+\/confirm$/.test(pathname)) return env.UPLOAD_ATTRIBUTION_RATE_LIMITER ?? null;
  return undefined;
}

function edgeError(error: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

export class CloudflareUploadStore implements UploadWorkerStore {
  constructor(
    private readonly db: D1Database,
    private readonly quarantineBucket: R2Bucket,
    private readonly publicBucket: R2Bucket,
    private readonly publicBaseUrl = "https://akron.micr.dev"
  ) {}

  async getBatch(id: string): Promise<UploadBatchRecord | undefined> {
    const row = await this.db
      .prepare("SELECT payload_json FROM upload_batches WHERE id = ?")
      .bind(id)
      .first<BatchRow>();
    return row ? JSON.parse(row.payload_json) as UploadBatchRecord : undefined;
  }

  async findSubmission(submissionId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    const row = await this.db
      .prepare("SELECT batch_id FROM upload_submissions WHERE id = ?")
      .bind(submissionId)
      .first<{ batch_id: string }>();
    if (!row) {
      return undefined;
    }

    const batch = await this.getBatch(row.batch_id);
    const submission = batch?.submissions.find(candidate => candidate.id === submissionId);
    return batch && submission ? { batch, submission } : undefined;
  }

  async findSubmissionByDiscordThread(threadId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    const row = await this.db
      .prepare([
        "SELECT upload_batches.id AS batch_id",
        "FROM upload_batches, json_each(upload_batches.payload_json, '$.submissions')",
        "WHERE json_extract(json_each.value, '$.discord.publication.threadId') = ?",
        "LIMIT 1"
      ].join(" "))
      .bind(threadId)
      .first<{ batch_id: string }>();
    if (!row) {
      return undefined;
    }

    const batch = await this.getBatch(row.batch_id);
    const submission = batch?.submissions.find(candidate => candidate.discord?.publication?.threadId === threadId);
    return batch && submission ? { batch, submission } : undefined;
  }

  async tryBeginCompletion(batch: UploadBatchRecord): Promise<boolean> {
    const release = await this.acquireBatchLock(batch.id);
    try {
      const locked = await this.db
        .prepare([
          "UPDATE upload_batches",
          "SET status = ?, updated_utc = ?, payload_json = ?",
          "WHERE id = ? AND status = 'prepared'"
        ].join(" "))
        .bind(batch.status, batch.updatedUtc, JSON.stringify(batch), batch.id)
        .run();
      return (locked.meta?.changes ?? 0) === 1;
    } finally {
      await release();
    }
  }

  async tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const release = await this.acquireBatchLock(batch.id);
    try {
      const row = await this.db.prepare("SELECT status FROM upload_submissions WHERE id = ? AND batch_id = ?")
        .bind(submissionId, batch.id).first<{ status: string }>();
      if (!row || !["queued", "reviewing", "awaiting_attribution"].includes(row.status)) return false;
      const current = await this.getBatch(batch.id);
      const submission = current?.submissions.find(candidate => candidate.id === submissionId);
      if (!current || !submission) return false;
      submission.status = "moderating";
      submission.reviewClaimedUtc = nowIso;
      current.updatedUtc = nowIso;
      current.status = deriveBatchStatusForStore(current);
      await this.db.batch([
        this.db.prepare("UPDATE upload_submissions SET status = 'moderating', updated_utc = ? WHERE id = ? AND batch_id = ?")
          .bind(nowIso, submissionId, batch.id),
        this.db.prepare("UPDATE upload_batches SET status = ?, updated_utc = ?, payload_json = ? WHERE id = ?")
          .bind(current.status, nowIso, JSON.stringify(current), current.id)
      ]);
      return true;
    } finally {
      await release();
    }
  }

  async claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>> {
    const nowIso = now.toISOString();
    const leaseCutoffUtc = new Date(now.getTime() - moderationClaimLeaseMs).toISOString();
    const rows = await this.db
      .prepare([
        "SELECT id FROM upload_submissions",
        "WHERE moderation_delivered_utc IS NULL",
        "AND moderation_attempts < 5",
        "AND (status IN ('queued', 'awaiting_attribution')",
        "OR (status IN ('reviewing', 'moderating') AND updated_utc <= ?))",
        "AND EXISTS (SELECT 1 FROM upload_batches batch WHERE batch.id = upload_submissions.batch_id",
        "AND (upload_submissions.status != 'awaiting_attribution' OR batch.expires_utc > ?))",
        "AND (attribution_discord_user_id IS NULL OR NOT EXISTS (",
        "SELECT 1 FROM upload_attribution_deliveries delivered",
        "WHERE delivered.discord_user_id = upload_submissions.attribution_discord_user_id",
        "AND delivered.delivered_utc > ?))",
        "AND (attribution_discord_user_id IS NULL OR id = (",
        "SELECT MIN(candidate.id) FROM upload_submissions candidate",
        "WHERE candidate.attribution_discord_user_id = upload_submissions.attribution_discord_user_id",
        "AND candidate.moderation_delivered_utc IS NULL",
        "AND (candidate.status IN ('queued', 'awaiting_attribution')",
        "OR (candidate.status IN ('reviewing', 'moderating') AND candidate.updated_utc <= ?))))",
        "ORDER BY updated_utc ASC",
        "LIMIT ?"
      ].join(" "))
      .bind(
        leaseCutoffUtc,
        nowIso,
        new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        leaseCutoffUtc,
        limit
      )
      .all<{ id: string }>();
    const jobs: Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }> = [];
    for (const row of rows.results) {
      const initial = await this.findSubmission(row.id);
      if (!initial) continue;
      const release = await this.acquireBatchLock(initial.batch.id);
      try {
        const job = await this.findSubmission(row.id);
        const normalized = await this.db.prepare(
          "SELECT status, updated_utc, moderation_delivered_utc, moderation_attempts FROM upload_submissions WHERE id = ?"
        ).bind(row.id).first<{ status: string; updated_utc: string; moderation_delivered_utc: string | null; moderation_attempts: number }>();
        if (!job || !normalized || normalized.moderation_delivered_utc ||
            normalized.moderation_attempts >= 5 ||
            !(normalized.status === "queued" || normalized.status === "awaiting_attribution" ||
              (["reviewing", "moderating"].includes(normalized.status) && normalized.updated_utc <= leaseCutoffUtc))) continue;
        job.submission.status = "reviewing";
        job.submission.moderationAttempts = (job.submission.moderationAttempts ?? 0) + 1;
        job.submission.reviewClaimedUtc = nowIso;
        delete job.submission.moderationDeliveredUtc;
        job.batch.updatedUtc = nowIso;
        job.batch.status = deriveBatchStatusForStore(job.batch);
        await this.db.batch([
          this.db.prepare("UPDATE upload_submissions SET status = 'reviewing', updated_utc = ?, moderation_delivered_utc = NULL, moderation_attempts = moderation_attempts + 1 WHERE id = ?")
            .bind(nowIso, row.id),
          this.db.prepare("UPDATE upload_batches SET status = ?, updated_utc = ?, payload_json = ? WHERE id = ?")
            .bind(job.batch.status, nowIso, JSON.stringify(job.batch), job.batch.id)
        ]);
        jobs.push(job);
      } finally {
        await release();
      }
    }
    return jobs;
  }

  async putBatch(batch: UploadBatchRecord): Promise<void> {
    const release = await this.acquireBatchLock(batch.id);
    try {
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare([
          "INSERT INTO upload_batches (id, install_id_hash, terms_version, status, created_utc, updated_utc, expires_utc, payload_json)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          "ON CONFLICT(id) DO UPDATE SET",
          "install_id_hash = excluded.install_id_hash,",
          "terms_version = excluded.terms_version,",
          "status = excluded.status,",
          "updated_utc = excluded.updated_utc,",
          "expires_utc = excluded.expires_utc,",
          "payload_json = excluded.payload_json"
        ].join(" "))
        .bind(
          batch.id,
          batch.installIdHash,
          batch.termsVersion,
          batch.status,
          batch.createdUtc,
          batch.updatedUtc,
          batch.expiresUtc,
          JSON.stringify(batch)
        )
    ];

    for (const submission of batch.submissions) {
      statements.push(this.db
        .prepare([
          "INSERT INTO upload_submissions (id, batch_id, section, status, map_sid, updated_utc, moderation_delivered_utc, attribution_discord_user_id, queued_utc, moderation_attempts)",
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "ON CONFLICT(id) DO UPDATE SET",
          "batch_id = excluded.batch_id,",
          "section = excluded.section,",
          "status = excluded.status,",
          "map_sid = excluded.map_sid,",
          "updated_utc = excluded.updated_utc,",
          "moderation_delivered_utc = excluded.moderation_delivered_utc,",
          "attribution_discord_user_id = excluded.attribution_discord_user_id,",
          "queued_utc = excluded.queued_utc,",
          "moderation_attempts = excluded.moderation_attempts"
        ].join(" "))
        .bind(
          submission.id,
          batch.id,
          submission.section,
          submission.status,
          submission.mapSid,
          submission.reviewClaimedUtc ?? batch.updatedUtc,
          submission.moderationDeliveredUtc ?? null,
          submission.attribution.mode === "discord" && !submission.attribution.confirmed
            ? submission.attribution.discordUserId
            : null,
          submission.queuedUtc ?? null,
          submission.moderationAttempts ?? 0
        )
      );
    }
    await this.db.batch(statements);
    } finally {
      await release();
    }
  }

  async mutateSubmission(
    submissionId: string,
    now: Date,
    mutate: (submission: UploadSubmissionRecord) => void
  ): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    const row = await this.db.prepare("SELECT batch_id FROM upload_submissions WHERE id = ?")
      .bind(submissionId).first<{ batch_id: string }>();
    if (!row) return undefined;
    const batchId = row.batch_id;
    const release = await this.acquireBatchLock(batchId);
    try {
      const current = await this.getBatch(batchId);
      const index = current?.submissions.findIndex(candidate => candidate.id === submissionId) ?? -1;
      if (!current || index < 0) return undefined;
      const submission = current.submissions[index];
      if (!submission) return undefined;
      mutate(submission);
      current.updatedUtc = now.toISOString();
      current.status = deriveBatchStatusForStore(current);
      await this.db.batch([
        this.db.prepare([
          "UPDATE upload_batches SET status = ?, updated_utc = ?, payload_json = ? WHERE id = ?"
        ].join(" ")).bind(current.status, current.updatedUtc, JSON.stringify(current), current.id),
        this.db.prepare([
          "UPDATE upload_submissions SET status = ?, updated_utc = ?, moderation_delivered_utc = ?, attribution_discord_user_id = ?, queued_utc = ?, moderation_attempts = ?",
          "WHERE id = ? AND batch_id = ?"
        ].join(" ")).bind(
          submission.status,
          submission.reviewClaimedUtc ?? current.updatedUtc,
          submission.moderationDeliveredUtc ?? null,
          submission.attribution.mode === "discord" && !submission.attribution.confirmed
            ? submission.attribution.discordUserId
            : null,
          submission.queuedUtc ?? null,
          submission.moderationAttempts ?? 0,
          submission.id,
          current.id
        )
      ]);
      return { batch: current, submission: structuredClone(submission) };
    } finally {
      await release();
    }
  }

  async putObject(record: UploadObjectRecord): Promise<void> {
    const r2Key = buildUploadObjectKey(record);
    await this.db
      .prepare([
        "INSERT INTO upload_objects (id, token_hash, kind, batch_id, submission_id, max_bytes, content_type, r2_key, uploaded_bytes)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ON CONFLICT(id) DO UPDATE SET",
        "token_hash = excluded.token_hash,",
        "kind = excluded.kind,",
        "batch_id = excluded.batch_id,",
        "submission_id = excluded.submission_id,",
        "max_bytes = excluded.max_bytes,",
        "content_type = excluded.content_type,",
        "r2_key = excluded.r2_key"
      ].join(" "))
      .bind(
        record.id,
        record.tokenHash,
        record.kind,
        record.batchId,
        record.submissionId ?? null,
        record.maxBytes,
        record.contentType,
        r2Key,
        record.uploadedBytes ?? null
      )
      .run();
  }

  async getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined> {
    const row = await this.db
      .prepare([
        "SELECT id, token_hash, kind, batch_id, submission_id, max_bytes, content_type, r2_key, uploaded_bytes",
        "FROM upload_objects WHERE id = ?"
      ].join(" "))
      .bind(id)
      .first<ObjectRow>();
    if (!row) {
      return undefined;
    }

    const object: UploadObjectRecord = {
      id: row.id,
      tokenHash: row.token_hash,
      kind: row.kind,
      batchId: row.batch_id,
      submissionId: row.submission_id ?? undefined,
      maxBytes: row.max_bytes,
      contentType: row.content_type,
      uploadedBytes: row.uploaded_bytes ?? undefined
    };
    if (row.uploaded_bytes !== null && options?.includeBytes !== false) {
      const stored = await this.quarantineBucket.get(row.r2_key);
      if (stored) {
        object.bytes = Buffer.from(await stored.arrayBuffer());
      }
    }
    return object;
  }

  async getUploadedObjectBody(id: string): Promise<UploadedObjectBody | undefined> {
    const row = await this.db
      .prepare("SELECT r2_key, content_type, uploaded_bytes FROM upload_objects WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string; content_type: string; uploaded_bytes: number | null }>();
    if (!row || row.uploaded_bytes === null) {
      return undefined;
    }
    const stored = await this.quarantineBucket.get(row.r2_key);
    if (!stored) {
      return undefined;
    }
    return {
      body: stored.body,
      contentType: stored.httpMetadata?.contentType ?? row.content_type,
      uploadedBytes: row.uploaded_bytes
    };
  }

  async putUploadedObject(id: string, upload: PendingUploadedObjectBody): Promise<UploadedObjectWriteResult> {
    const row = await this.db
      .prepare("SELECT r2_key, max_bytes, batch_id FROM upload_objects WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string; max_bytes: number; batch_id: string }>();
    if (!row) {
      throw new Error("Upload object does not exist.");
    }

    const release = await this.acquireBatchLock(row.batch_id);
    let reserved: D1RunResult;
    try {
      reserved = await this.db
        .prepare([
          "UPDATE upload_objects",
          "SET uploaded_bytes = -1",
          "WHERE id = ?",
          "AND uploaded_bytes IS NULL",
          "AND EXISTS (SELECT 1 FROM upload_batches WHERE upload_batches.id = upload_objects.batch_id AND upload_batches.status = 'prepared')"
        ].join(" "))
        .bind(id)
        .run();
    } finally {
      await release();
    }
    if ((reserved.meta?.changes ?? 0) !== 1) {
      return { ok: false };
    }

    let cappedUpload: ReturnType<typeof capUploadBodyStream> | undefined;
    try {
      cappedUpload = capUploadBodyStream(upload.body, row.max_bytes);
      const knownLengthBody = await bodyWithKnownLength(cappedUpload.body, upload.declaredBytes);
      await this.quarantineBucket.put(row.r2_key, knownLengthBody.body, {
        httpMetadata: { contentType: upload.contentType }
      });
      await knownLengthBody.completed;
      const uploadedBytes = await cappedUpload.uploadedBytes;
      await this.db
        .prepare("UPDATE upload_objects SET uploaded_bytes = ?, content_type = ? WHERE id = ? AND uploaded_bytes = -1")
        .bind(uploadedBytes, upload.contentType, id)
        .run();
      return { ok: true, uploadedBytes };
    } catch (error) {
      void cappedUpload?.uploadedBytes.catch(() => undefined);
      await this.db
        .prepare("UPDATE upload_objects SET uploaded_bytes = NULL WHERE id = ? AND uploaded_bytes = -1")
        .bind(id)
        .run();
      if (error instanceof UploadTooLargeError) {
        throw error;
      }
      throw error;
    }
  }

  async publishCatalogEntry(input: PublishCatalogEntryInput): Promise<ReturnType<typeof buildPublication>> {
    const packBytes = input.pack.bytes;
    if (!packBytes || input.captures.some(capture => capture.uploadedBytes === undefined)) {
      throw new Error("Cannot publish missing upload objects.");
    }

    const publicCaptures = await this.publicCapturesForPublication(input);
    const publication = buildPublication(input.submission, publicCaptures, input.now, this.publicBaseUrl, packBytes);
    const createdKeys: string[] = [];
    try {
      const packAlreadyExists = await this.publicBucket.get(publication.packKey) !== null;
      await this.publicBucket.put(publication.packKey, packBytes, {
        httpMetadata: { contentType: "application/octet-stream" }
      });
      if (!packAlreadyExists) createdKeys.push(publication.packKey);
      for (const [index, image] of publication.images.entries()) {
        const capture = publicCaptures[index];
        if (!capture?.bytes) throw new Error("Cannot publish missing optimized capture bytes.");
        const imageAlreadyExists = await this.publicBucket.get(image.key) !== null;
        await this.publicBucket.put(image.key, capture.bytes, {
          httpMetadata: { contentType: capture.contentType }
        });
        if (!imageAlreadyExists) createdKeys.push(image.key);
      }
      const entry = await this.fillCatalogMapUrl(buildCatalogPack(
        input.submission,
        publication,
        input.now,
        input.authorName,
        input.authorAvatarUrl
      ));
      await this.publishCatalogMetadata(entry);
    } catch (error) {
      for (const key of createdKeys) await this.publicBucket.delete(key);
      throw error;
    }
    return publication;
  }

  async publishCatalogMetadata(entry: CatalogPack): Promise<void> {
    const catalogLock = await this.acquireCatalogLock();
    try {
      const normalizedEntry = await this.fillCatalogMapUrl(entry);
      const previousRow = await this.db
        .prepare("SELECT entry_json FROM upload_catalog_entries WHERE id = ?")
        .bind(normalizedEntry.id)
        .first<CatalogEntryRow>();
      const nextIndex = await this.upsertCatalogEntry(normalizedEntry);
      try {
        await catalogLock.assertOwned();
        await this.publicBucket.put("catalog/index.json", JSON.stringify(nextIndex, null, 2) + "\n", {
          httpMetadata: { contentType: "application/json" }
        });
      } catch (error) {
        try {
          if (previousRow) {
            await this.upsertCatalogEntry(JSON.parse(previousRow.entry_json) as CatalogPack);
          } else {
            await this.deleteCatalogEntry(normalizedEntry.id);
          }
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Catalog index write and metadata rollback both failed.");
        }
        throw error;
      }
    } finally {
      await catalogLock.release();
    }
  }

  async recordAiReview(input: RecordAiReviewInput): Promise<UploadSubmissionRecord | undefined> {
    return (await this.mutateSubmission(input.submissionId, input.now, submission => {
      submission.aiReview = { ...input.review, reviewedUtc: input.now.toISOString() };
    }))?.submission;
  }

  async putOptimizedCapture(input: PutOptimizedCaptureInput): Promise<UploadSubmissionRecord | undefined> {
    const found = await this.findSubmission(input.submissionId);
    if (!found) {
      return undefined;
    }

    const capture = found.submission.captures.find(candidate => candidate.objectId === input.objectId);
    if (!capture) {
      return undefined;
    }
    const revision = createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);
    const r2Key = `${optimizedCapturePrefix}/${found.batch.id}/${found.submission.id}/${capture.objectId}-${revision}.jpg`;
    await this.quarantineBucket.put(r2Key, input.bytes, {
      httpMetadata: { contentType: input.contentType }
    });
    let previousKey: string | undefined;
    try {
      const saved = await this.mutateSubmission(input.submissionId, input.now, submission => {
        const currentCapture = submission.captures.find(candidate => candidate.objectId === input.objectId);
        if (!currentCapture) throw new Error("Capture no longer exists.");
        previousKey = currentCapture.optimized?.r2Key;
        currentCapture.optimized = {
          r2Key,
          contentType: input.contentType,
          uploadedBytes: input.bytes.length,
          extension: "jpg"
        };
      });
      if (!saved) {
        await this.quarantineBucket.delete(r2Key);
        return undefined;
      }
      if (previousKey && previousKey !== r2Key) await this.quarantineBucket.delete(previousKey);
      return saved.submission;
    } catch (error) {
      await this.quarantineBucket.delete(r2Key);
      throw error;
    }
  }

  async recordDiscordMessage(input: RecordDiscordMessageInput): Promise<UploadSubmissionRecord | undefined> {
    const saved = await this.mutateSubmission(input.submissionId, input.now, submission => {
      submission.discord = {
        ...submission.discord,
        [input.kind]: {
          ...input.message,
          postedUtc: input.now.toISOString()
        }
      };
    });
    if (input.kind === "publication" && saved?.submission.publication) {
      const message = saved.submission.discord?.publication;
      const threadId = message?.threadId ?? "";
      if (message && /^[0-9]{1,20}$/.test(message.guildId) && /^[0-9]{1,20}$/.test(threadId)) {
        await this.updateCatalogDiscordUrl(
          saved.submission.publication.packId,
          `https://discord.com/channels/${message.guildId}/${threadId}`
        );
      }
    }
    return saved?.submission;
  }

  private async updateCatalogDiscordUrl(packId: string, discordUrl: string): Promise<void> {
    const catalogLock = await this.acquireCatalogLock();
    try {
      const previousRow = await this.db
        .prepare("SELECT entry_json FROM upload_catalog_entries WHERE id = ?")
        .bind(packId)
        .first<CatalogEntryRow>();
      if (!previousRow) {
        return;
      }

      const previousEntry = JSON.parse(previousRow.entry_json) as CatalogPack;
      if (previousEntry.discordUrl === discordUrl) {
        return;
      }
      const nextIndex = await this.upsertCatalogEntry({ ...previousEntry, discordUrl });
      try {
        await catalogLock.assertOwned();
        await this.publicBucket.put("catalog/index.json", JSON.stringify(nextIndex, null, 2) + "\n", {
          httpMetadata: { contentType: "application/json" }
        });
      } catch (error) {
        try {
          await this.upsertCatalogEntry(previousEntry);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Catalog index write and metadata rollback both failed.");
        }
        throw error;
      }
    } finally {
      await catalogLock.release();
    }
  }

  async deleteSubmission(input: DeleteSubmissionInput): Promise<DeletedUploadSubmission | undefined> {
    const found = await this.findSubmission(input.submissionId);
    if (!found) {
      return undefined;
    }

    const previousStatus = found.submission.status;
    const publication = found.submission.publication;
    const discord = found.submission.discord;
    if (publication) {
      const catalogLock = await this.acquireCatalogLock();
      try {
        if (publication.packId) {
          const previousRow = await this.db
            .prepare("SELECT entry_json FROM upload_catalog_entries WHERE id = ?")
            .bind(publication.packId)
            .first<CatalogEntryRow>();
          await this.deleteCatalogEntry(publication.packId);
          const nextIndex = await this.catalogIndexWithoutEntry(publication.packId);
          try {
            await catalogLock.assertOwned();
            await this.publicBucket.put("catalog/index.json", JSON.stringify(nextIndex, null, 2) + "\n", {
              httpMetadata: { contentType: "application/json" }
            });
          } catch (error) {
            try {
              if (previousRow) {
                await this.upsertCatalogEntry(JSON.parse(previousRow.entry_json) as CatalogPack);
              }
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Catalog index write and metadata rollback both failed.");
            }
            throw error;
          }
        }
      } finally {
        await catalogLock.release();
      }

      if (publication.packKey) {
        await this.publicBucket.delete(publication.packKey);
      }
      for (const image of publication.images) {
        await this.publicBucket.delete(image.key);
      }
    }

    await this.deleteQuarantineObjectsForSubmission(found.batch, found.submission);

    await this.mutateSubmission(input.submissionId, input.now, submission => {
      submission.status = "deleted";
      if (input.reason) submission.validationReasons.push(input.reason);
      delete submission.publication;
      delete submission.reviewClaimedUtc;
      delete submission.moderationDeliveredUtc;
    });

    return {
      batchId: found.batch.id,
      submissionId: found.submission.id,
      previousStatus,
      publication,
      discord
    };
  }

  async reserveUploadQuota(input: UploadQuotaReservationInput): Promise<boolean> {
    const reserved = await this.db
      .prepare([
        "INSERT INTO upload_quota_reservations",
        "(id, install_id_hash, network_key_hash, reserved_bytes, created_utc, expires_utc)",
        "SELECT ?, ?, ?, ?, ?, ?",
        "WHERE (SELECT COUNT(*) FROM upload_quota_reservations WHERE install_id_hash = ? AND created_utc >= ?) < ?",
        "AND COALESCE((SELECT SUM(reserved_bytes) FROM upload_quota_reservations WHERE install_id_hash = ? AND created_utc >= ?), 0) + ? <= ?",
        "AND (SELECT COUNT(*) FROM upload_quota_reservations WHERE network_key_hash = ? AND created_utc >= ?) < ?",
        "AND COALESCE((SELECT SUM(reserved_bytes) FROM upload_quota_reservations WHERE network_key_hash = ? AND created_utc >= ?), 0) + ? <= ?"
      ].join(" "))
      .bind(
        input.reservationId,
        input.installIdHash,
        input.networkKeyHash,
        input.reservedBytes,
        input.createdUtc,
        input.expiresUtc,
        input.installIdHash,
        input.windowStartUtc,
        input.maxInstallReservations,
        input.installIdHash,
        input.windowStartUtc,
        input.reservedBytes,
        input.maxInstallBytes,
        input.networkKeyHash,
        input.windowStartUtc,
        input.maxNetworkReservations,
        input.networkKeyHash,
        input.windowStartUtc,
        input.reservedBytes,
        input.maxNetworkBytes
      )
      .run();
    return (reserved.meta?.changes ?? 0) === 1;
  }

  async cleanupExpired(now: Date, limit: number): Promise<number> {
    const terminalCutoffUtc = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const abandonedReviewCutoffUtc = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const publishedCutoffUtc = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await this.db
      .prepare([
        "SELECT payload_json FROM upload_batches",
        "WHERE ((status IN ('prepared', 'awaiting_attribution') AND expires_utc <= ?)",
        "OR (status IN ('rejected', 'changes_requested', 'withdrawn', 'deleted') AND updated_utc <= ?)",
        "OR (status IN ('queued', 'reviewing', 'moderating') AND EXISTS (",
        "SELECT 1 FROM upload_submissions active WHERE active.batch_id = upload_batches.id",
        "AND active.status IN ('queued', 'reviewing', 'moderating')",
        "AND COALESCE(active.queued_utc, upload_batches.created_utc) <= ?))",
        "OR (status = 'published' AND updated_utc <= ?))",
        "ORDER BY updated_utc ASC LIMIT ?"
      ].join(" "))
      .bind(now.toISOString(), terminalCutoffUtc, abandonedReviewCutoffUtc, publishedCutoffUtc, Math.max(1, Math.min(limit, 100)))
      .all<BatchRow>();

    let cleaned = 0;
    for (const row of rows.results) {
      const candidate = JSON.parse(row.payload_json) as UploadBatchRecord;
      const release = await this.acquireBatchLock(candidate.id);
      try {
        const batch = await this.getBatch(candidate.id);
        if (!batch || !shouldDeleteQuarantineBatch(batch, now)) continue;
        const uploading = await this.db.prepare(
          "SELECT id FROM upload_objects WHERE batch_id = ? AND uploaded_bytes = -1 LIMIT 1"
        ).bind(batch.id).first<{ id: string }>();
        if (uploading) continue;
        const objects = await this.db
          .prepare("SELECT r2_key FROM upload_objects WHERE batch_id = ?")
          .bind(batch.id)
          .all<{ r2_key: string }>();
        for (const object of objects.results) {
          await this.quarantineBucket.delete(object.r2_key);
        }
        for (const submission of batch.submissions) {
          for (const capture of submission.captures) {
            if (capture.optimized?.r2Key) await this.quarantineBucket.delete(capture.optimized.r2Key);
          }
        }
        if (batch.submissions.some(submission => submission.status === "published")) {
          const staleCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
          const withdrawnIds: string[] = [];
          for (const submission of batch.submissions) {
            const queuedAt = Date.parse(submission.queuedUtc ?? batch.createdUtc);
            if (["queued", "reviewing", "moderating"].includes(submission.status) &&
                Number.isFinite(queuedAt) && queuedAt <= staleCutoff) {
              submission.status = "withdrawn";
              delete submission.reviewClaimedUtc;
              delete submission.moderationDeliveredUtc;
              withdrawnIds.push(submission.id);
            } else if (submission.status === "awaiting_attribution" && Date.parse(batch.expiresUtc) <= now.getTime()) {
              submission.status = "withdrawn";
              delete submission.reviewClaimedUtc;
              delete submission.moderationDeliveredUtc;
              withdrawnIds.push(submission.id);
            }
          }
          batch.status = deriveBatchStatusForStore(batch);
          batch.updatedUtc = now.toISOString();
          await this.db.batch([
            this.db.prepare("DELETE FROM upload_objects WHERE batch_id = ?").bind(batch.id),
            ...withdrawnIds.map(id => this.db.prepare([
              "UPDATE upload_submissions SET status = 'withdrawn', updated_utc = ?, moderation_delivered_utc = NULL",
              "WHERE id = ? AND batch_id = ?"
            ].join(" ")).bind(batch.updatedUtc, id, batch.id)),
            this.db.prepare("UPDATE upload_batches SET status = ?, updated_utc = ?, payload_json = ? WHERE id = ?")
              .bind(batch.status, batch.updatedUtc, JSON.stringify(batch), batch.id)
          ]);
        } else {
          await this.db.prepare("DELETE FROM upload_batches WHERE id = ?").bind(batch.id).run();
        }
        cleaned += 1;
      } finally {
        await release();
      }
    }

    await this.db.prepare("DELETE FROM upload_quota_reservations WHERE expires_utc <= ?").bind(now.toISOString()).run();
    await this.db.prepare("DELETE FROM upload_bot_nonces WHERE expires_utc <= ?").bind(now.toISOString()).run();
    await this.db
      .prepare("DELETE FROM upload_attribution_deliveries WHERE delivered_utc <= ?")
      .bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
      .run();
    return cleaned;
  }

  async recordAttributionDelivery(submissionId: string, now: Date): Promise<void> {
    const found = await this.findSubmission(submissionId);
    if (found?.submission.attribution.mode !== "discord") {
      return;
    }
    await this.db
      .prepare([
        "INSERT INTO upload_attribution_deliveries (discord_user_id, submission_id, delivered_utc)",
        "VALUES (?, ?, ?)",
        "ON CONFLICT(discord_user_id) DO UPDATE SET",
        "submission_id = excluded.submission_id, delivered_utc = excluded.delivered_utc"
      ].join(" "))
      .bind(found.submission.attribution.discordUserId, submissionId, now.toISOString())
      .run();
  }

  async rememberBotNonce(nonce: string, expiresUtc: string): Promise<boolean> {
    try {
      await this.db
        .prepare("DELETE FROM upload_bot_nonces WHERE expires_utc < ?")
        .bind(new Date().toISOString())
        .run();
      await this.db
        .prepare("INSERT INTO upload_bot_nonces (nonce, expires_utc) VALUES (?, ?)")
        .bind(nonce, expiresUtc)
        .run();
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async upsertCatalogEntry(entry: CatalogPack): Promise<CatalogIndex> {
    await this.db
      .prepare([
        "INSERT INTO upload_catalog_entries (id, entry_json, published_utc)",
        "VALUES (?, ?, ?)",
        "ON CONFLICT(id) DO UPDATE SET",
        "entry_json = excluded.entry_json,",
        "published_utc = excluded.published_utc"
      ].join(" "))
      .bind(entry.id, JSON.stringify(entry), entry.updatedUtc)
      .run();

    const rows = await this.db
      .prepare("SELECT entry_json FROM upload_catalog_entries ORDER BY published_utc ASC, id ASC")
      .all<CatalogEntryRow>();
    let index = await this.readCurrentCatalogIndex();
    for (const row of rows.results) {
      index = mergeCatalogIndex(index, JSON.parse(row.entry_json) as CatalogPack);
    }
    return index;
  }

  private async deleteCatalogEntry(id: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM upload_catalog_entries WHERE id = ?")
      .bind(id)
      .run();
  }

  private async catalogIndexWithoutEntry(id: string): Promise<CatalogIndex> {
    const rows = await this.db
      .prepare("SELECT entry_json FROM upload_catalog_entries ORDER BY published_utc ASC, id ASC")
      .all<CatalogEntryRow>();
    let index = await this.readCurrentCatalogIndex();
    index = {
      ...index,
      packs: index.packs.filter(pack => pack.id !== id)
    };
    for (const row of rows.results) {
      index = mergeCatalogIndex(index, JSON.parse(row.entry_json) as CatalogPack);
    }
    return index;
  }

  private async deleteQuarantineObjectsForSubmission(batch: UploadBatchRecord, submission: UploadSubmissionRecord): Promise<void> {
    await this.deleteQuarantineObject(submission.packObjectId);
    for (const capture of submission.captures) {
      if (capture.optimized?.r2Key) {
        await this.quarantineBucket.delete(capture.optimized.r2Key);
      }
      const captureStillUsed = batch.submissions.some(candidate =>
        candidate.id !== submission.id &&
        candidate.status !== "deleted" &&
        candidate.captures.some(candidateCapture => candidateCapture.objectId === capture.objectId)
      );
      if (!captureStillUsed) {
        await this.deleteQuarantineObject(capture.objectId);
      }
    }
  }

  private async deleteQuarantineObject(objectId: string): Promise<void> {
    const row = await this.db
      .prepare("SELECT r2_key FROM upload_objects WHERE id = ?")
      .bind(objectId)
      .first<{ r2_key: string }>();
    if (!row) {
      return;
    }

    await this.quarantineBucket.delete(row.r2_key);
    await this.db
      .prepare("DELETE FROM upload_objects WHERE id = ?")
      .bind(objectId)
      .run();
  }

  private async acquireCatalogLock(): Promise<DurableLock> {
    const lockId = "catalog-index";
    const ownerToken = randomUUID();
    const leaseMs = 30_000;
    const renewEveryMs = 10_000;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const attemptNow = new Date();
      const lockedUntilUtc = new Date(attemptNow.getTime() + leaseMs).toISOString();
      const acquired = await this.db
        .prepare([
          "INSERT INTO upload_catalog_locks (id, locked_until_utc, owner_token)",
          "VALUES (?, ?, ?)",
          "ON CONFLICT(id) DO UPDATE SET",
          "locked_until_utc = excluded.locked_until_utc, owner_token = excluded.owner_token",
          "WHERE upload_catalog_locks.locked_until_utc <= ?"
        ].join(" "))
        .bind(lockId, lockedUntilUtc, ownerToken, attemptNow.toISOString())
        .run();
      if ((acquired.meta?.changes ?? 0) !== 1) {
        await sleep(100);
        continue;
      }

      let renewalFailure: unknown;
      let renewal = Promise.resolve();
      const renew = async (): Promise<void> => {
        const now = new Date();
        const renewed = await this.db
          .prepare([
            "UPDATE upload_catalog_locks SET locked_until_utc = ?",
            "WHERE id = ? AND owner_token = ? AND locked_until_utc > ?"
          ].join(" "))
          .bind(new Date(now.getTime() + leaseMs).toISOString(), lockId, ownerToken, now.toISOString())
          .run();
        if ((renewed.meta?.changes ?? 0) !== 1) {
          throw new Error(`Lost durable lock ${lockId}.`);
        }
      };
      const heartbeat = setInterval(() => {
        renewal = renewal.then(renew).catch(error => {
          renewalFailure = error;
        });
      }, renewEveryMs);

      return {
        assertOwned: async () => {
          await renewal;
          if (renewalFailure) throw renewalFailure;
          await renew();
        },
        release: async () => {
          clearInterval(heartbeat);
          await renewal;
          await this.db
            .prepare("DELETE FROM upload_catalog_locks WHERE id = ? AND owner_token = ?")
            .bind(lockId, ownerToken)
            .run();
        }
      };
    }

    throw new Error(`Timed out waiting for durable lock ${lockId}.`);
  }

  private async acquireBatchLock(batchId: string): Promise<() => Promise<void>> {
    return this.acquireNamedLock(`batch:${batchId}`);
  }

  private async acquireNamedLock(lockId: string): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const attemptNow = new Date();
      const lockedUntilUtc = new Date(attemptNow.getTime() + 30_000).toISOString();
      const acquired = await this.db
        .prepare([
          "INSERT INTO upload_catalog_locks (id, locked_until_utc)",
          "VALUES (?, ?)",
          "ON CONFLICT(id) DO UPDATE SET",
          "locked_until_utc = excluded.locked_until_utc",
          "WHERE upload_catalog_locks.locked_until_utc <= ?"
        ].join(" "))
        .bind(lockId, lockedUntilUtc, attemptNow.toISOString())
        .run();
      if ((acquired.meta?.changes ?? 0) === 1) {
        return async () => {
          await this.db
            .prepare("DELETE FROM upload_catalog_locks WHERE id = ? AND locked_until_utc = ?")
            .bind(lockId, lockedUntilUtc)
            .run();
        };
      }

      await sleep(100);
    }

    throw new Error(`Timed out waiting for durable lock ${lockId}.`);
  }

  private async fillCatalogMapUrl(entry: CatalogPack): Promise<CatalogPack> {
    if (entry.mapUrl) {
      return entry;
    }

    const index = await this.readCurrentCatalogIndex();
    const match = index.packs.find(pack => pack.mapSid === entry.mapSid && pack.mapUrl);
    return match ? { ...entry, mapUrl: match.mapUrl } : entry;
  }

  private async readCurrentCatalogIndex(): Promise<CatalogIndex> {
    const existing = await this.publicBucket.get("catalog/index.json");
    if (!existing) {
      return emptyCatalogIndex();
    }

    const text = Buffer.from(await existing.arrayBuffer()).toString("utf8");
    const parsed = JSON.parse(text) as CatalogIndex;
    if (parsed.format !== "akron-community-pack-index-v3" || parsed.version !== 3 || !Array.isArray(parsed.packs) ||
        parsed.packs.some(pack => !/^[a-f0-9]{64}$/.test(pack.sha256) || !isCatalogDiscordUrl(pack.discordUrl) ||
          !Number.isSafeInteger(pack.sizeBytes) || pack.sizeBytes <= 0)) {
      throw new Error("Existing catalog/index.json has an unsupported format.");
    }
    return parsed;
  }

  private async optimizePublicCapture(capture: UploadObjectRecord, sourceUrl: string): Promise<UploadObjectRecord | undefined> {
    if (!sourceUrl) {
      return capture;
    }

    let smallestBytes = Number.POSITIVE_INFINITY;
    for (const attempt of catalogCaptureTransformAttempts) {
      const response = await fetch(sourceUrl, {
        signal: AbortSignal.timeout(15_000),
        cf: {
          image: {
            fit: "scale-down",
            width: attempt.width,
            format: "jpeg",
            quality: attempt.quality,
            metadata: "none"
          }
        }
      } as ImageTransformInit);
      if (!response.ok) {
        throw new Error("Cloudflare image transform failed with HTTP " + response.status + ".");
      }

      const bytes = await readResponseWithinLimit(response, catalogImageMaxBytes);
      if (!bytes) {
        continue;
      }
      smallestBytes = Math.min(smallestBytes, bytes.length);

      return {
        ...capture,
        bytes,
        uploadedBytes: bytes.length,
        contentType: "image/jpeg"
      };
    }

    console.warn("Skipping public capture because optimized map capture exceeds 4 MiB after downscaling; smallest result was " + smallestBytes + " bytes.");
    return undefined;
  }

  private async publicCapturesForPublication(input: PublishCatalogEntryInput): Promise<UploadObjectRecord[]> {
    const captures: UploadObjectRecord[] = [];
    for (const [index, capture] of input.captures.entries()) {
      const optimized = input.submission.captures[index]?.optimized;
      const optimizedBytes = optimized ? await this.readOptimizedCaptureBytes(optimized.r2Key) : undefined;
      const publicCapture = optimizedBytes
        ? {
            ...capture,
            bytes: optimizedBytes,
            uploadedBytes: optimizedBytes.length,
            contentType: optimized?.contentType ?? "image/jpeg"
          }
        : await this.optimizePublicCapture(capture, input.captureSourceUrls[index] ?? "");
      if (!publicCapture) {
        throw new Error("Optimized capture exceeds the public image budget.");
      }
      captures.push(publicCapture);
    }
    return captures;
  }

  private async readOptimizedCaptureBytes(r2Key: string | undefined): Promise<Buffer | undefined> {
    if (!r2Key) {
      return undefined;
    }
    const stored = await this.quarantineBucket.get(r2Key);
    return stored ? Buffer.from(await stored.arrayBuffer()) : undefined;
  }

}

function readTermsVersion(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function bodyWithKnownLength(
  body: Buffer | ReadableStream<Uint8Array>,
  declaredBytes: number
): Promise<{ body: Buffer | ReadableStream<Uint8Array>; completed: Promise<void> }> {
  if (Buffer.isBuffer(body)) {
    return { body, completed: Promise.resolve() };
  }

  const fixedLengthStream = (globalThis as typeof globalThis & {
    FixedLengthStream?: FixedLengthStreamConstructor;
  }).FixedLengthStream;
  if (!fixedLengthStream) {
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    return { body: bytes, completed: Promise.resolve() };
  }

  const fixed = new fixedLengthStream(declaredBytes);
  return {
    body: fixed.readable,
    completed: body.pipeTo(fixed.writable)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readResponseWithinLimit(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function buildUploadObjectKey(record: UploadObjectRecord): string {
  return `${uploadObjectPrefix}/${record.batchId}/${record.id}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|primary key|SQLITE_CONSTRAINT/i.test(message);
}

function deriveBatchStatusForStore(batch: UploadBatchRecord): UploadBatchRecord["status"] {
  const statuses = new Set(batch.submissions.map(submission => submission.status));
  if (statuses.has("awaiting_attribution")) {
    return "awaiting_attribution";
  }
  if (statuses.has("queued")) {
    return "queued";
  }
  if (statuses.has("reviewing")) {
    return "reviewing";
  }
  if (statuses.has("moderating")) {
    return "reviewing";
  }
  if (statuses.has("prepared")) {
    return "prepared";
  }
  if (statuses.has("published")) {
    return "published";
  }
  if (statuses.has("changes_requested")) {
    return "changes_requested";
  }
  if (statuses.has("rejected")) {
    return "rejected";
  }
  if (statuses.has("deleted")) {
    return "deleted";
  }
  return "withdrawn";
}

function isClaimableModerationJob(submission: UploadSubmissionRecord, now: Date): boolean {
  if (submission.status === "queued" || submission.status === "awaiting_attribution") {
    return true;
  }
  if (submission.status !== "reviewing" || submission.moderationDeliveredUtc) {
    return false;
  }

  const claimedAt = Date.parse(submission.reviewClaimedUtc ?? "");
  return !Number.isFinite(claimedAt) || claimedAt <= now.getTime() - moderationClaimLeaseMs;
}
