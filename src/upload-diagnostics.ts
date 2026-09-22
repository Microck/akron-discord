import { z } from "zod";
import { HttpError, readSignedJson, type UploadWorkerStore } from "./upload-worker.js";
import type { CloudflareUploadEnv } from "./upload-worker-cloudflare.js";

export const diagnosticMaxBytes = 4 * 1024 * 1024;
const diagnosticLogMaxBytes = 1024 * 1024;
const reportIdPattern = /^[a-f0-9]{32}$/;
const metadataSchema = z.record(z.string().min(1).max(64), z.string().max(1024))
  .refine(value => Object.keys(value).length <= 32);
export const diagnosticReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  reportId: z.string().regex(reportIdPattern),
  createdUtc: z.iso.datetime(),
  description: z.string().max(4000),
  context: metadataSchema,
  versions: metadataSchema,
  system: metadataSchema,
  mods: z.array(z.strictObject({ name: z.string().max(256), version: z.string().max(256) })).max(1024),
  logs: z.array(z.strictObject({
    name: z.enum(["log.txt", "akron-current.log", "akron-previous.log", "performance.jsonl"]),
    text: z.string().max(diagnosticLogMaxBytes).refine(text => Buffer.byteLength(text, "utf8") <= diagnosticLogMaxBytes),
    truncated: z.boolean()
  })).max(4).refine(logs => new Set(logs.map(log => log.name)).size === logs.length)
});

export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

export const diagnosticClaimLeaseMs = 5 * 60 * 1000;

export const diagnosticDeliveryJobSchema = z.strictObject({
  reportId: z.string().regex(reportIdPattern),
  claimToken: z.uuid(),
  attempts: z.number().int().positive(),
  firstAttemptUtc: z.iso.datetime()
});
export type DiagnosticDeliveryJob = z.infer<typeof diagnosticDeliveryJobSchema>;

export type DiagnosticDeliveryStore = {
  enqueueDiagnostic(reportId: string, now: Date): Promise<boolean>;
  claimDiagnostic(now: Date): Promise<DiagnosticDeliveryJob | null>;
  renewDiagnostic(reportId: string, claimToken: string, now: Date): Promise<boolean>;
  retryDiagnostic(reportId: string, claimToken: string, now: Date): Promise<boolean>;
  acknowledgeDiagnostic(reportId: string, claimToken: string, messageId: string, now: Date): Promise<boolean>;
};

const claimSchema = z.strictObject({});
const leaseSchema = z.strictObject({ claimToken: z.uuid() });
const deliveredSchema = leaseSchema.extend({ messageId: z.string().regex(/^\d{17,20}$/) });

export async function handleDiagnosticsRequest(request: Request, input: {
  bucket: CloudflareUploadEnv["UPLOAD_QUARANTINE_BUCKET"];
  botSecret: string;
  store: Pick<UploadWorkerStore, "rememberBotNonce"> & DiagnosticDeliveryStore;
}): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  const isSubmission = request.method === "POST" && pathname === "/uploads/diagnostics";
  const retrievalMatch = request.method === "POST" ? pathname.match(/^\/bot\/diagnostics\/([a-f0-9]{32})$/) : null;
  const isClaim = request.method === "POST" && pathname === "/bot/diagnostics/claim";
  const deliveryMatch = request.method === "POST" ? pathname.match(/^\/bot\/diagnostics\/([a-f0-9]{32})\/(renew|retry|delivered)$/) : null;
  if (!isSubmission && !retrievalMatch && !isClaim && !deliveryMatch) return undefined;

  try {
    if (!isSubmission) {
      const signedBody = await readSignedJson(request, input.botSecret, () => new Date(), input.store);
      if (signedBody instanceof Response) {
        signedBody.headers.set("cache-control", "no-store");
        return signedBody;
      }
      const now = new Date();
      if (isClaim) {
        if (!claimSchema.safeParse(signedBody).success) return diagnosticJson({ error: "invalid_diagnostic_claim" }, 400);
        return diagnosticJson({ job: await input.store.claimDiagnostic(now) }, 200);
      }
      if (deliveryMatch) {
        const reportId = deliveryMatch[1];
        const action = deliveryMatch[2];
        const parsed = (action === "delivered" ? deliveredSchema : leaseSchema).safeParse(signedBody);
        if (!parsed.success) return diagnosticJson({ error: "invalid_diagnostic_delivery" }, 400);
        const { claimToken } = parsed.data;
        const updated = action === "renew"
          ? await input.store.renewDiagnostic(reportId, claimToken, now)
          : action === "retry"
            ? await input.store.retryDiagnostic(reportId, claimToken, now)
            : await input.store.acknowledgeDiagnostic(reportId, claimToken, deliveredSchema.parse(signedBody).messageId, now);
        return updated
          ? diagnosticJson({ status: action }, 200)
          : diagnosticJson({ error: "diagnostic_claim_lost" }, 409);
      }
      const stored = await input.bucket.get(`diagnostics/v1/${retrievalMatch![1]}.json`);
      if (!stored) return diagnosticJson({ error: "diagnostic_report_not_found" }, 404);
      return new Response(stored.body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return diagnosticJson({ error: "json_content_type_required" }, 415);
    }
    const bodyText = await readDiagnosticBody(request);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return diagnosticJson({ error: "invalid_json" }, 400);
    }
    const parsed = diagnosticReportSchema.safeParse(body);
    if (!parsed.success) return diagnosticJson({ error: "invalid_diagnostic_report" }, 400);

    // Store only validated fields, in a namespace unrelated to publishable uploads.
    const report = parsed.data;
    const payload = JSON.stringify(report);
    if (Buffer.byteLength(payload, "utf8") > diagnosticMaxBytes) {
      return diagnosticJson({ error: "json_body_too_large" }, 413);
    }
    // R2 evaluates this condition atomically. Never use a get-then-put check here.
    const stored = await input.bucket.put(`diagnostics/v1/${report.reportId}.json`, payload, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    if (stored === null) {
      // A failed D1 write can leave an unaccepted R2 object. Only an identical
      // retry may finish queueing it; report IDs never replace stored content.
      const existing = await input.bucket.get(`diagnostics/v1/${report.reportId}.json`);
      if (!existing || Buffer.from(await existing.arrayBuffer()).toString("utf8") !== payload) {
        return diagnosticJson({ error: "diagnostic_report_exists" }, 409);
      }
    }
    const queued = await input.store.enqueueDiagnostic(report.reportId, new Date());
    if (!queued) return diagnosticJson({ error: "diagnostic_report_exists" }, 409);
    return diagnosticJson({ reportId: report.reportId, status: "received" }, 201);
  } catch (error) {
    if (error instanceof HttpError) return diagnosticJson({ error: error.code }, error.status);
    // An upstream exception can contain request data. Never log diagnostic contents.
    console.error("Diagnostic storage request failed.");
    return diagnosticJson({ error: "internal_error" }, 500);
  }
}

async function readDiagnosticBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) {
    throw new HttpError(400, "invalid_content_length");
  }
  if (declaredLength !== null && Number(declaredLength) > diagnosticMaxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpError(413, "json_body_too_large");
  }
  if (!request.body) throw new HttpError(400, "invalid_json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > diagnosticMaxBytes) throw new HttpError(413, "json_body_too_large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && Number(declaredLength) !== byteLength) {
    throw new HttpError(400, "content_length_mismatch");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, byteLength));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function diagnosticJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
