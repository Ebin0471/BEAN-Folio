/**
 * Structured operational logging (Phase 7).
 *
 * One JSON object per line, machine-parseable, level-gated by LOG_LEVEL.
 * House rules (inherited from the gateway observability layer and the Phase 7
 * brief): NEVER log passwords, tokens, prompts containing private data, or
 * secret environment values. String field values therefore pass through the
 * same redaction rules the CODE GIFTZ isolation layer uses before anything
 * hits the console.
 *
 * Events are intentionally small and metadata-only: routes, ids, counts,
 * statuses. Request bodies and prompts are never passed to this module.
 */

import { redactText } from "@/lib/giftz/redact";
import { getRequestId } from "@/lib/request-context";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const CONFIGURED = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
const THRESHOLD: number =
  CONFIGURED in LEVELS
    ? LEVELS[CONFIGURED as LogLevel]
    : process.env.NODE_ENV === "production"
      ? LEVELS.info
      : LEVELS.debug;

function redactFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (typeof v === "string") {
      out[k] = redactText(v).text;
    } else if (v instanceof Error) {
      // Error MESSAGE only — stacks can carry internals and are dev-log only.
      out[k] = redactText(v.message).text;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < THRESHOLD) return;
  const requestId = getRequestId();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    // Correlation: request ID of the API request this line belongs to (set
    // by the handler() wrapper). Absent outside request scope — background
    // jobs, recurring sweeps and startup lines carry none by design.
    ...(requestId ? { requestId } : {}),
    ...redactFields(fields),
  });
  // warn/error to stderr (mirrors the previous console.error destinations so
  // dev.log keeps capturing them), info/debug to stdout.
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
