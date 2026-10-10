import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import type { ErrorEvent, EventHint, NodeOptions } from "@sentry/node";
import { spawnSync } from "node:child_process";
import { privacyOptions, sanitizeErrorEvent, sanitizeSpan, uploadRoute, type ErrorReporter } from "../src/observability/privacy.js";
import { captureNodeError, flushNodeTelemetry, withNodeOperation } from "../src/observability/node.js";
import { createUploadWorker, HttpError, InMemoryUploadStore } from "../src/upload-worker.js";
import { enforceEdgeRateLimit } from "../src/upload-worker-cloudflare.js";
import { handleDiagnosticsRequest, type DiagnosticDeliveryStore } from "../src/upload-diagnostics.js";

const secret = "PRIVATE_REPORT_AND_TOKEN_SENTINEL";

describe("Sentry privacy boundaries", () => {
  it("keeps useful stack coordinates while excluding all raw report, request, breadcrumb and attachment data", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: secret,
      user: { id: secret, ip_address: secret },
      request: { url: `https://private.test/uploads?signature=${secret}`, headers: { authorization: secret }, data: secret },
      breadcrumbs: [{ message: secret, data: { attachment: secret } }],
      extra: { report: secret },
      tags: { service: "akron-discord", operation: "bot.diagnostic_delivery", username: secret },
      contexts: { operation: { reportId: "a".repeat(32), attempt: 3, logs: secret } },
      exception: { values: [{
        type: "Error", value: secret,
        stacktrace: { frames: [{ filename: `/home/${secret}/src/services/diagnostic-delivery.ts?token=${secret}`, function: "deliverDiagnostic", lineno: 42, colno: 7, vars: { log: secret }, context_line: secret }] }
      }] },
      sdkProcessingMetadata: { privatePayload: secret }
    };
    const hint: EventHint = { attachments: [{ filename: "private-report.json", data: secret }] };
    const clean = sanitizeErrorEvent(event, hint);

    expect(JSON.stringify(clean)).not.toContain(secret);
    expect(hint.attachments).toEqual([]);
    expect(clean.contexts?.operation).toEqual({ reportId: "a".repeat(32), attempt: 3 });
    expect(clean.exception?.values?.[0]).toMatchObject({
      value: "bot.diagnostic_delivery failed",
      stacktrace: { frames: [{ filename: "app:///src/services/diagnostic-delivery.ts", function: "deliverDiagnostic", lineno: 42, colno: 7 }] }
    });
    expect(event.exception?.values?.[0].value).toBe(secret);
  });

  it("scrubs streamed spans including URLs, SQL, AI inputs and links", () => {
    const span: Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0] = {
      trace_id: "1".repeat(32), span_id: "2".repeat(16), name: `POST https://${secret}.test/uploads/objects/${secret}?token=${secret}`,
      start_timestamp: 1, end_timestamp: 2, status: "error", is_segment: true,
      attributes: { "http.request.body": secret, "db.query.text": secret, "gen_ai.input.messages": secret, "http.response.status_code": 500 },
      links: [{ trace_id: "3".repeat(32), span_id: "4".repeat(16), attributes: { secret } }]
    };
    const clean = sanitizeSpan(span);
    expect(JSON.stringify(clean)).not.toContain(secret);
    expect(clean.name).toBe("POST /uploads/objects/:objectId");
    expect(clean.attributes).toEqual({ "sentry.op": "dependency", "http.response.status_code": 500 });
    expect(sanitizeSpan({ ...span, name: `SELECT '${secret}'` }).name).toBe("dependency");
  });

  it("normalizes signed routes and drops unknown request paths", () => {
    expect(uploadRoute(`/uploads/status/${secret}?installId=${secret}`)).toBe("/uploads/status/:batchId");
    expect(uploadRoute(`/bot/diagnostics/${"a".repeat(32)}/delivered`)).toBe("/bot/diagnostics/:reportId/delivered");
    expect(uploadRoute(`/bot/catalog/captures/source?sourceUrl=${secret}&signature=${secret}`)).toBe("/bot/catalog/captures/source");
    expect(uploadRoute(`/${secret}`)).toBe("/unknown");
  });
});

describe("Sentry Node capture with an offline transport", () => {
  const envelopes: Array<[unknown, Array<[{ type: string }, unknown]>]> = [];
  beforeAll(() => {
    Sentry.init({
      ...privacyOptions,
      dsn: "https://test@example.invalid/1",
      tracesSampleRate: 1,
      enableRuntimeChannelInjection: false,
      transport: () => ({
        send: envelope => { envelopes.push(envelope as typeof envelopes[number]); return Promise.resolve({ statusCode: 200 }); },
        flush: () => Promise.resolve(true)
      })
    });
  });
  afterAll(async () => { await Sentry.close(1000); });

  it("isolates concurrent jobs, deduplicates a rethrown exception and removes private payloads before sending", async () => {
    const sharedError = Object.assign(new Error(secret), { requestBody: { logs: secret } });
    await Promise.all([
      withNodeOperation("bot.diagnostic_delivery", async () => {
        await Promise.resolve();
        captureNodeError(sharedError);
        captureNodeError(sharedError);
      }, { reportId: "a".repeat(32), attempt: 1 }),
      withNodeOperation("bot.moderation_delivery", async () => {
        captureNodeError(new TypeError(secret));
      }, { submissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })
    ]);
    await flushNodeTelemetry(1000);
    const errors = envelopes.flatMap(envelope => envelope[1]).filter(([header]) => header.type === "event").map(([, event]) => event as ErrorEvent);
    expect(errors).toHaveLength(2);
    const diagnostic = errors.find(event => event.tags?.operation === "bot.diagnostic_delivery");
    const moderation = errors.find(event => event.tags?.operation === "bot.moderation_delivery");
    expect(diagnostic?.contexts?.operation).toEqual({ reportId: "a".repeat(32), attempt: 1 });
    expect(moderation?.contexts?.operation).toEqual({ submissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(JSON.stringify(envelopes)).not.toContain(secret);
  });
});

describe("handled Worker failures", () => {
  it("captures an unexpected storage failure once without changing its 500 response", async () => {
    const store = new InMemoryUploadStore();
    const failure = new Error("test storage outage");
    store.getBatch = async () => { throw failure; };
    const reports: Parameters<ErrorReporter>[] = [];
    const reportError: ErrorReporter = (...args) => { reports.push(args); };
    const worker = createUploadWorker({ store, botSecret: "test", reportError });
    const response = await worker.fetch(new Request(`https://uploads.test/uploads/status/${secret}?installId=${secret}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(reports).toEqual([[failure, "upload.request", { route: "/uploads/status/:batchId", httpStatus: 500 }]]);
  });

  it("does not report expected HttpErrors and remains operational if telemetry itself throws", async () => {
    const store = new InMemoryUploadStore();
    const reports: Parameters<ErrorReporter>[] = [];
    const reportError: ErrorReporter = (...args) => {
      reports.push(args);
      throw new Error("telemetry unavailable");
    };
    const worker = createUploadWorker({ store, botSecret: "test", reportError });
    store.getBatch = async () => { throw new HttpError(409, "submission_locked"); };
    expect((await worker.fetch(new Request("https://uploads.test/uploads/status/test"))).status).toBe(409);
    expect(reports).toHaveLength(0);
    store.getBatch = async () => { throw new Error("storage failure"); };
    expect((await worker.fetch(new Request("https://uploads.test/uploads/status/test"))).status).toBe(500);
    expect(reports).toHaveLength(1);
  });

  it("reports rate-limiter outages but not normal quota denials", async () => {
    const reports: Parameters<ErrorReporter>[] = [];
    const reportError: ErrorReporter = (...args) => { reports.push(args); };
    const request = new Request("https://uploads.test/uploads/prepare", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.1" } });
    const limiter = { limit: async () => ({ success: false }) };
    const env = { UPLOAD_PREPARE_RATE_LIMITER: limiter, UPLOAD_OBJECT_RATE_LIMITER: limiter, UPLOAD_COMPLETE_RATE_LIMITER: limiter, UPLOAD_ATTRIBUTION_RATE_LIMITER: limiter };
    expect((await enforceEdgeRateLimit(request, env, reportError))?.status).toBe(429);
    expect(reports).toHaveLength(0);
    limiter.limit = async () => { throw new Error("edge unavailable"); };
    expect((await enforceEdgeRateLimit(request, env, reportError))?.status).toBe(503);
    expect(reports).toHaveLength(1);
  });

  it("never passes the raw diagnostic storage exception to telemetry", async () => {
    const reports: Parameters<ErrorReporter>[] = [];
    const reportError: ErrorReporter = (...args) => { reports.push(args); };
    const report = { schemaVersion: 1, reportId: "a".repeat(32), createdUtc: "2026-01-01T00:00:00Z", description: secret, context: {}, versions: {}, system: {}, mods: [], logs: [] };
    const request = new Request("https://uploads.test/uploads/diagnostics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
    const store = new InMemoryUploadStore() as InMemoryUploadStore & DiagnosticDeliveryStore;
    const bucket = { put: async () => { throw Object.assign(new Error(secret), { request: report }); }, get: async () => null, delete: async () => undefined };
    const response = await handleDiagnosticsRequest(request, { bucket, store, botSecret: "test", reportError });
    expect(response?.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect((reports[0][0] as Error).message).toBe("Diagnostic storage request failed.");
    expect(JSON.stringify(reports)).not.toContain(secret);
  });
});

describe("source-map upload gate", () => {
  it("skips without a token and rejects incomplete authenticated configuration before invoking the uploader", () => {
    const base = { ...process.env, SENTRY_AUTH_TOKEN: "", SENTRY_ORG: "", SENTRY_PROJECT: "", SENTRY_RELEASE: "" };
    const skipped = spawnSync(process.execPath, ["scripts/upload-sourcemaps.mjs"], { env: base, encoding: "utf8" });
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("upload skipped");
    const partial = spawnSync(process.execPath, ["scripts/upload-sourcemaps.mjs"], { env: { ...base, SENTRY_AUTH_TOKEN: "offline-test-token" }, encoding: "utf8" });
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain("requires SENTRY_ORG, SENTRY_PROJECT, SENTRY_RELEASE");
  });
});
