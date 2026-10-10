import "./env.js";
import * as Sentry from "@sentry/node";
import { privacyOptions, tracesSampleRate } from "./observability/privacy.js";

// Run with --import before the application loads Discord, HTTP clients, or SQLite.
if (process.env.SENTRY_DSN?.trim()) {
  Sentry.init({
    ...privacyOptions,
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: tracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
    enableRuntimeChannelInjection: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
    initialScope: { tags: { service: "akron-discord", operation: "bot.runtime" } }
  });
}
