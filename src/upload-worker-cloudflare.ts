import {
  buildCatalogPack,
  buildPublication,
  capUploadBodyStream,
  createUploadWorker,
  emptyCatalogIndex,
  mergeCatalogIndex,
  moderationClaimLeaseMs,
  type CatalogIndex,
  type CatalogPack,
  type PendingUploadedObjectBody,
  type PublishCatalogEntryInput,
  type UploadBatchRecord,
  type UploadObjectRecord,
  type UploadedObjectBody,
  type UploadedObjectWriteResult,
  type UploadSubmissionRecord,
  type UploadWorkerStore,
  UploadTooLargeError
} from "./upload-worker.js";
import { catalogImageMaxBytes } from "./submissions/types.js";

export type CloudflareUploadEnv = {
  UPLOAD_DB: D1Database;
  UPLOAD_QUARANTINE_BUCKET: R2Bucket;
  UPLOAD_PUBLIC_BUCKET: R2Bucket;
  BOT_HMAC_SECRET: string;
  UPLOAD_TERMS_VERSION?: string;
  UPLOAD_PUBLIC_BASE_URL?: string;
  UPLOAD_PUBLIC_UPLOAD_BASE_URL?: string;
};

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

type R2Bucket = {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
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
      format: "webp";
      quality: number;
      metadata: "none";
    };
  };
};

export const catalogCaptureTransformAttempts = [
  { width: 4096, quality: 82 },
  { width: 3584, quality: 78 },
  { width: 3072, quality: 74 },
  { width: 2560, quality: 70 },
  { width: 2048, quality: 66 },
  { width: 1536, quality: 62 }
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

export default {
  async fetch(request: Request, env: CloudflareUploadEnv): Promise<Response> {
    const worker = createUploadWorker({
      store: new CloudflareUploadStore(env.UPLOAD_DB, env.UPLOAD_QUARANTINE_BUCKET, env.UPLOAD_PUBLIC_BUCKET, env.UPLOAD_PUBLIC_BASE_URL),
      botSecret: env.BOT_HMAC_SECRET,
      publicUploadBaseUrl: env.UPLOAD_PUBLIC_UPLOAD_BASE_URL,
      termsVersion: readTermsVersion(env.UPLOAD_TERMS_VERSION)
    });
    return worker.fetch(request);
  }
};

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

  async tryBeginCompletion(batch: UploadBatchRecord): Promise<boolean> {
    const locked = await this.db
      .prepare([
        "UPDATE upload_batches",
        "SET status = ?, updated_utc = ?, payload_json = ?",
        "WHERE id = ? AND status = 'prepared'"
      ].join(" "))
      .bind(batch.status, batch.updatedUtc, JSON.stringify(batch), batch.id)
      .run();
    return (locked.meta?.changes ?? 0) === 1;
  }

  async tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean> {
    const nowIso = now.toISOString();
    const reserved = await this.db
      .prepare([
        "UPDATE upload_submissions",
        "SET status = 'moderating', updated_utc = ?",
        "WHERE id = ? AND status IN ('queued', 'reviewing', 'awaiting_attribution')"
      ].join(" "))
      .bind(nowIso, submissionId)
      .run();
    if ((reserved.meta?.changes ?? 0) !== 1) {
      return false;
    }

    const current = await this.getBatch(batch.id);
    const submission = current?.submissions.find(candidate => candidate.id === submissionId);
    if (!current || !submission) {
      return false;
    }
    if (submission) {
      submission.status = "moderating";
    }
    current.updatedUtc = nowIso;
    current.status = deriveBatchStatusForStore(current);
    await this.putBatchPayload(current);
    return true;
  }

  async claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>> {
    const nowIso = now.toISOString();
    const leaseCutoffUtc = new Date(now.getTime() - moderationClaimLeaseMs).toISOString();
    const rows = await this.db
      .prepare([
        "SELECT id FROM upload_submissions",
        "WHERE moderation_delivered_utc IS NULL",
        "AND (status IN ('queued', 'awaiting_attribution')",
        "OR (status = 'reviewing' AND updated_utc <= ?))",
        "ORDER BY updated_utc ASC",
        "LIMIT ?"
      ].join(" "))
      .bind(leaseCutoffUtc, limit)
      .all<{ id: string }>();
    const jobs: Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }> = [];
    for (const row of rows.results) {
      const job = await this.findSubmission(row.id);
      if (!job || !isClaimableModerationJob(job.submission, now)) {
        continue;
      }

      const claimed = await this.db
        .prepare([
          "UPDATE upload_submissions",
          "SET status = 'reviewing', updated_utc = ?, moderation_delivered_utc = NULL",
          "WHERE id = ? AND moderation_delivered_utc IS NULL",
          "AND (status IN ('queued', 'awaiting_attribution')",
          "OR (status = 'reviewing' AND updated_utc <= ?))"
        ].join(" "))
        .bind(nowIso, row.id, leaseCutoffUtc)
        .run();
      if ((claimed.meta?.changes ?? 0) !== 1) {
        continue;
      }

      job.submission.status = "reviewing";
      job.submission.reviewClaimedUtc = nowIso;
      delete job.submission.moderationDeliveredUtc;
      job.batch.updatedUtc = nowIso;
      job.batch.status = deriveBatchStatusForStore(job.batch);
      await this.putBatchPayload(job.batch);
      jobs.push(job);
    }
    return jobs;
  }

  private async putBatchPayload(batch: UploadBatchRecord): Promise<void> {
    await this.db
      .prepare([
        "UPDATE upload_batches",
        "SET status = ?, updated_utc = ?, payload_json = ?",
        "WHERE id = ?"
      ].join(" "))
      .bind(batch.status, batch.updatedUtc, JSON.stringify(batch), batch.id)
      .run();
  }

  async putBatch(batch: UploadBatchRecord): Promise<void> {
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
          "INSERT INTO upload_submissions (id, batch_id, section, status, map_sid, updated_utc, moderation_delivered_utc)",
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
          "ON CONFLICT(id) DO UPDATE SET",
          "batch_id = excluded.batch_id,",
          "section = excluded.section,",
          "status = excluded.status,",
          "map_sid = excluded.map_sid,",
          "updated_utc = excluded.updated_utc,",
          "moderation_delivered_utc = excluded.moderation_delivered_utc"
        ].join(" "))
        .bind(
          submission.id,
          batch.id,
          submission.section,
          submission.status,
          submission.mapSid,
          submission.reviewClaimedUtc ?? batch.updatedUtc,
          submission.moderationDeliveredUtc ?? null
        )
      );
    }
    await this.db.batch(statements);
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
      .prepare("SELECT r2_key, max_bytes FROM upload_objects WHERE id = ?")
      .bind(id)
      .first<{ r2_key: string; max_bytes: number }>();
    if (!row) {
      throw new Error("Upload object does not exist.");
    }

    const reserved = await this.db
      .prepare([
        "UPDATE upload_objects",
        "SET uploaded_bytes = -1",
        "WHERE id = ?",
        "AND uploaded_bytes IS NULL",
        "AND EXISTS (SELECT 1 FROM upload_batches WHERE upload_batches.id = upload_objects.batch_id AND upload_batches.status = 'prepared')"
      ].join(" "))
      .bind(id)
      .run();
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
    if (!packBytes || (input.capture && input.capture.uploadedBytes === undefined)) {
      throw new Error("Cannot publish missing upload objects.");
    }

    const publicCapture = input.capture ? await this.optimizePublicCapture({ ...input, capture: input.capture }) : undefined;
    const publicCaptureBytes = publicCapture?.bytes;
    const publication = buildPublication(input.submission, publicCapture, input.now, this.publicBaseUrl);
    await this.publicBucket.put(publication.packKey, packBytes, {
      httpMetadata: { contentType: "application/octet-stream" }
    });
    if (publication.imageKey && publicCaptureBytes && publicCapture) {
      await this.publicBucket.put(publication.imageKey, publicCaptureBytes, {
        httpMetadata: { contentType: publicCapture.contentType }
      });
    }

    const releaseCatalogLock = await this.acquireCatalogLock();
    try {
      const entry = await this.fillCatalogMapUrl(buildCatalogPack(input.submission, publication, input.now));
      const nextIndex = await this.upsertCatalogEntry(entry);
      try {
        await this.publicBucket.put("catalog/index.json", JSON.stringify(nextIndex, null, 2) + "\n", {
          httpMetadata: { contentType: "application/json" }
        });
      } catch (error) {
        await this.deleteCatalogEntry(entry.id);
        throw error;
      }
    } catch (error) {
      throw error;
    } finally {
      await releaseCatalogLock();
    }
    return publication;
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

  private async acquireCatalogLock(): Promise<() => Promise<void>> {
    const lockId = "catalog-index";
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

    throw new Error("Timed out waiting for catalog index lock.");
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
    if (parsed.format !== "akron-community-pack-index-v1" || parsed.version !== 1 || !Array.isArray(parsed.packs)) {
      throw new Error("Existing catalog/index.json has an unsupported format.");
    }
    return parsed;
  }

  private async optimizePublicCapture(input: PublishCatalogEntryInput & { capture: UploadObjectRecord }): Promise<UploadObjectRecord | undefined> {
    if (!input.captureSourceUrl) {
      return input.capture;
    }

    let smallestBytes = Number.POSITIVE_INFINITY;
    for (const attempt of catalogCaptureTransformAttempts) {
      const response = await fetch(input.captureSourceUrl, {
        cf: {
          image: {
            fit: "scale-down",
            width: attempt.width,
            format: "webp",
            quality: attempt.quality,
            metadata: "none"
          }
        }
      } as ImageTransformInit);
      if (!response.ok) {
        throw new Error("Cloudflare image transform failed with HTTP " + response.status + ".");
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      smallestBytes = Math.min(smallestBytes, bytes.length);
      if (bytes.length > catalogImageMaxBytes) {
        continue;
      }

      return {
        ...input.capture,
        bytes,
        uploadedBytes: bytes.length,
        contentType: "image/webp"
      };
    }

    console.warn("Skipping public capture because optimized map capture exceeds 4 MiB after downscaling; smallest result was " + smallestBytes + " bytes.");
    return undefined;
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
