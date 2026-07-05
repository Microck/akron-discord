import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { signBotRequest } from "../upload-worker.js";

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
};

export type UploadWorkerClient = {
  claimJobs(limit?: number): Promise<UploadWorkerJob[]>;
  requeueJobs(submissionIds: string[]): Promise<void>;
  acknowledgeDelivered(submissionIds: string[]): Promise<void>;
  approve(submissionId: string): Promise<void>;
  reject(submissionId: string, reason: string): Promise<void>;
  requestChanges(submissionId: string, reason: string): Promise<void>;
  confirmAttribution(submissionId: string, discordUserId: string): Promise<void>;
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
    async approve(submissionId: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/approve`, {});
    },
    async reject(submissionId: string, reason: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/reject`, { reason });
    },
    async requestChanges(submissionId: string, reason: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/moderation/${submissionId}/request-changes`, { reason });
    },
    async confirmAttribution(submissionId: string, discordUserId: string): Promise<void> {
      await signedJson(fetchImpl, baseUrl, secret, `/bot/attribution/${submissionId}/confirm`, { discordUserId });
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
