import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { validateAkrArchive } from "./submissions/archive.js";
import { isSupportedMapUrl, normalizeMapUrl } from "./submissions/post-parser.js";
import { sectionTag } from "./submissions/sections.js";
import { akrMaxBytes, catalogImageMaxBytes, imageSourceMaxBytes, type AkronProfileSection } from "./submissions/types.js";

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
  imageKey: string;
  downloadUrl: string;
  imageUrl: string;
  publishedUtc: string;
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

export type UploadOptimizedCapture = {
  contentType: "image/webp";
  uploadedBytes: number;
  extension: "webp";
  r2Key?: string;
  bytes?: Buffer;
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
  captureObjectId: string;
  attribution: UploadAttribution;
  status: UploadStatus;
  validationReasons: string[];
  archiveFacts?: Record<string, unknown>;
  aiReview?: UploadAiReview;
  optimizedCapture?: UploadOptimizedCapture;
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
  tryBeginCompletion(batch: UploadBatchRecord): Promise<boolean>;
  tryReserveModerationAction(batch: UploadBatchRecord, submissionId: string, now: Date): Promise<boolean>;
  claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>>;
  putBatch(batch: UploadBatchRecord): Promise<void>;
  putObject(record: UploadObjectRecord): Promise<void>;
  getObject(id: string, options?: { includeBytes?: boolean }): Promise<UploadObjectRecord | undefined>;
  getUploadedObjectBody(id: string): Promise<UploadedObjectBody | undefined>;
  putUploadedObject(id: string, upload: PendingUploadedObjectBody): Promise<UploadedObjectWriteResult>;
  publishCatalogEntry(input: PublishCatalogEntryInput): Promise<CatalogPublication>;
  recordAiReview(input: RecordAiReviewInput): Promise<UploadSubmissionRecord | undefined>;
  putOptimizedCapture(input: PutOptimizedCaptureInput): Promise<UploadSubmissionRecord | undefined>;
  recordDiscordMessage(input: RecordDiscordMessageInput): Promise<UploadSubmissionRecord | undefined>;
  deleteSubmission(input: DeleteSubmissionInput): Promise<DeletedUploadSubmission | undefined>;
  rememberBotNonce(nonce: string, expiresUtc: string): Promise<boolean>;
};

export type PublishCatalogEntryInput = {
  submission: UploadSubmissionRecord;
  pack: UploadObjectRecord;
  capture?: UploadObjectRecord;
  now: Date;
  captureSourceUrl?: string;
};

export type RecordAiReviewInput = {
  submissionId: string;
  review: Omit<UploadAiReview, "reviewedUtc">;
  now: Date;
};

export type PutOptimizedCaptureInput = {
  submissionId: string;
  bytes: Buffer;
  contentType: "image/webp";
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
  now?: () => Date;
  id?: () => string;
};

export type PreparedObject = {
  objectId: string;
  uploadUrl: string;
  maxBytes: number;
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
const maxSubmissionsPerBatch = 8;
const botSignatureWindowMs = 5 * 60 * 1000;
const jsonContentType = { "content-type": "application/json; charset=utf-8" };
const allowedCaptureContentTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

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
              titleMaxLength: maxTitleLength,
              descriptionMaxLength: maxDescriptionLength,
              mapSidMaxLength: maxMapSidLength,
              submissionsMaxCount: maxSubmissionsPerBatch
            },
            serverTimeUtc: now().toISOString()
          });
        }

        if (request.method === "POST" && url.pathname === "/uploads/prepare") {
          return await prepareUpload({ request, origin: uploadOrigin, store: options.store, now, id, termsVersion });
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

        const optimizedCaptureMatch = url.pathname.match(/^\/bot\/optimized-captures\/([^/]+)$/);
        if (request.method === "POST" && optimizedCaptureMatch) {
          const body = await readSignedJson(request, options.botSecret, now, options.store);
          if (body instanceof Response) {
            return body;
          }
          return await putOptimizedCapture({
            submissionId: optimizedCaptureMatch[1] ?? "",
            body,
            store: options.store,
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
            botSecret: options.botSecret
          });
        }

        return json({ error: "not_found" }, 404);
      } catch (error) {
        if (error instanceof HttpError) {
          return json({ error: error.code }, error.status);
        }
        const message = error instanceof Error ? error.message : "Unexpected upload worker error.";
        return json({ error: "internal_error", message }, 500);
      }
    }
  };
}

export class InMemoryUploadStore implements UploadWorkerStore {
  private readonly batches = new Map<string, UploadBatchRecord>();
  private readonly objects = new Map<string, UploadObjectRecord>();
  private readonly botNonces = new Map<string, string>();
  private readonly publicObjects = new Map<string, { bytes: Buffer; contentType: string }>();
  private catalogIndex: CatalogIndex = emptyCatalogIndex();

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
    current.updatedUtc = nowIso;
    current.status = deriveBatchStatus(current);
    this.batches.set(current.id, clone(current));
    return true;
  }

  async claimModerationJobs(limit: number, now: Date): Promise<Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }>> {
    const jobs: Array<{ batch: UploadBatchRecord; submission: UploadSubmissionRecord }> = [];
    const nowIso = now.toISOString();
    for (const [batchId, batch] of this.batches.entries()) {
      for (const submission of batch.submissions) {
        if (isClaimableModerationStatus(submission, now)) {
          submission.status = "reviewing";
          submission.reviewClaimedUtc = nowIso;
          delete submission.moderationDeliveredUtc;
          batch.updatedUtc = nowIso;
          batch.status = deriveBatchStatus(batch);
          this.batches.set(batchId, clone(batch));
          const claimedBatch = clone(batch);
          const claimedSubmission = claimedBatch.submissions.find(candidate => candidate.id === submission.id);
          if (claimedSubmission) {
            jobs.push({ batch: claimedBatch, submission: claimedSubmission });
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
    const uploadedCapture = input.capture ? await this.getUploadedObjectBody(input.capture.id) : undefined;
    if (!packBytes || (input.capture && !uploadedCapture)) {
      throw new Error("Cannot publish missing upload objects.");
    }

    const optimizedCapture = input.submission.optimizedCapture?.bytes ? input.submission.optimizedCapture : undefined;
    const publicCaptureBytes = optimizedCapture?.bytes ?? (uploadedCapture ? Buffer.from(await bufferFromBody(uploadedCapture.body)) : undefined);
    const publicCapture: UploadObjectRecord | undefined = publicCaptureBytes
      ? {
          ...(input.capture ?? {
            id: `${input.submission.id}-optimized-capture`,
            tokenHash: "",
            kind: "capture" as const,
            batchId: input.submission.batchId,
            maxBytes: catalogImageMaxBytes,
            contentType: "image/webp"
          }),
          bytes: publicCaptureBytes,
          uploadedBytes: publicCaptureBytes.length,
          contentType: optimizedCapture?.contentType ?? "image/webp"
        }
      : undefined;
    const publication = buildPublication(input.submission, publicCapture, input.now, "https://akron.example.test");
    this.publicObjects.set(publication.packKey, {
      bytes: Buffer.from(packBytes),
      contentType: "application/octet-stream"
    });
    if (publication.imageKey && publicCaptureBytes && publicCapture) {
      this.publicObjects.set(publication.imageKey, {
        bytes: publicCaptureBytes,
        contentType: publicCapture.contentType
      });
    }
    this.catalogIndex = mergeCatalogIndex(this.catalogIndex, buildCatalogPack(input.submission, publication, input.now));
    return publication;
  }

  async recordAiReview(input: RecordAiReviewInput): Promise<UploadSubmissionRecord | undefined> {
    for (const [batchId, batch] of this.batches.entries()) {
      const submission = batch.submissions.find(candidate => candidate.id === input.submissionId);
      if (!submission) {
        continue;
      }
      submission.aiReview = { ...input.review, reviewedUtc: input.now.toISOString() };
      batch.updatedUtc = input.now.toISOString();
      this.batches.set(batchId, clone(batch));
      return clone(submission);
    }
    return undefined;
  }

  async putOptimizedCapture(input: PutOptimizedCaptureInput): Promise<UploadSubmissionRecord | undefined> {
    for (const [batchId, batch] of this.batches.entries()) {
      const submission = batch.submissions.find(candidate => candidate.id === input.submissionId);
      if (!submission) {
        continue;
      }
      submission.optimizedCapture = {
        bytes: Buffer.from(input.bytes),
        contentType: input.contentType,
        uploadedBytes: input.bytes.length,
        extension: "webp"
      };
      if (submission.publication) {
        const captureRecord = optimizedCaptureRecordForSubmission(submission);
        if (captureRecord.bytes) {
          const publication = buildPublication(submission, captureRecord, input.now, "https://akron.example.test");
          submission.publication = {
            ...submission.publication,
            imageKey: publication.imageKey,
            imageUrl: publication.imageUrl
          };
          this.publicObjects.set(publication.imageKey, {
            bytes: Buffer.from(captureRecord.bytes),
            contentType: captureRecord.contentType
          });
          this.catalogIndex = mergeCatalogIndex(this.catalogIndex, buildCatalogPack(submission, submission.publication, input.now));
        }
      }
      batch.updatedUtc = input.now.toISOString();
      this.batches.set(batchId, clone(batch));
      return clone(submission);
    }
    return undefined;
  }

  async recordDiscordMessage(input: RecordDiscordMessageInput): Promise<UploadSubmissionRecord | undefined> {
    for (const [batchId, batch] of this.batches.entries()) {
      const submission = batch.submissions.find(candidate => candidate.id === input.submissionId);
      if (!submission) {
        continue;
      }
      submission.discord = {
        ...submission.discord,
        [input.kind]: {
          ...input.message,
          postedUtc: input.now.toISOString()
        }
      };
      batch.updatedUtc = input.now.toISOString();
      this.batches.set(batchId, clone(batch));
      return clone(submission);
    }
    return undefined;
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
      if (publication?.imageKey) {
        this.publicObjects.delete(publication.imageKey);
      }
      if (publication?.packId) {
        this.catalogIndex = {
          ...this.catalogIndex,
          packs: this.catalogIndex.packs.filter(pack => pack.id !== publication.packId)
        };
      }

      this.objects.delete(submission.packObjectId);
      if (submission.captureObjectId && !batch.submissions.some(candidate =>
        candidate.id !== submission.id &&
        candidate.status !== "deleted" &&
        candidate.captureObjectId === submission.captureObjectId
      )) {
        this.objects.delete(submission.captureObjectId);
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
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  const installId = readRequiredString(body, "installId");
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
  const createdUtc = input.now().toISOString();
  const expiresUtc = new Date(input.now().getTime() + preparedUploadTtlMs).toISOString();
  const capture = body.capture === undefined || body.capture === null ? undefined : readObject(body.capture, "capture");
  let captureToken = "";
  let captureObject: UploadObjectRecord | undefined;
  if (capture) {
    const captureSizeBytes = readRequiredNumber(capture, "sizeBytes");
    const captureContentType = normalizeContentType(readRequiredString(capture, "contentType"));
    if (captureSizeBytes <= 0 || captureSizeBytes > imageSourceMaxBytes) {
      return json({ error: "capture_too_large", maxBytes: imageSourceMaxBytes }, 413);
    }
    if (!allowedCaptureContentTypes.has(captureContentType)) {
      return json({ error: "capture_type_unsupported" }, 415);
    }

    captureToken = input.id();
    captureObject = createObjectRecord({
      id: input.id(),
      token: captureToken,
      kind: "capture",
      batchId,
      maxBytes: imageSourceMaxBytes,
      contentType: captureContentType
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
    if (packSizeBytes <= 0 || packSizeBytes > akrMaxBytes) {
      return json({ error: "pack_too_large", maxBytes: akrMaxBytes }, 413);
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
      maxBytes: akrMaxBytes,
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
      captureObjectId: captureObject?.id ?? "",
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

  await input.store.putBatch({
    id: batchId,
    installIdHash: hashInstallId(installId),
    termsVersion,
    status: "prepared",
    createdUtc,
    updatedUtc: createdUtc,
    expiresUtc,
    submissions: preparedSubmissions
  });
  if (captureObject) {
    await input.store.putObject(captureObject);
  }
  for (const packObject of packObjects) {
    await input.store.putObject(packObject);
  }

  const responseBody: Record<string, unknown> = {
    batchId,
    expiresUtc,
    submissions: responseSubmissions
  };
  if (captureObject) {
    responseBody.capture = {
      objectId: captureObject.id,
      uploadUrl: `${input.origin}/uploads/objects/${captureObject.id}?token=${captureToken}`,
      maxBytes: captureObject.maxBytes
    };
  }
  return json(responseBody, 201);
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
    const capture = submission.captureObjectId
      ? await input.store.getObject(submission.captureObjectId, { includeBytes: false })
      : undefined;
    if (!isUploadedObjectReady(pack) || (submission.captureObjectId && !isUploadedObjectReady(capture))) {
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
      const capture = submission.captureObjectId
        ? await input.store.getObject(submission.captureObjectId, { includeBytes: false })
        : undefined;
      if (!pack?.bytes || (submission.captureObjectId && !isUploadedObjectReady(capture))) {
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
    }

    batch.status = batch.submissions.every(submission => submission.status === "rejected")
      ? "rejected"
      : hasPendingAttribution
        ? "awaiting_attribution"
        : "queued";
    batch.updatedUtc = input.now().toISOString();
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
  found.submission.status = input.nextStatus;
  const savedBatch = await saveSubmissionUpdate({
    store: input.store,
    batch: found.batch,
    submission: found.submission,
    now: input.now
  });
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
  const shouldQueueForModeration = found.submission.attribution.mode === "discord" &&
    !found.submission.attribution.confirmed &&
    (found.submission.status === "awaiting_attribution" || found.submission.status === "reviewing");
  found.submission.attribution = { mode: "anonymous" };
  if (shouldQueueForModeration) {
    found.submission.status = "queued";
    delete found.submission.reviewClaimedUtc;
    delete found.submission.moderationDeliveredUtc;
  }
  const savedBatch = await saveSubmissionUpdate({
    store: input.store,
    batch: found.batch,
    submission: found.submission,
    now: input.now
  });
  return json(publicBatchStatus(savedBatch));
}

async function saveSubmissionUpdate(input: {
  store: UploadWorkerStore;
  batch: UploadBatchRecord;
  submission: UploadSubmissionRecord;
  now: () => Date;
}): Promise<UploadBatchRecord> {
  const current = await input.store.getBatch(input.batch.id) ?? input.batch;
  const submissionIndex = current.submissions.findIndex(candidate => candidate.id === input.submission.id);
  if (submissionIndex >= 0) {
    // Moderation operates on a snapshot from findSubmission. Reload before writing
    // so concurrent moderation of sibling submissions does not revert their state.
    current.submissions[submissionIndex] = clone(input.submission);
  }
  current.updatedUtc = input.now().toISOString();
  current.status = deriveBatchStatus(current);
  await input.store.putBatch(current);
  return current;
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
  found.submission.attribution = { ...found.submission.attribution, confirmed: true };
  if (found.submission.status === "awaiting_attribution" || found.submission.status === "reviewing") {
    found.submission.status = "queued";
    delete found.submission.reviewClaimedUtc;
    delete found.submission.moderationDeliveredUtc;
  }
  const savedBatch = await saveSubmissionUpdate({
    store: input.store,
    batch: found.batch,
    submission: found.submission,
    now: input.now
  });
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
}): Promise<Response> {
  let found = await findSubmission(input.store, input.submissionId);
  if (!found) {
    return json({ error: "submission_not_found" }, 404);
  }
  if (input.action === "approve" && found.submission.status === "published") {
    return json(publicBatchStatus(found.batch));
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
      const capture = found.submission.captureObjectId
        ? await input.store.getObject(found.submission.captureObjectId, { includeBytes: false })
        : undefined;
      if (!pack?.bytes || (found.submission.captureObjectId && !isUploadedObjectReady(capture))) {
        found.submission.status = "reviewing";
        await saveSubmissionUpdate({
          store: input.store,
          batch: found.batch,
          submission: found.submission,
          now: input.now
        });
        return json({ error: "upload_objects_missing", submissionId: found.submission.id }, 409);
      }
      const captureSourceUrl = capture
        ? signedSourceObjectUrl(input.origin, capture.id, input.botSecret, input.now())
        : undefined;
      found.submission.publication = await input.store.publishCatalogEntry({
        submission: found.submission,
        pack,
        capture,
        now: input.now(),
        captureSourceUrl
      });
      found.submission.status = "published";
    } catch (error) {
      found.submission.status = "reviewing";
      await saveSubmissionUpdate({
        store: input.store,
        batch: found.batch,
        submission: found.submission,
        now: input.now
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

  const savedBatch = await saveSubmissionUpdate({
    store: input.store,
    batch: found.batch,
    submission: found.submission,
    now: input.now
  });
  return json(publicBatchStatus(savedBatch));
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
    const found = await findSubmission(input.store, submissionId);
    if (!found || found.submission.status !== "reviewing") {
      continue;
    }
    found.submission.moderationDeliveredUtc = input.now().toISOString();
    found.batch.updatedUtc = input.now().toISOString();
    await input.store.putBatch(found.batch);
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
      captureSourceUrl: job.submission.captureObjectId
        ? signedSourceObjectUrl(input.origin, job.submission.captureObjectId, input.botSecret, input.now())
        : "",
      hasOptimizedCapture: Boolean(job.submission.optimizedCapture)
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
    captureSourceUrl: found.submission.captureObjectId
      ? signedSourceObjectUrl(input.origin, found.submission.captureObjectId, input.botSecret, input.now())
      : "",
    hasOptimizedCapture: Boolean(found.submission.optimizedCapture)
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

async function putOptimizedCapture(input: {
  submissionId: string;
  body: Record<string, unknown>;
  store: UploadWorkerStore;
  now: () => Date;
}): Promise<Response> {
  const contentType = normalizeContentType(readRequiredString(input.body, "contentType"));
  if (contentType !== "image/webp") {
    return json({ error: "optimized_capture_type_unsupported" }, 415);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(readRequiredString(input.body, "bytesBase64"), "base64");
  } catch {
    return json({ error: "optimized_capture_invalid" }, 400);
  }
  if (bytes.length <= 0 || bytes.length > catalogImageMaxBytes) {
    return json({ error: "optimized_capture_too_large", maxBytes: catalogImageMaxBytes }, 413);
  }

  const saved = await input.store.putOptimizedCapture({
    submissionId: input.submissionId,
    bytes,
    contentType,
    now: input.now()
  });
  if (!saved) {
    return json({ error: "submission_not_found" }, 404);
  }
  return json({
    ok: true,
    submissionId: saved.id,
    optimizedCapture: {
      contentType: saved.optimizedCapture?.contentType,
      uploadedBytes: saved.optimizedCapture?.uploadedBytes,
      extension: saved.optimizedCapture?.extension
    }
  });
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
    const found = await findSubmission(input.store, submissionId);
    if (!found || found.submission.status !== "reviewing") {
      continue;
    }
    found.submission.status = found.submission.attribution.mode === "discord" && !found.submission.attribution.confirmed
      ? "awaiting_attribution"
      : "queued";
    found.batch.updatedUtc = input.now().toISOString();
    found.batch.status = deriveBatchStatus(found.batch);
    await input.store.putBatch(found.batch);
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

async function readSignedJson(
  request: Request,
  secret: string,
  now: () => Date,
  store: UploadWorkerStore
): Promise<Record<string, unknown> | Response> {
  const bodyText = await request.text();
  const timestamp = request.headers.get("x-akron-timestamp") ?? "";
  const nonce = request.headers.get("x-akron-nonce") ?? "";
  const signature = request.headers.get("x-akron-signature") ?? "";
  const requestTime = Date.parse(timestamp);
  if (!timestamp || !nonce || !signature || !Number.isFinite(requestTime)) {
    return json({ error: "bot_signature_missing" }, 401);
  }
  if (Math.abs(now().getTime() - requestTime) > botSignatureWindowMs) {
    return json({ error: "bot_signature_expired" }, 401);
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

function isClaimableModerationStatus(submission: UploadSubmissionRecord, now: Date): boolean {
  if (submission.status === "queued" || submission.status === "awaiting_attribution") {
    return true;
  }
  if (submission.status !== "reviewing") {
    return false;
  }
  if (submission.moderationDeliveredUtc) {
    return false;
  }

  const claimedAt = Date.parse(submission.reviewClaimedUtc ?? "");
  return !Number.isFinite(claimedAt) || claimedAt <= now.getTime() - moderationClaimLeaseMs;
}

function publicBatchStatus(batch: UploadBatchRecord): Record<string, unknown> {
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
      attribution: publicAttribution(submission.attribution),
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
  section: UploadSection;
  mapSid: string;
  mapUrl: string;
  downloadUrl: string;
  authorName: string;
  authorAvatarUrl: string;
  imageUrl: string;
  downloadCount: number;
  updatedUtc: string;
  tags: string[];
};

export type CatalogIndex = {
  format: "akron-community-pack-index-v1";
  version: 1;
  packs: CatalogPack[];
};

export function buildPublication(
  submission: UploadSubmissionRecord,
  capture: UploadObjectRecord | undefined,
  now: Date,
  publicBaseUrl: string
): CatalogPublication {
  const mapSlug = slugMapSid(submission.mapSid);
  const packId = buildPackId(submission);
  const imageExtension = capture ? imageExtensionForContentType(capture.contentType) : "";
  const packKey = `packs/${mapSlug}/${packId}.akr`;
  const imageKey = capture ? `captures/${mapSlug}/${packId}.${imageExtension}` : "";
  return {
    packId,
    packKey,
    imageKey,
    downloadUrl: publicAssetUrl(publicBaseUrl, packKey),
    imageUrl: imageKey ? publicAssetUrl(publicBaseUrl, imageKey) : "",
    publishedUtc: now.toISOString()
  };
}

export function buildCatalogPack(submission: UploadSubmissionRecord, publication: CatalogPublication, now: Date): CatalogPack {
  const mapSlug = slugMapSid(submission.mapSid);
  return {
    id: publication.packId,
    title: submission.title,
    description: submission.description,
    section: submission.section,
    mapSid: submission.mapSid,
    mapUrl: submission.mapUrl,
    downloadUrl: publication.downloadUrl,
    authorName: authorNameForAttribution(submission.attribution),
    authorAvatarUrl: "",
    imageUrl: publication.imageUrl,
    downloadCount: 0,
    updatedUtc: now.toISOString(),
    tags: [sectionTag(submission.section), mapSlug]
  };
}

function optimizedCaptureRecordForSubmission(submission: UploadSubmissionRecord): UploadObjectRecord {
  return {
    id: `${submission.id}-optimized-capture`,
    tokenHash: "",
    kind: "capture",
    batchId: submission.batchId,
    submissionId: submission.id,
    maxBytes: catalogImageMaxBytes,
    contentType: submission.optimizedCapture?.contentType ?? "image/webp",
    uploadedBytes: submission.optimizedCapture?.uploadedBytes,
    bytes: submission.optimizedCapture?.bytes
  };
}

export function mergeCatalogIndex(index: CatalogIndex, entry: CatalogPack): CatalogIndex {
  const packs = index.packs.filter(pack => pack.id !== entry.id);
  packs.push(entry);
  packs.sort((left, right) => left.title.localeCompare(right.title));
  return { format: "akron-community-pack-index-v1", version: 1, packs };
}

export function emptyCatalogIndex(): CatalogIndex {
  return { format: "akron-community-pack-index-v1", version: 1, packs: [] };
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

function readDiscordUserId(source: Record<string, unknown>): string {
  const value = readRequiredString(source, "discordUserId");
  if (!/^\d{15,25}$/.test(value)) {
    throw new HttpError(400, "discord_user_id_invalid");
  }
  return value;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  return parseJsonObject(await request.text());
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
  if (!value) {
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

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
