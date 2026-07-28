import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { validateAkrArchive } from "./submissions/archive.js";
import { isSupportedMapUrl, normalizeMapUrl } from "./submissions/post-parser.js";
import { sectionTag } from "./submissions/sections.js";
import { akrMaxBytes, imageSourceMaxBytes, type AkronProfileSection } from "./submissions/types.js";

export type UploadSection = Extract<AkronProfileSection, "StartPos" | "AutoKill" | "AutoDeafen">;
export type UploadStatus =
  | "prepared"
  | "queued"
  | "reviewing"
  | "moderating"
  | "awaiting_attribution"
  | "published"
  | "rejected"
  | "changes_requested"
  | "withdrawn"
  | "deleted";

export type UploadAttribution =
  | { mode: "anonymous" }
  | { mode: "discord"; discordUserId: string; confirmed: boolean };

export type UploadObjectKind = "pack" | "capture";

export type CatalogPublication = {
  packId: string;
  packKey: string;
  downloadUrl: string;
  images: CatalogImage[];
  publishedUtc: string;
  sha256: string;
  sizeBytes: number;
};

export type CatalogImage = {
  key: string;
  url: string;
  roomName: string;
};

export type UploadDiscordMessage = {
  guildId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
  postedUtc: string;
};

export type UploadDiscordMessages = {
  review?: UploadDiscordMessage;
  publication?: UploadDiscordMessage;
};

export type DeletedUploadSubmission = {
  batchId: string;
  submissionId: string;
  previousStatus: UploadStatus;
  publication?: CatalogPublication;
  discord?: UploadDiscordMessages;
};

export type UploadAiReview = {
  decision: "allow" | "needs_review" | "reject";
  severity: "low" | "medium" | "high";
  reasons: string[];
  reviewedUtc: string;
};

export type OptimizedCatalogCapture = {
  bytes: Buffer;
  contentType: "image/jpeg";
  extension: "jpg";
};

export type UploadCaptureRecord = {
  objectId: string;
  roomName: string;
};

export type UploadObjectRecord = {
  id: string;
  tokenHash: string;
  kind: UploadObjectKind;
  batchId: string;
  submissionId?: string;
  maxBytes: number;
  contentType: string;
  uploadedBytes?: number;
  bytes?: Buffer;
};

export type UploadedObjectBody = {
  body: Buffer | ReadableStream<Uint8Array>;
  contentType: string;
  uploadedBytes: number;
};

export type PendingUploadedObjectBody = {
  body: Buffer | ReadableStream<Uint8Array>;
  contentType: string;
  declaredBytes: number;
};

export type UploadedObjectWriteResult =
  | { ok: true; uploadedBytes: number }
  | { ok: false };

export type UploadSubmissionRecord = {
  id: string;
  batchId: string;
  section: UploadSection;
  mapSid: string;
  mapUrl: string;
  title: string;
  description: string;
  packObjectId: string;
  captures: UploadCaptureRecord[];
  attribution: UploadAttribution;
  status: UploadStatus;
  validationReasons: string[];
  archiveFacts?: Record<string, unknown>;
  aiReview?: UploadAiReview;
  queuedUtc?: string;
  moderationAttempts?: number;
  reviewClaimedUtc?: string;
  moderationDeliveredUtc?: string;
  publication?: CatalogPublication;
  discord?: UploadDiscordMessages;
};

export type UploadBatchRecord = {
  id: string;
  installIdHash: string;
  termsVersion: number;
  status: UploadStatus;
  createdUtc: string;
  updatedUtc: string;
  expiresUtc: string;
  submissions: UploadSubmissionRecord[];
};

export type UploadWorkerStore = {
  getBatch(id: string): Promise<UploadBatchRecord | undefined>;
  findSubmission(submissionId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined>;
  findSubmissionByDiscordThread(threadId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined>;
  tryBeginCompletion(batch: UploadBatchRecord): Promise<boolean>;
  tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean>;
  claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>>;
  putBatch(batch: UploadBatchRecord): Promise<void>;
  mutateSubmission(
    submissionId: string,
    now: Date,
    mutate: (submission: UploadSubmissionRecord) => void
  ): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined>;
  putObject(record: UploadObjectRecord): Promise<void>;
  getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined>;
  getUploadedObjectBody(id: string): Promise<UploadedObjectBody | undefined>;
  putUploadedObject(id: string, upload: PendingUploadedObjectBody): Promise<UploadedObjectWriteResult>;
  publishCatalogEntry(input: PublishCatalogEntryInput): Promise<CatalogPublication>;
  publishCatalogMetadata(entry: CatalogPack): Promise<void>;
  recordAiReview(input: RecordAiReviewInput): Promise<UploadSubmissionRecord | undefined>;
  recordDiscordMessage(input: RecordDiscordMessageInput): Promise<UploadSubmissionRecord | undefined>;
  deleteSubmission(input: DeleteSubmissionInput): Promise<DeletedUploadSubmission | undefined>;
  reserveUploadQuota(input: UploadQuotaReservationInput): Promise<boolean>;
  cleanupExpired(now: Date, limit: number): Promise<number>;
  recordAttributionDelivery(submissionId: string, now: Date): Promise<void>;
  rememberBotNonce(nonce: string, expiresUtc: string): Promise<boolean>;
};

export type UploadQuotaReservationInput = {
  reservationId: string;
  installIdHash: string;
  networkKeyHash: string;
  reservedBytes: number;
  createdUtc: string;
  expiresUtc: string;
  windowStartUtc: string;
  maxInstallReservations: number;
  maxInstallBytes: number;
  maxNetworkReservations: number;
  maxNetworkBytes: number;
};

export type PublishCatalogEntryInput = {
  submission: UploadSubmissionRecord;
  pack: UploadObjectRecord;
  captures: UploadObjectRecord[];
  now: Date;
  captureSourceUrls: string[];
  optimizeCatalogCapture(sourceUrl: string): Promise<OptimizedCatalogCapture>;
  authorName: string;
  authorAvatarUrl: string;
};

export type RecordAiReviewInput = {
  submissionId: string;
  review: Omit<UploadAiReview, "reviewedUtc">;
  now: Date;
};

export type RecordDiscordMessageInput = {
  submissionId: string;
  kind: keyof UploadDiscordMessages;
  message: Omit<UploadDiscordMessage, "postedUtc">;
  now: Date;
};

export type DeleteSubmissionInput = {
  submissionId: string;
  now: Date;
  reason?: string;
};

export type UploadWorkerOptions = {
  store: UploadWorkerStore;
  botSecret: string;
  publicUploadBaseUrl?: string;
  termsVersion?: number;
  optimizeCatalogCapture?: (sourceUrl: string) => Promise<OptimizedCatalogCapture>;
  fetchCatalogCaptureSource?: (sourceUrl: string, signal?: AbortSignal) => Promise<Response>;
  now?: () => Date;
  id?: () => string;
};

export type PreparedObject = {
  objectId: string;
  uploadUrl: string;
  maxBytes: number;
};

type PreparedCaptureObject = PreparedObject & {
  roomName: string;
};

const allowedUploadSections = new Set<UploadSection>(["StartPos", "AutoKill", "AutoDeafen"]);
const defaultTermsVersion = 1;
const preparedUploadTtlMs = 30 * 60 * 1000;
const attributionTtlMs = 24 * 60 * 60 * 1000;
const sourceObjectSignatureTtlMs = 5 * 60 * 1000;
export const moderationClaimLeaseMs = 15 * 60 * 1000;
const maxTitleLength = 120;
const maxDescriptionLength = 1_000;
const maxMapSidLength = 512;
const maxMapUrlLength = 512;
const maxRoomNameLength = 200;
const maxSubmissionsPerBatch = 8;
const maxCapturesPerBatch = 10;
export const maxBatchDeclaredBytes = 64 * 1024 * 1024;
const publicJsonMaxBytes = 128 * 1024;
const botJsonMaxBytes = 6 * 1024 * 1024;
const uploadQuotaWindowMs = 60 * 60 * 1000;
const maxInstallReservationsPerWindow = 4;
const maxInstallBytesPerWindow = 128 * 1024 * 1024;
const maxNetworkReservationsPerWindow = 12;
const maxNetworkBytesPerWindow = 512 * 1024 * 1024;
const attributionDeliveryCooldownMs = 24 * 60 * 60 * 1000;
const abandonedReviewRetentionMs = 7 * 24 * 60 * 60 * 1000;
const maxModerationAttempts = 5;
const botSignatureWindowMs = 5 * 60 * 1000;
const jsonContentType = { "content-type": "application/json; charset=utf-8" };
const allowedCaptureContentTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const trustedDiscordCaptureHosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function createUploadWorker(options: UploadWorkerOptions): { fetch(request: Request): Promise<Response> } {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const termsVersion = options.termsVersion ?? defaultTermsVersion;
  const publicUploadOrigin = options.publicUploadBaseUrl ? new URL(options.publicUploadBaseUrl).origin : undefined;

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const uploadOrigin = publicUploadOrigin ?? url.origin;
      try {
        if (request.method === "GET" && url.pathname === "/uploads/challenge") {
          return json({
            termsVersion,
            acceptedSections: [...allowedUploadSections],
            limits: {
              packMaxBytes: akrMaxBytes,
              captureMaxBytes: imageSourceMaxBytes,
              batchMaxBytes: maxBatchDeclaredBytes,
              capturesMaxCount: maxCapturesPerBatch,
              titleMaxLength: maxTitleLength,
              descriptionMaxLength: maxDescriptionLength,
              mapSidMaxLength: maxMapSidLength,
              roomNameMaxLength: maxRoomNameLength,
              submissionsMaxCount: maxSubmissionsPerBatch
            },
            serverTimeUtc: now().toISOString()
          });
        }

        if (request.method === "POST" && url.pathname === "/uploads/prepare") {
          return await prepareUpload({
            request,
            origin: uploadOrigin,
            store: options.store,
            now,
            id,
            termsVersion,
            botSecret: options.botSecret
          });
        }

        const objectMatch = url.pathname.match(/^\/uploads\/objects\/([^/]+)$/);
        if (request.method === "PUT" && objectMatch) {
          return await putUploadObject({
            request,
            objectId: objectMatch[1] ?? "",
            token: url.searchParams.get("token") ?? "",
            store: options.store,
            now
          });
        }

        const sourceMatch = url.pathname.match(/^\/uploads\/source\/([^/]+)$/);
        if (request.method === "GET" && sourceMatch) {
          return await getSignedSourceObject({
            objectId: sourceMatch[1] ?? "",
            expires: url.searchParams.get("expires") ?? "",
            signature: url.searchParams.get("signature") ?? "",
            store: options.store,
            botSecret: options.botSecret,
            now
          });
        }

        if (request.method === "GET" && url.pathname === "/bot/catalog/captures/source") {
          return await getSignedCatalogCaptureSource({
            sourceUrl: url.searchParams.get("sourceUrl") ?? "",
            expires: url.searchParams.get("expires") ?? "",
            signature: url.searchParams.get("signature") ?? "",
            botSecret: options.botSecret,
            now,
            fetchSource: options.fetchCatalogCaptureSource ??
              ((sourceUrl, signal) => fetch(sourceUrl, { signal }))
          });
        }

        if (request.method === "POST" && url.pathname === "/uploads/complete") {
          return await completeUpload({ request, store: options.store, now });
        }

        const statusMatch = url.pathname.match(/^\/uploads\/status\/([^/]+)$/);
        if (request.method === "GET" && statusMatch) {
          return await getUploadStatus({ batchId: statusMatch[1] ?? "", installId: url.searchParams.get("installId") ?? "", store: options.store });
        }

        const withdrawMatch = url.pathname.match(/^\/uploads\/([^/]+)\/withdraw$/);
        if (request.method === "POST" && withdrawMatch) {
          return await updateClientSubmissionStatus({
            request,
            submissionId: withdrawMatch[1] ?? "",
            store: options.store,
            now,
            nextStatus: "withdrawn"
          });
        }

        const anonymousMatch = url.pathname.match(/^\/uploads\/([^/]+)\/convert-to-anonymous$/);
        if (request.method === "POST" && anonymousMatch) {
          return await convertSubmissionToAnonymous({
            request,
            submissionId: anonymousMatch[1] ?? "",
            store: options.store,
            now
          });
        }

        const attributionMatch = url.pathname.match(/^\/bot\/attribution\/([^/]+)\/confirm$/);
        if (request.method === "POST" && attributionMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await confirmAttribution({
            body,
            submissionId: attributionMatch[1] ?? "",
            store: options.store,
            now
          });
        }

        if (request.method === "POST" && url.pathname === "/bot/jobs/claim") {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await claimModerationJobs({ body, store: options.store, now, origin: uploadOrigin, botSecret: options.botSecret });
        }

        if (request.method === "POST" && url.pathname === "/bot/jobs/requeue") {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await requeueModerationJobs({ body, store: options.store, now });
        }

        if (request.method === "POST" && url.pathname === "/bot/jobs/delivered") {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await acknowledgeDeliveredModerationJobs({ body, store: options.store, now });
        }

        const contextMatch = url.pathname.match(/^\/bot\/submissions\/([^/]+)\/context$/);
        if (request.method === "POST" && contextMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await getBotSubmissionContext({
            submissionId: contextMatch[1] ?? "",
            store: options.store,
            now,
            origin: uploadOrigin,
            botSecret: options.botSecret
          });
        }

        const aiReviewMatch = url.pathname.match(/^\/bot\/reviews\/([^/]+)$/);
        if (request.method === "POST" && aiReviewMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await recordAiReview({
            submissionId: aiReviewMatch[1] ?? "",
            body,
            store: options.store,
            now
          });
        }

        if (request.method === "POST" && url.pathname === "/bot/catalog/captures/transform") {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await transformCatalogCapture({
            body,
            optimize: options.optimizeCatalogCapture,
            origin: uploadOrigin,
            botSecret: options.botSecret,
            now
          });
        }

        const discordMessageMatch = url.pathname.match(/^\/bot\/discord-messages\/([^/]+)$/);
        if (request.method === "POST" && discordMessageMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await recordDiscordMessage({
            submissionId: discordMessageMatch[1] ?? "",
            body,
            store: options.store,
            now
          });
        }

        const deleteSubmissionMatch = url.pathname.match(/^\/bot\/submissions\/([^/]+)\/delete$/);
        if (request.method === "POST" && deleteSubmissionMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await deleteSubmission({
            submissionId: deleteSubmissionMatch[1] ?? "",
            body,
            store: options.store,
            now
          });
        }

        const deleteThreadSubmissionMatch = url.pathname.match(/^\/bot\/submissions\/by-discord-thread\/([^/]+)\/delete$/);
        if (request.method === "POST" && deleteThreadSubmissionMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await deleteSubmissionByDiscordThread({
            threadId: decodeURIComponent(deleteThreadSubmissionMatch[1] ?? ""),
            body,
            store: options.store,
            now
          });
        }

        const moderationMatch = url.pathname.match(/^\/bot\/moderation\/([^/]+)\/(approve|reject|request-changes)$/);
        if (request.method === "POST" && moderationMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await applyModerationAction({
            submissionId: moderationMatch[1] ?? "",
            action: moderationMatch[2] ?? "",
            body,
            store: options.store,
            now,
            origin: uploadOrigin,
            botSecret: options.botSecret,
            optimizeCatalogCapture: options.optimizeCatalogCapture
          });
        }

        if (request.method === "POST" && url.pathname === "/bot/catalog/entries") {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          const entry = readCatalogPack(body.entry);
          await options.store.publishCatalogMetadata(entry);
          return json({ ok: true, entryId: entry.id });
        }

        return json({ error: "not_found" }, 404);
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: error.code }, error.status);
        }
        console.error("Upload worker request failed.", error);
        return json({ error: "internal_error" }, 500);
      }
    }
  };
}

export class InMemoryUploadStore implements UploadWorkerStore {
  private readonly batches = new Map<string, UploadBatchRecord>();
  private readonly objects = new Map<string, UploadObjectRecord>();
  private readonly botNonces = new Map<string, string>();
  private readonly quotaReservations = new Map<string, UploadQuotaReservationInput>();
  private readonly attributionDeliveries = new Map<string, string>();
  private readonly publicObjects = new Map<string, { bytes: Buffer; contentType: string }>();
  private catalogIndex: CatalogIndex = emptyCatalogIndex();
  private catalogMutationTail: Promise<void> = Promise.resolve();

  async getBatch(id: string): Promise<UploadBatchRecord | undefined> {
    return clone(this.batches.get(id));
  }

  async findSubmission(submissionId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    for (const batch of this.batches.values()) {
      const batchClone = clone(batch);
      const submission = batchClone.submissions.find(candidate => candidate.id === submissionId);
      if (submission) {
        return { batch: batchClone, submission };
      }
    }
    return undefined;
  }

  async findSubmissionByDiscordThread(threadId: string): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    for (const batch of this.batches.values()) {
      const batchClone = clone(batch);
      const submission = batchClone.submissions.find(candidate => candidate.discord?.publication?.threadId === threadId);
      if (submission) {
        return { batch: batchClone, submission };
      }
    }
    return undefined;
  }

  async tryBeginCompletion(batch: UploadBatchRecord): Promise<boolean> {
    const current = this.batches.get(batch.id);
    if (!current || current.status !== "prepared") {
      return false;
    }

    this.batches.set(batch.id, clone(batch));
    return true;
  }

  async tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean> {
    const current = this.batches.get(batch.id);
    const submission = current?.submissions.find(candidate => candidate.id === submissionId);
    if (!current || !submission || !isModeratableStatus(submission.status)) {
      return false;
    }

    const nowIso = now.toISOString();
    submission.status = "moderating";
    submission.reviewClaimedUtc = nowIso;
    current.updatedUtc = nowIso;
    current.status = deriveBatchStatus(current);
    this.batches.set(current.id, clone(current));
    return true;
  }

  async claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>> {
    const jobs: Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }> = [];
    const nowIso = now.toISOString();
    const claimedAttributionUsers = new Set<string>();
    for (const [batchId, batch] of this.batches.entries()) {
      if (batch.status === "awaiting_attribution" && Date.parse(batch.expiresUtc) <= now.getTime()) {
        continue;
      }
      for (const submission of batch.submissions) {
        const attributionUserId = submission.attribution.mode === "discord" && !submission.attribution.confirmed
          ? submission.attribution.discordUserId
          : "";
        if (attributionUserId) {
          const deliveredAt = Date.parse(this.attributionDeliveries.get(attributionUserId) ?? "");
          if (claimedAttributionUsers.has(attributionUserId) ||
              (Number.isFinite(deliveredAt) && deliveredAt > now.getTime() - attributionDeliveryCooldownMs)) {
            continue;
          }
        }
        if ((submission.moderationAttempts ?? 0) < maxModerationAttempts && isClaimableModerationStatus(submission, now)) {
          submission.status = "reviewing";
          submission.moderationAttempts = (submission.moderationAttempts ?? 0) + 1;
          submission.reviewClaimedUtc = nowIso;
          delete submission.moderationDeliveredUtc;
          batch.updatedUtc = nowIso;
          batch.status = deriveBatchStatus(batch);
          this.batches.set(batchId, clone(batch));
          const claimedBatch = clone(batch);
          const claimedSubmission = claimedBatch.submissions.find(candidate => candidate.id === submission.id);
          if (claimedSubmission) {
            jobs.push({ batch: claimedBatch, submission: claimedSubmission });
            if (attributionUserId) {
              claimedAttributionUsers.add(attributionUserId);
            }
          }
          if (jobs.length >= limit) {
            return jobs;
          }
        }
      }
    }
    return jobs;
  }

  async putBatch(batch: UploadBatchRecord): Promise<void> {
    this.batches.set(batch.id, clone(batch));
  }

  async mutateSubmission(
    submissionId: string,
    now: Date,
    mutate: (submission: UploadSubmissionRecord) => void
  ): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
    const batch = [...this.batches.values()].find(candidate => candidate.submissions.some(submission => submission.id === submissionId));
    const submission = batch?.submissions.find(candidate => candidate.id === submissionId);
    if (!batch || !submission) return undefined;
    mutate(submission);
    batch.updatedUtc = now.toISOString();
    batch.status = deriveBatchStatus(batch);
    this.batches.set(batch.id, clone(batch));
    const savedBatch = clone(batch);
    const savedSubmission = savedBatch.submissions.find(candidate => candidate.id === submissionId);
    return savedSubmission ? { batch: savedBatch, submission: savedSubmission } : undefined;
  }

  async putObject(record: UploadObjectRecord): Promise<void> {
    this.objects.set(record.id, clone(record));
  }

  async getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined> {
    const object = clone(this.objects.get(id));
    if (object && options?.includeBytes === false) {
      delete object.bytes;
    }
    return object;
  }

  async getUploadedObjectBody(id: string): Promise<UploadedObjectBody | undefined> {
    const existing = this.objects.get(id);
    if (!existing?.bytes || existing.uploadedBytes === undefined) {
      return undefined;
    }
    return {
      body: Buffer.from(existing.bytes),
      contentType: existing.contentType,
      uploadedBytes: existing.uploadedBytes
    };
  }

  async putUploadedObject(id: string, upload: PendingUploadedObjectBody): Promise<UploadedObjectWriteResult> {
    const existing = this.objects.get(id);
    if (!existing) {
      throw new Error("Upload object does not exist.");
    }
    const batch = this.batches.get(existing.batchId);
    if (existing.uploadedBytes !== undefined || batch?.status !== "prepared") {
      return { ok: false };
    }
    const bytes = await bufferFromBody(upload.body, existing.maxBytes);
    this.objects.set(id, { ...existing, bytes, uploadedBytes: bytes.length, contentType: upload.contentType });
    return { ok: true, uploadedBytes: bytes.length };
  }

  async publishCatalogEntry(input: PublishCatalogEntryInput): Promise<CatalogPublication> {
    const packBytes = input.pack.bytes;
    if (!packBytes) {
      throw new Error("Cannot publish missing upload objects.");
    }

    const publicCaptures: UploadObjectRecord[] = [];
    for (const [index, capture] of input.captures.entries()) {
      const optimized = await input.optimizeCatalogCapture(input.captureSourceUrls[index] ?? "");
      publicCaptures.push({
        ...capture,
        bytes: optimized.bytes,
        uploadedBytes: optimized.bytes.length,
        contentType: optimized.contentType
      });
    }
    const publication = buildPublication(input.submission, publicCaptures, input.now, "https://akron.example.test", packBytes);
    const writtenKeys: string[] = [];
    try {
      this.publicObjects.set(publication.packKey, {
        bytes: Buffer.from(packBytes),
        contentType: "application/octet-stream"
      });
      writtenKeys.push(publication.packKey);
      for (const [index, image] of publication.images.entries()) {
        const capture = publicCaptures[index];
        if (!capture?.bytes) throw new Error("Cannot publish missing optimized capture bytes.");
        this.publicObjects.set(image.key, {
          bytes: Buffer.from(capture.bytes),
          contentType: capture.contentType
        });
        writtenKeys.push(image.key);
      }
      await this.publishCatalogMetadata(buildCatalogPack(
        input.submission,
        publication,
        input.now,
        input.authorName,
        input.authorAvatarUrl
      ));
    } catch (error) {
      for (const key of writtenKeys) this.publicObjects.delete(key);
      throw error;
    }
    return publication;
  }

  async publishCatalogMetadata(entry: CatalogPack): Promise<void> {
    const mutation = this.catalogMutationTail.then(() => {
      this.catalogIndex = mergeCatalogIndex(this.catalogIndex, entry);
    });
    this.catalogMutationTail = mutation.then(() => undefined, () => undefined);
    await mutation;
  }

  async recordAiReview(input: RecordAiReviewInput): Promise<UploadSubmissionRecord | undefined> {
    const saved = await this.mutateSubmission(input.submissionId, input.now, submission => {
      submission.aiReview = { ...input.review, reviewedUtc: input.now.toISOString() };
    });
    return saved?.submission;
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
      const discordUrl = discordPublicationUrl(saved.submission);
      const entryIndex = this.catalogIndex.packs.findIndex(
        entry => entry.id === saved.submission.publication?.packId
      );
      if (discordUrl && entryIndex >= 0) {
        this.catalogIndex.packs[entryIndex] = {
          ...this.catalogIndex.packs[entryIndex]!,
          discordUrl
        };
      }
    }
    return saved?.submission;
  }

  async deleteSubmission(input: DeleteSubmissionInput): Promise<DeletedUploadSubmission | undefined> {
    for (const [batchId, batch] of this.batches.entries()) {
      const submission = batch.submissions.find(candidate => candidate.id === input.submissionId);
      if (!submission) {
        continue;
      }

      const previousStatus = submission.status;
      const publication = clone(submission.publication);
      const discord = clone(submission.discord);
      if (publication?.packKey) {
        this.publicObjects.delete(publication.packKey);
      }
      for (const image of publication?.images ?? []) {
        this.publicObjects.delete(image.key);
      }
      if (publication?.packId) {
        this.catalogIndex = {
          ...this.catalogIndex,
          packs: this.catalogIndex.packs.filter(pack => pack.id !== publication.packId)
        };
      }

      this.objects.delete(submission.packObjectId);
      for (const capture of submission.captures) {
        const captureStillUsed = batch.submissions.some(candidate =>
          candidate.id !== submission.id &&
          candidate.status !== "deleted" &&
          candidate.captures.some(candidateCapture => candidateCapture.objectId === capture.objectId)
        );
        if (!captureStillUsed) {
          this.objects.delete(capture.objectId);
        }
      }

      submission.status = "deleted";
      submission.validationReasons = input.reason
        ? [...submission.validationReasons, input.reason]
        : submission.validationReasons;
      delete submission.publication;
      delete submission.reviewClaimedUtc;
      delete submission.moderationDeliveredUtc;
      batch.updatedUtc = input.now.toISOString();
      batch.status = deriveBatchStatus(batch);
      this.batches.set(batchId, clone(batch));
      return {
        batchId: batch.id,
        submissionId: submission.id,
        previousStatus,
        publication,
        discord
      };
    }
    return undefined;
  }

  async reserveUploadQuota(input: UploadQuotaReservationInput): Promise<boolean> {
    if (this.quotaReservations.has(input.reservationId)) {
      return false;
    }

    const active = [...this.quotaReservations.values()].filter(reservation =>
      reservation.createdUtc >= input.windowStartUtc
    );
    const install = active.filter(reservation => reservation.installIdHash === input.installIdHash);
    const network = active.filter(reservation => reservation.networkKeyHash === input.networkKeyHash);
    const installBytes = install.reduce((sum, reservation) => sum + reservation.reservedBytes, 0);
    const networkBytes = network.reduce((sum, reservation) => sum + reservation.reservedBytes, 0);
    if (install.length >= input.maxInstallReservations ||
        installBytes + input.reservedBytes > input.maxInstallBytes ||
        network.length >= input.maxNetworkReservations ||
        networkBytes + input.reservedBytes > input.maxNetworkBytes) {
      return false;
    }

    this.quotaReservations.set(input.reservationId, clone(input));
    return true;
  }

  async cleanupExpired(now: Date, limit: number): Promise<number> {
    let deleted = 0;
    for (const [batchId, batch] of this.batches.entries()) {
      if (deleted >= limit || !shouldDeleteQuarantineBatch(batch, now)) {
        continue;
      }
      for (const [objectId, object] of this.objects.entries()) {
        if (object.batchId === batchId) {
          this.objects.delete(objectId);
        }
      }
      if (batch.submissions.some(submission => submission.status === "published")) {
        for (const submission of batch.submissions) {
          if (isAbandonedModerationSubmission(submission, batch, now) ||
              (submission.status === "awaiting_attribution" && Date.parse(batch.expiresUtc) <= now.getTime())) {
            submission.status = "withdrawn";
            delete submission.reviewClaimedUtc;
            delete submission.moderationDeliveredUtc;
          }
        }
        batch.status = deriveBatchStatus(batch);
        batch.updatedUtc = now.toISOString();
        this.batches.set(batchId, clone(batch));
      } else {
        this.batches.delete(batchId);
      }
      deleted += 1;
    }
    for (const [reservationId, reservation] of this.quotaReservations.entries()) {
      if (Date.parse(reservation.expiresUtc) <= now.getTime()) {
        this.quotaReservations.delete(reservationId);
      }
    }
    for (const [nonce, expiresUtc] of this.botNonces.entries()) {
      if (Date.parse(expiresUtc) <= now.getTime()) {
        this.botNonces.delete(nonce);
      }
    }
    for (const [userId, deliveredUtc] of this.attributionDeliveries.entries()) {
      if (Date.parse(deliveredUtc) <= now.getTime() - attributionDeliveryCooldownMs) {
        this.attributionDeliveries.delete(userId);
      }
    }
    return deleted;
  }

  async recordAttributionDelivery(submissionId: string, now: Date): Promise<void> {
    const found = await this.findSubmission(submissionId);
    if (found?.submission.attribution.mode === "discord") {
      this.attributionDeliveries.set(found.submission.attribution.discordUserId, now.toISOString());
    }
  }

  getPublicObjectForTesting(key: string): { bytes: Buffer; contentType: string } | undefined {
    return clone(this.publicObjects.get(key));
  }

  getCatalogIndexForTesting(): CatalogIndex {
    return clone(this.catalogIndex);
  }

  async rememberBotNonce(nonce: string, expiresUtc: string): Promise<boolean> {
    if (this.botNonces.has(nonce)) {
      return false;
    }
    this.botNonces.set(nonce, expiresUtc);
    return true;
  }
}

export function signBotRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyText: string;
}): string {
  return createHmac("sha256", input.secret)
    .update([input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.bodyText].join("\n"))
    .digest("hex");
}

async function prepareUpload(input: {
  request: Request;
  origin: string;
  store: UploadWorkerStore;
  now: () => Date;
  id: () => string;
  termsVersion: number;
  botSecret: string;
}): Promise<Response> {
  const networkKey = readTrustedNetworkKey(input.request);
  const body = await readJsonObject(input.request);
  const installId = readBoundedString(body, "installId", 256);
  const termsVersion = readRequiredNumber(body, "termsVersion");
  if (termsVersion !== input.termsVersion) {
    return json({ error: "terms_outdated", termsVersion: input.termsVersion }, 409);
  }

  const submissionInputs = readArray(body.submissions, "submissions");
  if (submissionInputs.length === 0) {
    return json({ error: "no_submissions" }, 400);
  }
  if (submissionInputs.length > maxSubmissionsPerBatch) {
    return json({ error: "too_many_submissions", maxSubmissions: maxSubmissionsPerBatch }, 413);
  }

  const batchId = input.id();
  const preparedAt = input.now();
  const createdUtc = preparedAt.toISOString();
  const expiresUtc = new Date(preparedAt.getTime() + preparedUploadTtlMs).toISOString();
  const captureInputs = readCaptureInputs(body);
  if (captureInputs.length > maxCapturesPerBatch) {
    return json({ error: "too_many_captures", maxCaptures: maxCapturesPerBatch }, 413);
  }
  const captureObjects: UploadObjectRecord[] = [];
  const responseCaptures: PreparedCaptureObject[] = [];
  let declaredBytes = 0;
  for (const rawCapture of captureInputs) {
    const capture = readObject(rawCapture, "capture");
    const captureSizeBytes = readRequiredNumber(capture, "sizeBytes");
    const captureContentType = normalizeContentType(readRequiredString(capture, "contentType"));
    if (!Number.isSafeInteger(captureSizeBytes) || captureSizeBytes <= 0 || captureSizeBytes > imageSourceMaxBytes) {
      return json({ error: "capture_too_large", maxBytes: imageSourceMaxBytes }, 413);
    }
    declaredBytes += captureSizeBytes;
    if (!allowedCaptureContentTypes.has(captureContentType)) {
      return json({ error: "capture_type_unsupported" }, 415);
    }

    const captureToken = input.id();
    const captureObject = createObjectRecord({
      id: input.id(),
      token: captureToken,
      kind: "capture",
      batchId,
      maxBytes: captureSizeBytes,
      contentType: captureContentType
    });
    captureObjects.push(captureObject);
    responseCaptures.push({
      objectId: captureObject.id,
      uploadUrl: `${input.origin}/uploads/objects/${captureObject.id}?token=${captureToken}`,
      maxBytes: captureObject.maxBytes,
      roomName: readOptionalBoundedString(capture, "roomName", maxRoomNameLength)
    });
  }

  const preparedSubmissions: UploadSubmissionRecord[] = [];
  const responseSubmissions: Array<{ submissionId: string; pack: PreparedObject }> = [];
  const packObjects: UploadObjectRecord[] = [];
  for (const rawSubmission of submissionInputs) {
    const submission = readObject(rawSubmission, "submission");
    const section = readUploadSection(submission);
    const mapSid = readBoundedString(submission, "mapSid", maxMapSidLength);
    const mapUrl = readOptionalMapUrl(submission);
    const title = readBoundedString(submission, "title", maxTitleLength);
    const description = readBoundedString(submission, "description", maxDescriptionLength);
    const packSizeBytes = readRequiredNumber(submission, "packSizeBytes");
    if (!Number.isSafeInteger(packSizeBytes) || packSizeBytes <= 0 || packSizeBytes > akrMaxBytes) {
      return json({ error: "pack_too_large", maxBytes: akrMaxBytes }, 413);
    }
    declaredBytes += packSizeBytes;
    if (declaredBytes > maxBatchDeclaredBytes) {
      return json({ error: "batch_too_large", maxBytes: maxBatchDeclaredBytes }, 413);
    }

    const attribution = readAttribution(submission.attribution);
    const submissionId = input.id();
    const packToken = input.id();
    const packObject = createObjectRecord({
      id: input.id(),
      token: packToken,
      kind: "pack",
      batchId,
      submissionId,
      maxBytes: packSizeBytes,
      contentType: "application/octet-stream"
    });

    preparedSubmissions.push({
      id: submissionId,
      batchId,
      section,
      mapSid,
      mapUrl,
      title,
      description,
      packObjectId: packObject.id,
      captures: responseCaptures.map(capture => ({
        objectId: capture.objectId,
        roomName: capture.roomName
      })),
      attribution,
      status: "prepared",
      validationReasons: []
    });
    responseSubmissions.push({
      submissionId,
      pack: {
        objectId: packObject.id,
        uploadUrl: `${input.origin}/uploads/objects/${packObject.id}?token=${packToken}`,
        maxBytes: packObject.maxBytes
      }
    });
    packObjects.push(packObject);
  }

  // Cleanup is bounded so one request cannot turn retention work into an
  // unbounded public endpoint. Failure is intentionally fatal: accepting more
  // storage while retention is broken would make the quota ineffective.
  await input.store.cleanupExpired(preparedAt, 10);
  const installIdHash = hashInstallId(installId);
  const quotaReserved = await input.store.reserveUploadQuota({
    reservationId: batchId,
    installIdHash,
    networkKeyHash: hashNetworkKey(networkKey, input.botSecret),
    reservedBytes: declaredBytes,
    createdUtc,
    expiresUtc: new Date(preparedAt.getTime() + uploadQuotaWindowMs).toISOString(),
    windowStartUtc: new Date(preparedAt.getTime() - uploadQuotaWindowMs).toISOString(),
    maxInstallReservations: maxInstallReservationsPerWindow,
    maxInstallBytes: maxInstallBytesPerWindow,
    maxNetworkReservations: maxNetworkReservationsPerWindow,
    maxNetworkBytes: maxNetworkBytesPerWindow
  });
  if (!quotaReserved) {
    return json({ error: "upload_quota_exceeded" }, 429);
  }

  await input.store.putBatch({
    id: batchId,
    installIdHash,
    termsVersion,
    status: "prepared",
    createdUtc,
    updatedUtc: createdUtc,
    expiresUtc,
    submissions: preparedSubmissions
  });
  for (const captureObject of captureObjects) {
    await input.store.putObject(captureObject);
  }
  for (const packObject of packObjects) {
    await input.store.putObject(packObject);
  }

  const responseBody: Record<string, unknown> = {
    batchId,
    expiresUtc,
    captures: responseCaptures,
    submissions: responseSubmissions
  };
  return json(responseBody, 201);
}

function readCaptureInputs(body: Record<string, unknown>): unknown[] {
  if (body.captures === undefined || body.captures === null) {
    return [];
  }
  return readArray(body.captures, "captures");
}

async function putUploadObject(input: {
  request: Request;
  objectId: string;
  token: string;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const object = await input.store.getObject(input.objectId, { includeBytes: false });
  if (!object || object.tokenHash !== hashToken(input.token)) {
    return json({ error: "upload_token_invalid" }, 403);
  }
  const batch = await input.store.getBatch(object.batchId);
  if (!batch) {
    return json({ error: "batch_not_found" }, 404);
  }
  if (Date.parse(batch.expiresUtc) <= input.now().getTime()) {
    batch.status = "withdrawn";
    batch.updatedUtc = input.now().toISOString();
    await input.store.putBatch(batch);
    return json({ error: "batch_expired" }, 410);
  }
  if (batch.status !== "prepared") {
    return json({ error: "batch_not_prepared", status: batch.status }, 409);
  }

  const uploadedBytes = readContentLength(input.request);
  if (uploadedBytes === undefined) {
    return json({ error: "upload_length_required" }, 411);
  }
  if (uploadedBytes > object.maxBytes) {
    return json({ error: "upload_object_too_large", maxBytes: object.maxBytes }, 413);
  }
  const contentType = normalizeContentType(input.request.headers.get("content-type") || object.contentType);
  if (object.kind === "capture" && !allowedCaptureContentTypes.has(contentType)) {
    return json({ error: "capture_type_unsupported" }, 415);
  }
  if (!input.request.body) {
    return json({ error: "upload_body_required" }, 400);
  }

  let stored: UploadedObjectWriteResult;
  try {
    stored = await input.store.putUploadedObject(object.id, {
      body: input.request.body,
      contentType,
      declaredBytes: uploadedBytes
    });
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return json({ error: "upload_object_too_large", maxBytes: error.maxBytes }, 413);
    }
    throw error;
  }
  if (!stored.ok) {
    return json({ error: "upload_object_locked" }, 409);
  }
  return json({ ok: true, objectId: object.id, uploadedBytes: stored.uploadedBytes });
}

async function getSignedSourceObject(input: {
  objectId: string;
  expires: string;
  signature: string;
  store: UploadWorkerStore;
  botSecret: string;
  now: () => Date;
}): Promise<Response> {
  const expiresMs = Number.parseInt(input.expires, 10);
  if (!Number.isFinite(expiresMs) || expiresMs <= input.now().getTime()) {
    return json({ error: "source_url_expired" }, 403);
  }

  const expected = signSourceObject(input.botSecret, input.objectId, input.expires);
  if (!safeEqualHex(input.signature, expected)) {
    return json({ error: "source_url_invalid" }, 403);
  }

  const object = await input.store.getObject(input.objectId, { includeBytes: false });
  if (object?.kind !== "capture" || object.uploadedBytes === undefined) {
    return json({ error: "source_object_not_found" }, 404);
  }
  const uploaded = await input.store.getUploadedObjectBody(object.id);
  if (!uploaded) {
    return json({ error: "source_object_not_found" }, 404);
  }

  return new Response(responseBody(uploaded.body), {
    headers: {
      "content-type": uploaded.contentType,
      "content-length": String(uploaded.uploadedBytes),
      "cache-control": "no-store"
    }
  });
}

async function getSignedCatalogCaptureSource(input: {
  sourceUrl: string;
  expires: string;
  signature: string;
  botSecret: string;
  now: () => Date;
  fetchSource: (sourceUrl: string, signal?: AbortSignal) => Promise<Response>;
}): Promise<Response> {
  const expiresMs = Number.parseInt(input.expires, 10);
  if (!Number.isFinite(expiresMs) || expiresMs <= input.now().getTime()) {
    return json({ error: "source_url_expired" }, 403);
  }
  if (!isTrustedDiscordCaptureUrl(input.sourceUrl)) {
    return json({ error: "catalog_capture_source_invalid" }, 400);
  }

  const expected = signCatalogCaptureSource(input.botSecret, input.sourceUrl, input.expires);
  if (!safeEqualHex(input.signature, expected)) {
    return json({ error: "source_url_invalid" }, 403);
  }

  const source = await input.fetchSource(input.sourceUrl, AbortSignal.timeout(15_000));
  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = source.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  return new Response(source.body, {
    status: source.status,
    statusText: source.statusText,
    headers
  });
}

async function completeUpload(input: {
  request: Request;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const installId = readRequiredString(body, "installId");
  const batchId = readRequiredString(body, "batchId");
  const batch = await requireClientBatch(input.store, batchId, installId);
  if (batch instanceof Response) {
    return batch;
  }
  if (batch.status !== "prepared") {
    return json({ error: "batch_not_prepared", status: batch.status }, 409);
  }
  if (Date.parse(batch.expiresUtc) <= input.now().getTime()) {
    batch.status = "withdrawn";
    batch.updatedUtc = input.now().toISOString();
    await input.store.putBatch(batch);
    return json({ error: "batch_expired" }, 410);
  }

  for (const submission of batch.submissions) {
    const pack = await input.store.getObject(submission.packObjectId, { includeBytes: false });
    const captures = await loadSubmissionCaptureObjects(input.store, submission, false);
    if (!isUploadedObjectReady(pack) || captures.some(capture => !isUploadedObjectReady(capture))) {
      return json({ error: "upload_objects_missing", submissionId: submission.id }, 409);
    }
  }

  batch.status = "reviewing";
  batch.updatedUtc = input.now().toISOString();
  if (!await input.store.tryBeginCompletion(batch)) {
    return json({ error: "batch_not_prepared", status: "locked" }, 409);
  }

  try {
    const uploadedSubmissions: Array<{ submission: UploadSubmissionRecord; packBytes: Buffer }> = [];
    for (const submission of batch.submissions) {
      const pack = await input.store.getObject(submission.packObjectId);
      const captures = await loadSubmissionCaptureObjects(input.store, submission, false);
      if (!pack?.bytes || captures.some(capture => !isUploadedObjectReady(capture))) {
        batch.status = "prepared";
        batch.updatedUtc = input.now().toISOString();
        await input.store.putBatch(batch);
        return json({ error: "upload_objects_missing", submissionId: submission.id }, 409);
      }
      uploadedSubmissions.push({ submission, packBytes: pack.bytes });
    }

    let hasPendingAttribution = false;
    for (const { submission, packBytes } of uploadedSubmissions) {
      const validation = await validateAkrArchive(packBytes);
      const reasons = [...validation.reasons];
      submission.archiveFacts = validation.normalizedFacts;
      if (validation.section !== submission.section) {
        reasons.push("Uploaded archive section does not match prepared submission.");
      }
      if (validation.mapSid !== submission.mapSid) {
        reasons.push("Uploaded archive map SID does not match prepared submission.");
      }
      submission.validationReasons = reasons;
      if (reasons.length > 0) {
        submission.status = "rejected";
        continue;
      }

      if (submission.attribution.mode === "discord" && !submission.attribution.confirmed) {
        submission.status = "awaiting_attribution";
        hasPendingAttribution = true;
      } else {
        submission.status = "queued";
      }
      submission.queuedUtc ??= input.now().toISOString();
      submission.moderationAttempts ??= 0;
    }

    batch.status = batch.submissions.every(submission => submission.status === "rejected")
      ? "rejected"
      : hasPendingAttribution
        ? "awaiting_attribution"
        : "queued";
    batch.updatedUtc = input.now().toISOString();
    if (hasPendingAttribution) {
      batch.expiresUtc = new Date(input.now().getTime() + attributionTtlMs).toISOString();
    }
    await input.store.putBatch(batch);
    return json(publicBatchStatus(batch));
  } catch (error) {
    batch.status = "prepared";
    batch.updatedUtc = input.now().toISOString();
    await input.store.putBatch(batch);
    throw error;
  }
}

async function getUploadStatus(input: {
  batchId: string;
  installId: string;
  store: UploadWorkerStore;
}): Promise<Response> {
  const batch = await requireClientBatch(input.store, input.batchId, input.installId);
  return batch instanceof Response ? batch : json(publicBatchStatus(batch));
}

async function updateClientSubmissionStatus(input: {
  request: Request;
  submissionId: string;
  store: UploadWorkerStore;
  now: () => Date;
  nextStatus: UploadStatus;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const installId = readRequiredString(body, "installId");
  const found = await findClientSubmission(input.store, readRequiredString(body, "batchId"), input.submissionId, installId);
  if (found instanceof Response) {
    return found;
  }
  if (found.submission.status === "published") {
    return json({ error: "submission_already_published" }, 409);
  }
  if (found.submission.status === "deleted") {
    return json({ error: "submission_deleted" }, 409);
  }
  if (found.submission.status === "reviewing" || found.submission.status === "moderating") {
    return json({ error: "submission_locked", status: found.submission.status }, 409);
  }
  const saved = await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
    if (submission.status === "published" || submission.status === "deleted" ||
        submission.status === "reviewing" || submission.status === "moderating") {
      throw new HttpError(409, "submission_locked");
    }
    submission.status = input.nextStatus;
  });
  const savedBatch = saved?.batch ?? found.batch;
  return json(publicBatchStatus(savedBatch));
}

async function convertSubmissionToAnonymous(input: {
  request: Request;
  submissionId: string;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const installId = readRequiredString(body, "installId");
  const found = await findClientSubmission(input.store, readRequiredString(body, "batchId"), input.submissionId, installId);
  if (found instanceof Response) {
    return found;
  }
  if (found.submission.status === "published") {
    return json({ error: "submission_already_published" }, 409);
  }
  if (found.submission.status === "deleted") {
    return json({ error: "submission_deleted" }, 409);
  }
  if (found.submission.status === "moderating") {
    return json({ error: "submission_locked", status: found.submission.status }, 409);
  }
  const saved = await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
    if (submission.status === "published" || submission.status === "deleted" || submission.status === "moderating") {
      throw new HttpError(409, "submission_locked");
    }
    const shouldQueueForModeration = submission.attribution.mode === "discord" &&
      !submission.attribution.confirmed &&
      (submission.status === "awaiting_attribution" || submission.status === "reviewing");
    submission.attribution = { mode: "anonymous" };
    if (shouldQueueForModeration) {
      submission.status = "queued";
      delete submission.reviewClaimedUtc;
      delete submission.moderationDeliveredUtc;
    }
  });
  const savedBatch = saved?.batch ?? found.batch;
  return json(publicBatchStatus(savedBatch));
}

async function confirmAttribution(input: {
  body: Record<string, unknown>;
  submissionId: string;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const discordUserId = readRequiredString(input.body, "discordUserId");
  let found = await findSubmission(input.store, input.submissionId);
  if (!found) {
    return json({ error: "submission_not_found" }, 404);
  }
  if (found.submission.attribution.mode !== "discord" || found.submission.attribution.discordUserId !== discordUserId) {
    return json({ error: "attribution_user_mismatch" }, 403);
  }
  if (Date.parse(found.batch.expiresUtc) <= input.now().getTime()) {
    return json({ error: "attribution_expired" }, 410);
  }
  const saved = await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
    if (submission.attribution.mode !== "discord" || submission.attribution.discordUserId !== discordUserId) {
      throw new HttpError(403, "attribution_user_mismatch");
    }
    submission.attribution = { ...submission.attribution, confirmed: true };
    if (submission.status === "awaiting_attribution" || submission.status === "reviewing") {
      submission.status = "queued";
      delete submission.reviewClaimedUtc;
      delete submission.moderationDeliveredUtc;
    }
  });
  const savedBatch = saved?.batch ?? found.batch;
  return json(publicBatchStatus(savedBatch));
}

async function applyModerationAction(input: {
  submissionId: string;
  action: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
  origin: string;
  botSecret: string;
  optimizeCatalogCapture?: (sourceUrl: string) => Promise<OptimizedCatalogCapture>;
}): Promise<Response> {
  let found = await findSubmission(input.store, input.submissionId);
  if (!found) {
    return json({ error: "submission_not_found" }, 404);
  }
  if (input.action === "approve" && found.submission.status === "published") {
    return json(botBatchStatus(found.batch));
  }
  if (!isModeratableStatus(found.submission.status)) {
    return json({ error: "submission_not_reviewable", status: found.submission.status }, 409);
  }
  if (found.submission.attribution.mode === "discord" && !found.submission.attribution.confirmed && input.action === "approve") {
    return json({ error: "attribution_pending" }, 409);
  }
  if (!await input.store.tryReserveModerationAction(found.batch, found.submission.id, input.now())) {
    return json({ error: "submission_not_reviewable", status: "locked" }, 409);
  }

  const reserved = await findSubmission(input.store, input.submissionId);
  if (!reserved) {
    return json({ error: "submission_not_found" }, 404);
  }
  found = reserved;
  found.submission.status = "moderating";
  if (input.action === "approve") {
    try {
      const pack = await input.store.getObject(found.submission.packObjectId);
      const captureRecords = await loadSubmissionCaptureObjects(input.store, found.submission, false);
      if (!pack?.bytes || captureRecords.some(capture => !isUploadedObjectReady(capture))) {
        await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
          submission.status = "reviewing";
        });
        return json({ error: "upload_objects_missing", submissionId: found.submission.id }, 409);
      }
      const author = readCatalogAuthor(input.body, found.submission.attribution);
      found.submission.publication = await input.store.publishCatalogEntry({
        submission: found.submission,
        pack,
        captures: captureRecords.filter((capture): capture is UploadObjectRecord => Boolean(capture)),
        now: input.now(),
        authorName: author.name,
        authorAvatarUrl: author.avatarUrl,
        captureSourceUrls: found.submission.captures.map(capture =>
          signedSourceObjectUrl(input.origin, capture.objectId, input.botSecret, input.now())
        ),
        optimizeCatalogCapture: input.optimizeCatalogCapture ?? unavailableCatalogCaptureOptimizer
      });
      found.submission.status = "published";
    } catch (error) {
      await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
        submission.status = "reviewing";
      });
      throw error;
    }
  } else if (input.action === "reject") {
    found.submission.status = "rejected";
    found.submission.validationReasons.push(readOptionalString(input.body, "reason") || "Rejected by moderator.");
  } else if (input.action === "request-changes") {
    found.submission.status = "changes_requested";
    found.submission.validationReasons.push(readOptionalString(input.body, "reason") || "Changes requested by moderator.");
  } else {
    return json({ error: "moderation_action_unknown" }, 404);
  }

  const saved = await input.store.mutateSubmission(input.submissionId, input.now(), submission => {
    submission.status = found.submission.status;
    submission.publication = found.submission.publication;
    submission.validationReasons = [...found.submission.validationReasons];
  });
  const savedBatch = saved?.batch ?? found.batch;
  return json(botBatchStatus(savedBatch));
}

async function acknowledgeDeliveredModerationJobs(input: {
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const submissionIds = readArray(input.body.submissionIds, "submissionIds")
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map(value => value.trim());
  for (const submissionId of submissionIds) {
    const saved = await input.store.mutateSubmission(submissionId, input.now(), submission => {
      if (submission.status === "reviewing") submission.moderationDeliveredUtc = input.now().toISOString();
    });
    if (saved?.submission.status === "reviewing" && saved.submission.moderationDeliveredUtc) {
      await input.store.recordAttributionDelivery(submissionId, input.now());
    }
  }

  return json({ ok: true, delivered: submissionIds.length });
}

async function claimModerationJobs(input: {
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
  origin: string;
  botSecret: string;
}): Promise<Response> {
  const requestedLimit = Math.trunc(readOptionalNumber(input.body, "limit") || 10);
  const limit = Math.min(Math.max(requestedLimit, 1), 25);
  const jobs = await input.store.claimModerationJobs(limit, input.now());
  return json({
    jobs: jobs.map(job => ({
      batchId: job.batch.id,
      submissionId: job.submission.id,
      section: job.submission.section,
      mapSid: job.submission.mapSid,
      title: job.submission.title,
      description: job.submission.description,
      attribution: botAttribution(job.submission.attribution),
      status: job.submission.status,
      validationReasons: job.submission.validationReasons,
      archiveFacts: job.submission.archiveFacts ?? {},
      aiReview: job.submission.aiReview,
      captures: botCaptureSources(job.submission, input.origin, input.botSecret, input.now())
    }))
  });
}

async function getBotSubmissionContext(input: {
  submissionId: string;
  store: UploadWorkerStore;
  now: () => Date;
  origin: string;
  botSecret: string;
}): Promise<Response> {
  const found = await findSubmission(input.store, input.submissionId);
  if (!found) {
    return json({ error: "submission_not_found" }, 404);
  }

  return json({
    batchId: found.batch.id,
    submissionId: found.submission.id,
    section: found.submission.section,
    mapSid: found.submission.mapSid,
    title: found.submission.title,
    description: found.submission.description,
    status: found.submission.status,
    validationReasons: found.submission.validationReasons,
    archiveFacts: found.submission.archiveFacts ?? {},
    aiReview: found.submission.aiReview,
    attribution: botAttribution(found.submission.attribution),
    publication: found.submission.publication,
    captures: botCaptureSources(found.submission, input.origin, input.botSecret, input.now())
  });
}

async function recordAiReview(input: {
  submissionId: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const decision = readRequiredString(input.body, "decision");
  const severity = readRequiredString(input.body, "severity");
  if (decision !== "allow" && decision !== "needs_review" && decision !== "reject") {
    return json({ error: "ai_review_decision_invalid" }, 400);
  }
  if (severity !== "low" && severity !== "medium" && severity !== "high") {
    return json({ error: "ai_review_severity_invalid" }, 400);
  }
  const reasons = readArray(input.body.reasons ?? [], "reasons")
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map(value => value.trim().slice(0, 500))
    .slice(0, 10);

  const saved = await input.store.recordAiReview({
    submissionId: input.submissionId,
    review: { decision, severity, reasons },
    now: input.now()
  });
  if (!saved) {
    return json({ error: "submission_not_found" }, 404);
  }
  return json({ ok: true, submissionId: saved.id, aiReview: saved.aiReview });
}

async function transformCatalogCapture(input: {
  body: Record<string, unknown>;
  optimize?: (sourceUrl: string) => Promise<OptimizedCatalogCapture>;
  origin: string;
  botSecret: string;
  now: () => Date;
}): Promise<Response> {
  if (!input.optimize) {
    return json({ error: "catalog_capture_transform_unavailable" }, 503);
  }
  const sourceUrl = readRequiredString(input.body, "sourceUrl");
  if (!isTrustedDiscordCaptureUrl(sourceUrl)) {
    return json({ error: "catalog_capture_source_invalid" }, 400);
  }

  // Cloudflare accepts same-zone image sources by default. Proxy the allowlisted
  // Discord URL through this signed route so deployments do not depend on a
  // separate Images dashboard origin configuration.
  const signedSourceUrl = signedCatalogCaptureSourceUrl(
    input.origin,
    sourceUrl,
    input.botSecret,
    input.now()
  );
  const transformed = await input.optimize(signedSourceUrl);
  return json({
    contentType: transformed.contentType,
    bytesBase64: transformed.bytes.toString("base64")
  });
}

function isTrustedDiscordCaptureUrl(sourceUrl: string): boolean {
  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      trustedDiscordCaptureHosts.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function requeueModerationJobs(input: {
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const submissionIds = readArray(input.body.submissionIds, "submissionIds")
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map(value => value.trim());
  for (const submissionId of submissionIds) {
    await input.store.mutateSubmission(submissionId, input.now(), submission => {
      if (submission.status !== "reviewing") return;
      submission.status = submission.attribution.mode === "discord" && !submission.attribution.confirmed
        ? "awaiting_attribution"
        : "queued";
      delete submission.reviewClaimedUtc;
      delete submission.moderationDeliveredUtc;
    });
  }

  return json({ ok: true, requeued: submissionIds.length });
}

async function recordDiscordMessage(input: {
  submissionId: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const kind = readRequiredString(input.body, "kind");
  if (kind !== "review" && kind !== "publication") {
    return json({ error: "discord_message_kind_invalid" }, 400);
  }

  const saved = await input.store.recordDiscordMessage({
    submissionId: input.submissionId,
    kind,
    message: {
      guildId: readRequiredString(input.body, "guildId"),
      channelId: readRequiredString(input.body, "channelId"),
      messageId: readRequiredString(input.body, "messageId"),
      threadId: readOptionalString(input.body, "threadId") || undefined
    },
    now: input.now()
  });
  if (!saved) {
    return json({ error: "submission_not_found" }, 404);
  }
  return json({ ok: true, submissionId: saved.id, discord: saved.discord });
}

async function deleteSubmission(input: {
  submissionId: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const deleted = await input.store.deleteSubmission({
    submissionId: input.submissionId,
    now: input.now(),
    reason: readOptionalString(input.body, "reason") || undefined
  });
  if (!deleted) {
    return json({ error: "submission_not_found" }, 404);
  }
  return json({ ok: true, deleted });
}

async function deleteSubmissionByDiscordThread(input: {
  threadId: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const found = await input.store.findSubmissionByDiscordThread(input.threadId);
  if (!found) {
    return json({ error: "submission_not_found" }, 404);
  }

  const deleted = await input.store.deleteSubmission({
    submissionId: found.submission.id,
    now: input.now(),
    reason: readOptionalString(input.body, "reason") || undefined
  });
  if (!deleted) {
    return json({ error: "submission_not_found" }, 404);
  }
  return json({ ok: true, deleted });
}

async function readSignedJson(
  request: Request,
  secret: string,
  now: () => Date,
  store: UploadWorkerStore
): Promise<Record<string, unknown> | Response> {
  const declaredLength = readContentLength(request);
  if (declaredLength !== undefined && declaredLength > botJsonMaxBytes) {
    return json({ error: "json_body_too_large" }, 413);
  }
  const timestamp = request.headers.get("x-akron-timestamp") ?? "";
  const nonce = request.headers.get("x-akron-nonce") ?? "";
  const signature = request.headers.get("x-akron-signature") ?? "";
  const requestTime = Date.parse(timestamp);
  if (!timestamp || timestamp.length > 64 || !/^[!-~]{1,128}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature) || !Number.isFinite(requestTime)) {
    return json({ error: "bot_signature_missing" }, 401);
  }
  if (Math.abs(now().getTime() - requestTime) > botSignatureWindowMs) {
    return json({ error: "bot_signature_expired" }, 401);
  }

  let bodyText: string;
  try {
    bodyText = await readBoundedRequestText(request, botJsonMaxBytes);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return json({ error: "json_body_too_large" }, 413);
    }
    throw error;
  }

  const expected = signBotRequest({
    secret,
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp,
    nonce,
    bodyText
  });
  if (!safeEqualHex(signature, expected)) {
    return json({ error: "bot_signature_invalid" }, 401);
  }
  const acceptedNonce = await store.rememberBotNonce(nonce, new Date(requestTime + botSignatureWindowMs).toISOString());
  if (!acceptedNonce) {
    return json({ error: "bot_signature_replayed" }, 401);
  }
  return parseJsonObject(bodyText);
}

async function requireClientBatch(
  store: UploadWorkerStore,
  batchId: string,
  installId: string
): Promise<UploadBatchRecord | Response> {
  const batch = await store.getBatch(batchId);
  if (!batch) {
    return json({ error: "batch_not_found" }, 404);
  }
  if (batch.installIdHash !== hashInstallId(installId)) {
    return json({ error: "batch_owner_mismatch" }, 403);
  }
  return batch;
}

async function findClientSubmission(
  store: UploadWorkerStore,
  batchId: string,
  submissionId: string,
  installId: string
): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | Response> {
  const batch = await requireClientBatch(store, batchId, installId);
  if (batch instanceof Response) {
    return batch;
  }
  const submission = batch.submissions.find(candidate => candidate.id === submissionId);
  if (!submission) {
    return json({ error: "submission_not_found" }, 404);
  }
  return { batch, submission };
}

async function findSubmission(
  store: UploadWorkerStore,
  submissionId: string
): Promise<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord } | undefined> {
  return store.findSubmission(submissionId);
}

function createObjectRecord(input: {
  id: string;
  token: string;
  kind: UploadObjectKind;
  batchId: string;
  submissionId?: string;
  maxBytes: number;
  contentType: string;
}): UploadObjectRecord {
  return {
    id: input.id,
    tokenHash: hashToken(input.token),
    kind: input.kind,
    batchId: input.batchId,
    submissionId: input.submissionId,
    maxBytes: input.maxBytes,
    contentType: input.contentType
  };
}

function deriveBatchStatus(batch: UploadBatchRecord): UploadStatus {
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

function isModeratableStatus(status: UploadStatus): boolean {
  return status === "queued" || status === "reviewing" || status === "awaiting_attribution";
}

function isUploadedObjectReady(object: UploadObjectRecord | undefined): boolean {
  return typeof object?.uploadedBytes === "number" && object.uploadedBytes > 0;
}

async function loadSubmissionCaptureObjects(
  store: UploadWorkerStore,
  submission: UploadSubmissionRecord,
  includeBytes: boolean
): Promise<Array<UploadObjectRecord | undefined>> {
  return await Promise.all(submission.captures.map(capture =>
    store.getObject(capture.objectId, { includeBytes })
  ));
}

function botCaptureSources(
  submission: UploadSubmissionRecord,
  origin: string,
  botSecret: string,
  now: Date
): Array<{ objectId: string; roomName: string; sourceUrl: string }> {
  return submission.captures.map(capture => ({
    objectId: capture.objectId,
    roomName: capture.roomName,
    sourceUrl: signedSourceObjectUrl(origin, capture.objectId, botSecret, now)
  }));
}

async function unavailableCatalogCaptureOptimizer(): Promise<OptimizedCatalogCapture> {
  throw new Error("Catalog capture transformation is unavailable.");
}

function isClaimableModerationStatus(submission: UploadSubmissionRecord, now: Date): boolean {
  if (submission.status === "queued" || submission.status === "awaiting_attribution") {
    return true;
  }
  if (submission.status !== "reviewing" && submission.status !== "moderating") {
    return false;
  }
  if (submission.moderationDeliveredUtc) {
    return false;
  }

  const claimedAt = Date.parse(submission.reviewClaimedUtc ?? "");
  return !Number.isFinite(claimedAt) || claimedAt <= now.getTime() - moderationClaimLeaseMs;
}

function publicBatchStatus(batch: UploadBatchRecord): Record<string, unknown> {
  return batchStatus(batch, publicAttribution);
}

function botBatchStatus(batch: UploadBatchRecord): Record<string, unknown> {
  return batchStatus(batch, botAttribution);
}

function batchStatus(
  batch: UploadBatchRecord,
  attribution: (attribution: UploadAttribution) => Record<string, unknown>
): Record<string, unknown> {
  return {
    batchId: batch.id,
    status: batch.status,
    expiresUtc: batch.expiresUtc,
    submissions: batch.submissions.map(submission => ({
      submissionId: submission.id,
      section: submission.section,
      mapSid: submission.mapSid,
      title: submission.title,
      description: submission.description,
      attribution: attribution(submission.attribution),
      status: submission.status,
      validationReasons: submission.validationReasons,
      publication: submission.publication
    }))
  };
}

export type CatalogPack = {
  id: string;
  title: string;
  description: string;
  section: AkronProfileSection;
  mapSid: string;
  mapUrl: string;
  discordUrl: string;
  downloadUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  images: Array<{ url: string; roomName: string }>;
  imageUrl?: string;
  downloadCount: number;
  updatedUtc: string;
  tags: string[];
  sha256: string;
  sizeBytes: number;
};

export type CatalogIndex = {
  format: "akron-community-pack-index-v3";
  version: 3;
  packs: CatalogPack[];
};

export function buildPublication(
  submission: UploadSubmissionRecord,
  captures: UploadObjectRecord[],
  now: Date,
  publicBaseUrl: string,
  packBytes: Buffer
): CatalogPublication {
  const mapSlug = slugMapSid(submission.mapSid);
  const packId = buildPackId(submission);
  const revision = createHash("sha256").update(packBytes).digest("hex").slice(0, 16);
  const packKey = `packs/${mapSlug}/${packId}-${revision}.akr`;
  const images = captures.map((capture, index) => {
    const roomName = submission.captures[index]?.roomName ?? "";
    const imageName = imageNameForCapture(roomName, index);
    const key = `captures/${mapSlug}/${packId}-${revision}/${imageName}.${imageExtensionForContentType(capture.contentType)}`;
    return {
      key,
      url: publicAssetUrl(publicBaseUrl, key),
      roomName
    };
  });
  return {
    packId,
    packKey,
    downloadUrl: publicAssetUrl(publicBaseUrl, packKey),
    images,
    publishedUtc: now.toISOString(),
    sha256: createHash("sha256").update(packBytes).digest("hex"),
    sizeBytes: packBytes.length
  };
}

export function buildCatalogPack(
  submission: UploadSubmissionRecord,
  publication: CatalogPublication,
  now: Date,
  authorName = authorNameForAttribution(submission.attribution),
  authorAvatarUrl = ""
): CatalogPack {
  const mapSlug = slugMapSid(submission.mapSid);
  return {
    id: publication.packId,
    title: submission.title,
    description: submission.description,
    section: submission.section,
    mapSid: submission.mapSid,
    mapUrl: submission.mapUrl,
    discordUrl: discordPublicationUrl(submission),
    downloadUrl: publication.downloadUrl,
    authorName,
    authorAvatarUrl,
    images: publication.images.map(image => ({ url: image.url, roomName: image.roomName })),
    downloadCount: 0,
    updatedUtc: now.toISOString(),
    tags: [sectionTag(submission.section), mapSlug],
    sha256: publication.sha256,
    sizeBytes: publication.sizeBytes
  };
}

function discordPublicationUrl(submission: UploadSubmissionRecord): string {
  const message = submission.discord?.publication;
  const threadId = message?.threadId ?? "";
  if (!message || !/^[0-9]{1,20}$/.test(message.guildId) || !/^[0-9]{1,20}$/.test(threadId)) {
    return "";
  }
  return `https://discord.com/channels/${message.guildId}/${threadId}`;
}

function imageNameForCapture(roomName: string, index: number): string {
  const normalized = roomName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${normalized || "image"}`;
}

export function mergeCatalogIndex(index: CatalogIndex, entry: CatalogPack): CatalogIndex {
  const packs = index.packs.filter(pack => pack.id !== entry.id);
  packs.push(entry);
  packs.sort((left, right) => left.title.localeCompare(right.title));
  return { format: "akron-community-pack-index-v3", version: 3, packs };
}

export function emptyCatalogIndex(): CatalogIndex {
  return { format: "akron-community-pack-index-v3", version: 3, packs: [] };
}

function buildPackId(submission: UploadSubmissionRecord): string {
  return `${slugText(submission.title)}-${submission.id.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12)}`;
}

function slugMapSid(mapSid: string): string {
  return slugText(mapSid).slice(0, 96) || "unknown-map";
}

function slugText(value: string): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function publicAssetUrl(publicBaseUrl: string, key: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${publicAssetPath(key)}`;
}

function publicAssetPath(key: string): string {
  const parts = key.split("/").filter(Boolean);
  if (key === "catalog/index.json") {
    return "/catalog/index.json";
  }
  if (parts[0] === "packs" && parts.length === 3) {
    return "/maps/" + encodePathSegments(parts.slice(1).join("/"));
  }
  if (parts[0] === "captures" && parts.length === 3) {
    const captureName = parts[2]?.replace(/\.webp$/i, "").replace(/\.(png|jpg|jpeg)$/i, "") ?? "";
    return "/maps/" + encodePathSegments(`${parts[1]}/${captureName}/capture.webp`);
  }
  if (parts[0] === "captures" && parts.length === 4) {
    return "/maps/" + encodePathSegments(`${parts[1]}/${parts[2]}/captures/${parts[3]}`);
  }
  return "/r2-assets/" + encodePathSegments(key);
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function imageExtensionForContentType(contentType: string): "png" | "jpg" | "webp" {
  if (contentType === "image/jpeg") {
    return "jpg";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  return "png";
}

function authorNameForAttribution(attribution: UploadAttribution): string {
  if (attribution.mode === "discord" && attribution.confirmed) {
    return `Discord user ${attribution.discordUserId}`;
  }
  return "Anonymous";
}

function readCatalogAuthor(body: Record<string, unknown>, attribution: UploadAttribution): { name: string; avatarUrl: string } {
  if (attribution.mode !== "discord") {
    return { name: "Anonymous", avatarUrl: "" };
  }

  const name = readBoundedString(body, "authorName", 256);
  const avatarUrl = readBoundedString(body, "authorAvatarUrl", 2048);
  let avatar: URL;
  try {
    avatar = new URL(avatarUrl);
  } catch {
    throw new HttpError(400, "catalog_author_avatar_invalid");
  }
  const approvedHost = avatar.hostname === "cdn.discordapp.com" || avatar.hostname === "media.discordapp.net";
  if (avatar.protocol !== "https:" || avatar.port || !approvedHost ||
      (!avatar.pathname.startsWith("/avatars/") && !avatar.pathname.startsWith("/embed/avatars/"))) {
    throw new HttpError(400, "catalog_author_avatar_invalid");
  }
  return { name, avatarUrl: avatar.toString() };
}

function publicAttribution(attribution: UploadAttribution): Record<string, unknown> {
  if (attribution.mode === "anonymous") {
    return { mode: "anonymous", label: "Anonymous" };
  }
  return {
    mode: "discord",
    label: attribution.confirmed ? "Discord confirmed" : "Discord confirmation pending",
    confirmed: attribution.confirmed
  };
}

function botAttribution(attribution: UploadAttribution): Record<string, unknown> {
  if (attribution.mode === "anonymous") {
    return publicAttribution(attribution);
  }
  return {
    ...publicAttribution(attribution),
    discordUserId: attribution.discordUserId
  };
}

function readUploadSection(source: Record<string, unknown>): UploadSection {
  const section = readRequiredString(source, "section");
  if (!allowedUploadSections.has(section as UploadSection)) {
    throw new HttpError(400, "section_unsupported");
  }
  return section as UploadSection;
}

function readAttribution(source: unknown): UploadAttribution {
  const attribution = readObject(source, "attribution");
  const mode = readRequiredString(attribution, "mode");
  if (mode === "anonymous") {
    return { mode };
  }
  if (mode === "discord") {
    return { mode, discordUserId: readDiscordUserId(attribution), confirmed: false };
  }
  throw new HttpError(400, "attribution_mode_unsupported");
}

function readCatalogPack(source: unknown): CatalogPack {
  const entry = readObject(source, "entry");
  const section = readUploadSection(entry);
  const sha256 = readRequiredString(entry, "sha256");
  const sizeBytes = readRequiredNumber(entry, "sizeBytes");
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > akrMaxBytes) {
    throw new HttpError(400, "catalog_integrity_invalid");
  }
  const images = readArray(entry.images ?? [], "images").map(rawImage => {
    const image = readObject(rawImage, "image");
    return {
      url: readBoundedString(image, "url", 2048),
      roomName: readOptionalBoundedString(image, "roomName", maxRoomNameLength)
    };
  });
  if (images.length > 16) throw new HttpError(400, "catalog_images_invalid");
  const tags = readArray(entry.tags ?? [], "tags").map(value => {
    if (typeof value !== "string" || value.length === 0 || value.length > 64) throw new HttpError(400, "catalog_tags_invalid");
    return value;
  });
  if (tags.length > 32) throw new HttpError(400, "catalog_tags_invalid");
  return {
    id: readBoundedString(entry, "id", 256),
    title: readBoundedString(entry, "title", 256),
    description: readOptionalBoundedString(entry, "description", 1_000),
    section,
    mapSid: readBoundedString(entry, "mapSid", 256),
    mapUrl: readOptionalMapUrl(entry),
    discordUrl: readOptionalDiscordUrl(entry),
    downloadUrl: readBoundedString(entry, "downloadUrl", 2048),
    authorName: readBoundedString(entry, "authorName", 256),
    authorAvatarUrl: readOptionalBoundedString(entry, "authorAvatarUrl", 2048),
    imageUrl: readOptionalBoundedString(entry, "imageUrl", 2048) || undefined,
    images,
    downloadCount: Math.max(0, Math.trunc(readOptionalNumber(entry, "downloadCount"))),
    updatedUtc: readBoundedString(entry, "updatedUtc", 64),
    tags,
    sha256,
    sizeBytes
  };
}

function readDiscordUserId(source: Record<string, unknown>): string {
  const value = readRequiredString(source, "discordUserId");
  if (!/^\d{15,25}$/.test(value)) {
    throw new HttpError(400, "discord_user_id_invalid");
  }
  return value;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = readContentLength(request);
  if (declaredLength !== undefined && declaredLength > publicJsonMaxBytes) {
    throw new HttpError(413, "json_body_too_large");
  }
  try {
    return parseJsonObject(await readBoundedRequestText(request, publicJsonMaxBytes));
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      throw new HttpError(413, "json_body_too_large");
    }
    throw error;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return readObject(parsed, "body");
  } catch {
    throw new HttpError(400, "json_invalid");
  }
}

function readObject(source: unknown, name: string): Record<string, unknown> {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new HttpError(400, `${name}_invalid`);
  }
  return source as Record<string, unknown>;
}

function readArray(source: unknown, name: string): unknown[] {
  if (!Array.isArray(source)) {
    throw new HttpError(400, `${name}_invalid`);
  }
  return source;
}

function readRequiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${key}_required`);
  }
  return value.trim();
}

function readOptionalString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalBoundedString(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = readOptionalString(source, key);
  if (value.length > maxLength) {
    throw new HttpError(400, `${key}_too_long`);
  }
  return value;
}

function readBoundedString(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = readRequiredString(source, key);
  if (value.length > maxLength) {
    throw new HttpError(400, `${key}_too_long`);
  }
  return value;
}

function readOptionalMapUrl(source: Record<string, unknown>): string {
  const value = readOptionalString(source, "mapUrl");
  if (!value) {
    return "";
  }
  if (value.length > maxMapUrlLength) {
    throw new HttpError(400, "mapUrl_too_long");
  }

  const normalized = normalizeMapUrl(value);
  if (!isSupportedMapUrl(normalized)) {
    throw new HttpError(400, "mapUrl_unsupported");
  }
  return normalized;
}

export function isCatalogDiscordUrl(value: unknown): boolean {
  if (value === undefined || value === "") {
    return true;
  }
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "discord.com" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/channels\/[0-9]{1,20}\/[0-9]{1,20}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function readOptionalDiscordUrl(source: Record<string, unknown>): string {
  const value = readOptionalBoundedString(source, "discordUrl", 2048);
  if (!isCatalogDiscordUrl(value)) {
    throw new HttpError(400, "catalog_discord_url_invalid");
  }
  return value;
}

function readRequiredNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${key}_required`);
  }
  return value;
}

function readOptionalNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readContentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeContentType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

function hashInstallId(installId: string): string {
  return createHash("sha256").update(`install:${installId}`).digest("hex");
}

function readTrustedNetworkKey(request: Request): string {
  const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  const ipVersion = isIP(value);
  if (!ipVersion || value.length > 64) {
    throw new HttpError(403, "network_identity_required");
  }
  return ipVersion === 6 ? ipv6NetworkPrefix(value) : value;
}

function ipv6NetworkPrefix(address: string): string {
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail && isIP(ipv4Tail) === 4) {
    const octets = ipv4Tail.split(".").map(Number);
    const ipv4Hextets = [
      ((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16),
      ((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16)
    ];
    normalized = normalized.slice(0, -ipv4Tail.length) + ipv4Hextets.join(":");
  }
  const [leftText, rightText = ""] = normalized.split("::", 2);
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const zeroCount = Math.max(0, 8 - left.length - right.length);
  const hextets = [...left, ...Array.from({ length: zeroCount }, () => "0"), ...right]
    .map(part => Number.parseInt(part || "0", 16).toString(16));
  return hextets.slice(0, 4).join(":") + "::/64";
}

function hashNetworkKey(networkKey: string, secret: string): string {
  // IP addresses have low entropy and a plain digest is reversible by brute
  // force. Key the digest so the quota table does not become an IP inventory.
  return createHmac("sha256", secret).update(`network:${networkKey}`).digest("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(`upload-token:${token}`).digest("hex");
}

function signedSourceObjectUrl(origin: string, objectId: string, secret: string, now: Date): string {
  const expires = String(now.getTime() + sourceObjectSignatureTtlMs);
  const signature = signSourceObject(secret, objectId, expires);
  return `${origin.replace(/\/+$/, "")}/uploads/source/${encodeURIComponent(objectId)}?expires=${encodeURIComponent(expires)}&signature=${encodeURIComponent(signature)}`;
}

function signSourceObject(secret: string, objectId: string, expires: string): string {
  return createHmac("sha256", secret)
    .update(["source-object", objectId, expires].join("\n"))
    .digest("hex");
}

function signedCatalogCaptureSourceUrl(origin: string, sourceUrl: string, secret: string, now: Date): string {
  const expires = String(now.getTime() + sourceObjectSignatureTtlMs);
  const signature = signCatalogCaptureSource(secret, sourceUrl, expires);
  const query = new URLSearchParams({ sourceUrl, expires, signature });
  return `${origin.replace(/\/+$/, "")}/bot/catalog/captures/source?${query.toString()}`;
}

function signCatalogCaptureSource(secret: string, sourceUrl: string, expires: string): string {
  return createHmac("sha256", secret)
    .update(["catalog-capture-source", sourceUrl, expires].join("\n"))
    .digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) {
    return "";
  }
  return (await bufferFromBody(request.body, maxBytes)).toString("utf8");
}

export function shouldDeleteQuarantineBatch(batch: UploadBatchRecord, now: Date): boolean {
  const expiresAt = Date.parse(batch.expiresUtc);
  if (batch.status === "prepared" && Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
    return true;
  }

  if (batch.status === "awaiting_attribution" && Number.isFinite(expiresAt) && expiresAt <= now.getTime() &&
      batch.submissions.every(submission => !["queued", "reviewing", "moderating"].includes(submission.status))) {
    return true;
  }

  const activeModeration = batch.submissions.filter(submission =>
    ["queued", "reviewing", "moderating"].includes(submission.status)
  );
  if (activeModeration.length > 0) {
    return activeModeration.every(submission => isAbandonedModerationSubmission(submission, batch, now));
  }

  const terminalRetentionMs = batch.status === "published" ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  if (!["published", "rejected", "changes_requested", "withdrawn", "deleted"].includes(batch.status)) {
    return false;
  }
  const updatedAt = Date.parse(batch.updatedUtc);
  return Number.isFinite(updatedAt) && updatedAt <= now.getTime() - terminalRetentionMs;
}

function isAbandonedModerationSubmission(
  submission: UploadSubmissionRecord,
  batch: UploadBatchRecord,
  now: Date
): boolean {
  if (!["queued", "reviewing", "moderating"].includes(submission.status)) return false;
  const queuedAt = Date.parse(submission.queuedUtc ?? batch.createdUtc);
  return Number.isFinite(queuedAt) && queuedAt <= now.getTime() - abandonedReviewRetentionMs;
}

async function bufferFromBody(body: Buffer | ReadableStream<Uint8Array>, maxBytes?: number): Promise<Buffer> {
  if (Buffer.isBuffer(body)) {
    if (maxBytes !== undefined && body.length > maxBytes) {
      throw new UploadTooLargeError(maxBytes);
    }
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const chunk = Buffer.from(next.value);
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new UploadTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function capUploadBodyStream(
  body: Buffer | ReadableStream<Uint8Array>,
  maxBytes: number
): { body: Buffer | ReadableStream<Uint8Array>; uploadedBytes: Promise<number> } {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) {
      throw new UploadTooLargeError(maxBytes);
    }
    return { body, uploadedBytes: Promise.resolve(body.length) };
  }

  let totalBytes = 0;
  let resolveUploadedBytes: (value: number) => void = () => {};
  let rejectUploadedBytes: (error: unknown) => void = () => {};
  const uploadedBytes = new Promise<number>((resolve, reject) => {
    resolveUploadedBytes = resolve;
    rejectUploadedBytes = reject;
  });

  const cappedBody = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        const error = new UploadTooLargeError(maxBytes);
        rejectUploadedBytes(error);
        throw error;
      }
      controller.enqueue(chunk);
    },
    flush() {
      resolveUploadedBytes(totalBytes);
    }
  }));

  return { body: cappedBody, uploadedBytes };
}

function responseBody(body: Buffer | ReadableStream<Uint8Array>): BodyInit {
  if (!Buffer.isBuffer(body)) {
    return body;
  }
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonContentType });
}

function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => clone(item)) as T;
  }
  if (value && typeof value === "object") {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = clone(item);
    }
    return cloned as T;
  }
  return value;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export class UploadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("Upload body exceeds the object size limit.");
  }
}
