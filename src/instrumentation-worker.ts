import * as Sentry from "@sentry/cloudflare";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createCloudflareUploadWorker, type CloudflareUploadEnv } from "./upload-worker-cloudflare.js";
import { privacyOptions, safeContext, tracesSampleRate, uploadRoute, type ErrorReporter } from "./observability/privacy.js";

const reportError: ErrorReporter = (error, operation, context) => {
  Sentry.getActiveSpan()?.setStatus({ code: 2 });
  Sentry.captureException(error, {
    tags: { service: "akron-upload-worker", operation },
    contexts: { operation: safeContext(context) }
  });
};
const plain = createCloudflareUploadWorker();
const observed = createCloudflareUploadWorker(reportError);
const instrumented = Sentry.withSentry((env: CloudflareUploadEnv) => ({
  ...privacyOptions,
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT || "production",
  release: env.SENTRY_RELEASE,
  tracesSampleRate: tracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
  initialScope: { tags: { service: "akron-upload-worker", operation: "upload.request" } }
}), {
  async fetch(request: Request, env: CloudflareUploadEnv, _ctx?: ExecutionContext): Promise<Response> {
    const route = uploadRoute(request.url);
    Sentry.getIsolationScope().setContext("operation", { route });
    const span = Sentry.getActiveSpan();
    if (span) Sentry.updateSpanName(span, `${request.method} ${route}`);
    return observed.fetch(request, env);
  },
  async scheduled(controller: unknown, env: CloudflareUploadEnv, _ctx?: ExecutionContext): Promise<void> {
    Sentry.getIsolationScope().setTag("operation", "upload.cleanup");
    await Sentry.startSpan({ name: "upload.cleanup", op: "akron.operation", attributes: { "akron.operation": "upload.cleanup" } }, () => observed.scheduled(controller, env));
  }
});

// An absent DSN selects the original handler; no SDK client or transport is created.
export default {
  fetch(request: Request, env: CloudflareUploadEnv, ctx: ExecutionContext): Promise<Response> {
    return env.SENTRY_DSN?.trim() ? instrumented.fetch(request, env, ctx) : plain.fetch(request, env);
  },
  scheduled(controller: unknown, env: CloudflareUploadEnv, ctx: ExecutionContext): Promise<void> {
    return env.SENTRY_DSN?.trim() ? instrumented.scheduled(controller, env, ctx) : plain.scheduled(controller, env);
  }
};
