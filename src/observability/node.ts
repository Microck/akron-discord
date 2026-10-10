import * as Sentry from "@sentry/node";
import { operations, safeContext, type Operation, type OperationalContext } from "./privacy.js";

const captured = new WeakSet<object>();

export function captureNodeError(error: unknown, operation?: Operation, context?: OperationalContext): void {
  if (!Sentry.isEnabled()) return;
  if (typeof error === "object" && error !== null) {
    if (captured.has(error)) return;
    captured.add(error);
  }
  const inherited = Sentry.getIsolationScope().getScopeData().tags.operation;
  const name = operation ?? (operations.includes(inherited as Operation) ? inherited as Operation : "bot.runtime");
  try {
    Sentry.getActiveSpan()?.setStatus({ code: 2 });
    Sentry.captureException(error, {
      tags: { service: "akron-discord", operation: name },
      ...(context ? { contexts: { operation: safeContext(context) } } : {})
    });
  } catch {
    // Telemetry must never change delivery, publication, or retry behavior.
  }
}

export function withNodeOperation<T>(operation: Operation, callback: () => T, context?: OperationalContext): T {
  if (!Sentry.isEnabled()) return callback();
  return Sentry.withIsolationScope(scope => {
    scope.setTag("service", "akron-discord");
    scope.setTag("operation", operation);
    scope.setContext("operation", safeContext(context));
    // Polls provide error context; only actual claimed jobs create timed spans.
    if (operation.endsWith("_poll")) return callback();
    return Sentry.startSpan({ name: operation, op: "akron.operation", attributes: { "akron.operation": operation } }, callback);
  });
}

export async function flushNodeTelemetry(timeoutMs = 2000): Promise<void> {
  if (!Sentry.isEnabled()) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Sentry.flush(timeoutMs).catch(() => false),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
