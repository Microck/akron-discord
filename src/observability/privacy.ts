import type { ErrorEvent, EventHint, NodeOptions, StackFrame } from "@sentry/node";

export const operations = [
  "bot.runtime", "bot.interaction", "bot.message", "bot.message_update", "bot.forum_scan",
  "bot.moderation_poll", "bot.moderation_delivery", "bot.diagnostic_poll", "bot.diagnostic_delivery",
  "bot.catalog_reconcile", "bot.catalog_cache", "bot.nim_review", "bot.archive_scan", "bot.archive_store",
  "bot.github_webhook", "upload.request", "upload.rate_limit", "upload.configuration",
  "upload.diagnostics_store", "upload.cleanup"
] as const;
export type Operation = typeof operations[number];
export type OperationalContext = { reportId?: string; submissionId?: string; attempt?: number; httpStatus?: number; route?: string };
export type ErrorReporter = (error: unknown, operation: Operation, context?: OperationalContext) => void;
type StreamedSpan = Parameters<NonNullable<NodeOptions["beforeSendSpan"]>>[0];

export function reportSafely(reporter: ErrorReporter | undefined, error: unknown, operation: Operation, context?: OperationalContext): void {
  try { reporter?.(error, operation, context); } catch { /* Telemetry cannot change a request outcome. */ }
}

const operationNames = new Set<string>(operations);
const errorTypes = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "AbortError", "TimeoutError", "SqliteError", "ZodError", "APIError", "HTTPError"
]);
const routePatterns: Array<[RegExp, string]> = [
  [/^\/uploads\/(challenge|prepare|complete|diagnostics)$/, "/uploads/$1"],
  [/^\/uploads\/objects\/[^/]+$/, "/uploads/objects/:objectId"],
  [/^\/uploads\/status\/[^/]+$/, "/uploads/status/:batchId"],
  [/^\/uploads\/source\/[^/]+$/, "/uploads/source/:objectId"],
  [/^\/uploads\/[^/]+\/(withdraw|convert-to-anonymous)$/, "/uploads/:submissionId/$1"],
  [/^\/bot\/diagnostics\/(claim)$/, "/bot/diagnostics/$1"],
  [/^\/bot\/diagnostics\/[^/]+\/(renew|retry|delivered)$/, "/bot/diagnostics/:reportId/$1"],
  [/^\/bot\/diagnostics\/[^/]+$/, "/bot/diagnostics/:reportId"],
  [/^\/bot\/catalog\/(entries|captures\/source|captures\/transform)$/, "/bot/catalog/$1"],
  [/^\/bot\/jobs\/(claim|requeue|delivered)$/, "/bot/jobs/$1"],
  [/^\/bot\/reviews\/[^/]+$/, "/bot/reviews/:submissionId"],
  [/^\/bot\/discord-messages\/[^/]+$/, "/bot/discord-messages/:submissionId"],
  [/^\/bot\/submissions\/[^/]+\/(context|delete)$/, "/bot/submissions/:submissionId/$1"],
  [/^\/bot\/submissions\/by-discord-thread\/[^/]+\/delete$/, "/bot/submissions/by-discord-thread/:threadId/delete"],
  [/^\/bot\/moderation\/[^/]+\/(approve|reject|request-changes)$/, "/bot/moderation/:submissionId/$1"],
  [/^\/bot\/attribution\/[^/]+\/confirm$/, "/bot/attribution/:submissionId/confirm"]
];

/** Match only known routes; never send a hostname, query, signed URL, or an unknown path. */
export function uploadRoute(url: string): string {
  let pathname: string;
  try { pathname = new URL(url, "https://akron.invalid").pathname; } catch { return "/unknown"; }
  for (const [pattern, replacement] of routePatterns) {
    if (pattern.test(pathname)) return pathname.replace(pattern, replacement).replace(/\/$/, "");
  }
  return "/unknown";
}

export function safeContext(context: OperationalContext = {}): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  if (context.reportId && /^[a-f0-9]{32}$/.test(context.reportId)) result.reportId = context.reportId;
  if (context.submissionId && /^[a-f0-9-]{36}$/.test(context.submissionId)) result.submissionId = context.submissionId;
  if (Number.isSafeInteger(context.attempt) && context.attempt! >= 0) result.attempt = context.attempt!;
  if (Number.isInteger(context.httpStatus) && context.httpStatus! >= 100 && context.httpStatus! <= 599) result.httpStatus = context.httpStatus!;
  if (context.route) result.route = uploadRoute(context.route);
  return result;
}

function codeFile(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  if (/^node:[a-zA-Z0-9_./-]+$/.test(filename)) return filename;
  const path = filename.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  const knownPath = path.match(/(?:^|\/)((?:dist\/src|src|node_modules)\/[a-zA-Z0-9_@./-]+\.(?:[cm]?js|ts))$/)?.[1];
  if (knownPath && !knownPath.split("/").includes("..")) return `app:///${knownPath}`;
  if (/^(?:.*\/)?(?:instrumentation-worker|upload-worker-cloudflare|worker)\.js$/.test(path)) return "app:///instrumentation-worker.js";
  return "app:///unknown.js";
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    filename: codeFile(frame.filename),
    function: frame.function && /^[a-zA-Z0-9_$.[\]<>]+$/.test(frame.function) ? frame.function.slice(0, 160) : undefined,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app
  };
}

/** Rebuild the envelope payload, rather than attempting to redact arbitrary private report text. */
export function sanitizeErrorEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  if (hint) hint.attachments = [];
  const operation = operationNames.has(String(event.tags?.operation)) ? String(event.tags?.operation) : "bot.runtime";
  const trace = event.contexts?.trace;
  const service = event.tags?.service === "akron-upload-worker" ? "akron-upload-worker" : "akron-discord";
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: "javascript",
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    tags: { service, operation },
    contexts: {
      operation: safeContext((event.contexts?.operation ?? {}) as OperationalContext),
      ...(trace ? { trace: { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id } } : {})
    },
    exception: { values: (event.exception?.values ?? [{ type: "Error" }]).map(value => ({
      type: errorTypes.has(value.type ?? "") ? value.type : "Error",
      value: `${operation} failed`,
      stacktrace: value.stacktrace ? { frames: value.stacktrace.frames?.map(safeFrame) } : undefined,
      mechanism: { type: "generic", handled: value.mechanism?.handled ?? true }
    })) },
    debug_meta: event.debug_meta ? { images: event.debug_meta.images?.filter(image =>
      image.type === "sourcemap" && typeof image.debug_id === "string" && /^[a-f0-9-]{36}$/i.test(image.debug_id)
    ).map(image => ({ type: "sourcemap", debug_id: image.debug_id, code_file: codeFile(image.code_file) ?? "app:///unknown.js" })) } : undefined
  };
}

/** v11 streams spans: beforeSendTransaction does not run for this payload. */
export function sanitizeSpan(span: StreamedSpan): StreamedSpan {
  const operation = span.attributes["akron.operation"];
  const name = operationNames.has(String(operation)) ? String(operation)
    : operationNames.has(span.name) ? span.name
      : /^(GET|POST|PUT|DELETE) /.test(span.name) ? `${span.name.split(" ", 1)[0]} ${uploadRoute(span.name.slice(span.name.indexOf(" ") + 1))}`
        : "dependency";
  const status = span.attributes["http.response.status_code"];
  return {
    trace_id: span.trace_id, parent_span_id: span.parent_span_id, span_id: span.span_id,
    start_timestamp: span.start_timestamp, end_timestamp: span.end_timestamp,
    status: span.status, is_segment: span.is_segment, name,
    attributes: {
      "sentry.op": operationNames.has(name) ? "akron.operation" : "dependency",
      ...(typeof status === "number" && status >= 100 && status <= 599 ? { "http.response.status_code": status } : {})
    }
  };
}

export function tracesSampleRate(value: string | undefined): number {
  const parsed = Number(value);
  return value?.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

export const privacyOptions = {
  defaultIntegrations: false,
  sendClientReports: false,
  maxBreadcrumbs: 0,
  traceLifecycle: "stream",
  tracePropagationTargets: [],
  dataCollection: {
    userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
    graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
    databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0
  },
  beforeSend: sanitizeErrorEvent,
  beforeSendSpan: sanitizeSpan,
  beforeBreadcrumb: () => null,
  beforeSendLog: () => null,
  beforeSendMetric: () => null
} satisfies Partial<NodeOptions>;
