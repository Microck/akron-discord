import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import {
  signBotRequest,
  type CatalogPublication,
  type DeletedUploadSubmission,
  type UploadAiReview,
  type UploadDiscordMessages
} from "../upload-worker.js";

export type UploadWorkerJob = {
  batchId: string;
  submissionId: string;
  section: string;
  mapSid: string;
  title: string;
  description: string;
  attribution: {
    mode: string;
    label: string;
    confirmed?: boolean;
    discordUserId?: string;
  };
  status: string;
  validationReasons: string[];
  archiveFacts: Record<string, unknown>;
  aiReview?: UploadAiReview;
  captures: UploadWorkerCapture[];
};

export type UploadWorkerCapture = {
  objectId: string;
  roomName: string;
  sourceUrl: string;
  optimized: boolean;
};

export type UploadWorkerStatusSubmission = {
  submissionId: string;
  section: string;
  mapSid: string;
  title: string;
  description: string;
  attribution: {
    mode: string;
    label: string;
    confirmed?: boolean;
    discordUserId?: string;
  };
  status: string;
  validationReasons: string[];
  publication?: CatalogPublication;
  captures?: UploadWorkerCapture[];
};

export type UploadWorkerStatusBody = {
  batchId: string;
  status: string;
  expiresUtc: string;
  submissions: UploadWorkerStatusSubmission[];
};

export type UploadWorkerSubmissionContext = UploadWorkerJob & {
  batchId: string;
  publication?: CatalogPublication;
};

export type UploadWorkerDiscordMessageInput = {
  submissionId: string;
  kind: keyof UploadDiscordMessages;
  guildId: string;
  channelId: string;
  messageId: string;
  threadId?: string;
};

export type UploadWorkerClient = {
  claimJobs(limit?: number): Promise<UploadWorkerJob[]>;
  requeueJobs(submissionIds: string[]): Promise<void>;
  acknowledgeDelivered(submissionIds: string[]): Promise<void>;
  getSubmissionContext(submissionId: string): Promise<UploadWorkerSubmissionContext>;
  recordAiReview(submissionId: string, review: Omit<UploadAiReview, "reviewedUtc">): Promise<void>;
  putOptimizedCapture(submissionId: string, objectId: string, capture: { bytes: Buffer; contentType: "image/webp" }): Promise<void>;
  approve(submissionId: string): Promise<UploadWorkerStatusBody>;
  reject(submissionId: string, reason: string): Promise<void>;
  requestChanges(submissionId: string, reason: string): Promise<void>;
  confirmAttribution(submissionId: string, discordUserId: string): Promise<void>;
  recordDiscordMessage(input: UploadWorkerDiscordMessageInput): Promise<void>;
  deleteSubmission(submissionId: string, reason?: string): Promise<DeletedUploadSubmission>;
  deleteSubmissionByDiscordThread(threadId: string, reason?: string): Promise<DeletedUploadSubmission>;
};

export function hasUploadWorkerConfig(config: AppConfig): boolean {
  return Boolean(config.uploadWorkerUrl && config.uploadWorkerBotSecret);
}

export function createUploadWorkerClient(config: AppConfig, fetchImpl: typeof fetch = fetch): UploadWorkerClient {
  const baseUrl = normalizeBaseUrl(config.uploadWorkerUrl);
  const secret = config.uploadWorkerBotSecret;
  if (!baseUrl || !secret) {
    throw new Error("Upload Worker URL and bot secret are required.");
  }

  return {
    async claimJobs(limit = 10): Promise<UploadWorkerJob[]> {
      const response = await signedJson(fetchImpl, baseUrl, secret, "/bot/jobs/claim", { limit });
      const body = await readJson(response) as { jobs?: UploadWorkerJob[] };
      return Array.isArray(body.jobs) ? body.jobs : [];
    },
    async requeueJobs(submissionIds: string[]): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, "/bot/jobs/requeue", { submissionIds });
    },
    async acknowledgeDelivered(submissionIds: string[]): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, "/bot/jobs/delivered", { submissionIds });
    },
    async getSubmissionContext(submissionId: string): Promise<UploadWorkerSubmissionContext> {
      const response = await signedJson(fetchImpl, baseUrl, secret, `/bot/submissions/${submissionId}/context`, {});
      return await readJson(response) as UploadWorkerSubmissionContext;
    },
    async recordAiReview(submissionId: string, review: Omit<UploadAiReview, "reviewedUtc">): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/reviews/${submissionId}`, review);
    },
    async putOptimizedCapture(submissionId: string, objectId: string, capture: { bytes: Buffer; contentType: "image/webp" }): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/optimized-captures/${submissionId}/${objectId}`, {
        contentType: capture.contentType,
        bytesBase64: capture.bytes.toString("base64")
      });
    },
    async approve(submissionId: string): Promise<UploadWorkerStatusBody> {
      const response = await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/approve`, {});
      return await readJson(response) as UploadWorkerStatusBody;
    },
    async reject(submissionId: string, reason: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/reject`, { reason });
    },
    async requestChanges(submissionId: string, reason: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/request-changes`, { reason });
    },
    async confirmAttribution(submissionId: string, discordUserId: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/attribution/${submissionId}/confirm`, { discordUserId });
    },
    async recordDiscordMessage(input: UploadWorkerDiscordMessageInput): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/discord-messages/${input.submissionId}`, {
        kind: input.kind,
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        threadId: input.threadId
      });
    },
    async deleteSubmission(submissionId: string, reason?: string): Promise<DeletedUploadSubmission> {
      const response = await signedJson(fetchImpl, baseUrl, secret, `/bot/submissions/${submissionId}/delete`, { reason: reason ?? "" });
      const body = await readJson(response) as { deleted?: DeletedUploadSubmission };
      if (!body.deleted) {
        throw new Error("Upload Worker delete response did not include deletion metadata.");
      }
      return body.deleted;
    },
    async deleteSubmissionByDiscordThread(threadId: string, reason?: string): Promise<DeletedUploadSubmission> {
      const response = await signedJson(fetchImpl, baseUrl, secret, `/bot/submissions/by-discord-thread/${encodeURIComponent(threadId)}/delete`, { reason: reason ?? "" });
      const body = await readJson(response) as { deleted?: DeletedUploadSubmission };
      if (!body.deleted) {
        throw new Error("Upload Worker delete response did not include deletion metadata.");
      }
      return body.deleted;
    }
  };
}

async function signedJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  secret: string,
  path: string,
  body: unknown
): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const signature = signBotRequest({
    secret,
    method: "POST",
    path,
    timestamp,
    nonce,
    bodyText
  });
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-akron-timestamp": timestamp,
      "x-akron-nonce": nonce,
      "x-akron-signature": signature
    },
    body: bodyText
  });

  if (!response.ok) {
    throw new Error(`Upload Worker request failed with HTTP ${response.status}.`);
  }
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") + "/" : "";
}
