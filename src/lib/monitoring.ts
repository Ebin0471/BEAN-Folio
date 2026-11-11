/**
 * Error-monitoring hook (Phase 7).
 *
 * Every unhandled API failure and hardening-relevant rejection flows through
 * `reportError`: it always emits a structured log event (see logger.ts) and,
 * when `ERROR_WEBHOOK_URL` is configured, POSTs the same redacted payload to
 * that sink fire-and-forget (3 s timeout, failures swallowed — monitoring may
 * never take the request path down with it).
 *
 * No external monitoring service is required or claimed: the hook is a
 * pluggable seam. Payloads carry metadata only (route, status, error message)
 * — never request bodies, prompts, tokens, or credentials.
 */

import { log } from "@/lib/logger";
import { redactText } from "@/lib/giftz/redact";

const WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL?.trim() || "";

let webhookFailures = 0;

async function postWebhook(payload: Record<string, unknown>): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok && webhookFailures < 3) {
        webhookFailures += 1;
        log.warn("monitoring.webhook_status", { status: res.status });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // Monitoring must never throw into the request path.
    if (webhookFailures < 3) {
      webhookFailures += 1;
      log.warn("monitoring.webhook_failed", {
        reason: e instanceof Error ? e.message : "unknown",
      });
    }
  }
}

/**
 * Report a server-side error. `context` fields are redacted (strings pass the
 * secret-redaction rules) and must already exclude bodies/prompts.
 */
export function reportError(event: string, context: Record<string, unknown> = {}): void {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    redacted[k] = typeof v === "string" ? redactText(v).text : v;
  }
  log.error(event, redacted);
  if (WEBHOOK_URL) void postWebhook({ event, ts: new Date().toISOString(), ...redacted });
}
