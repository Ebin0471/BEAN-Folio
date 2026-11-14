import type { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { db } from "@/lib/db";
import { err, ERR, rateLimit } from "@/lib/api-helpers";
import {
  gatewayComplete,
  gatewayStream,
  gatewayVision,
  GatewayError,
} from "@/lib/intelligence/gateway";
import { GATEWAY_LABEL } from "@/lib/intelligence/personas";
import type { GatewayAgent } from "@/lib/intelligence/observability";
import { log } from "@/lib/logger";

/**
 * BEAN Folio AI gateway facade (server-side only) — BACKWARD-COMPATIBLE API.
 *
 * All provider calls now route through the BEAN Intelligence gateway
 * (src/lib/intelligence/**), which owns the provider registry, capability
 * routing, health checks, retries, circuit breaking, fallback policy and
 * structured observability. This module keeps the historical call signatures
 * so agent routes are untouched by the infrastructure change:
 *  - Code Giftz  — the website-design agent inside Website Studio (/api/ai/design/*)
 *  - RIISHE      — the general assistant at BEAN Intelligence (/api/ai/chat*)
 *  - LAXII       — the creative engine (/api/laxii/**; images via its own
 *                  validated engine, text/resume via this gateway)
 *
 * Agent identity, instructions, context and permissions are defined separately
 * in each agent's own route — Code Giftz may propose website config changes;
 * RIISHE is advisory-only. The concrete provider is chosen by the gateway
 * configuration — never in client code — and no capability is claimed beyond
 * what the configured providers deliver.
 * See docs/ai-integration.md and docs/ai-transformation/02-architecture.md.
 */

export const AI_FEATURES = [
  {
    id: "improve",
    label: "Improve writing",
    description: "Rewrite project descriptions, summaries and bios to be clear and compelling.",
  },
  {
    id: "suggest",
    label: "Suggest metadata",
    description: "Propose summaries, skills and a profession category from your draft.",
  },
  {
    id: "chat",
    label: "RIISHE — general assistant",
    description: "Research, writing, explanations and portfolio advice grounded in your own data.",
  },
  {
    id: "design",
    label: "GIFTZ — website design",
    description: "GIFTZ, the Website Studio design agent, proposes structured, validated design changes.",
  },
] as const;

export function aiCapabilities() {
  return {
    available: true,
    // Provider-neutral identity — external provider/model names never surface
    // to clients (BEAN Intelligence branding rule). Operator details live in
    // server logs emitted by the gateway.
    provider: GATEWAY_LABEL,
    features: AI_FEATURES,
    dailyLimit: AI_DAILY_LIMIT,
    // BEAN Intelligence no longer requires a standalone consent toggle: every
    // authenticated user can use it out of the box (rate limit + daily quota
    // still apply). The field stays part of the API contract (clients and
    // tests read it) and now always reports false.
    consentRequired: false,
  };
}

export class AiProviderError extends Error {}

const TIMEOUT_MS = 60_000;
/** Extended timeout for the design agent's deep-reasoning calls. */
export const AI_DEEP_TIMEOUT_MS = 120_000;

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export const AI_DAILY_LIMIT = 30;
export const AI_BURST_LIMIT = 6;

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Shared burst rate limit → daily usage quota gate for BOTH agents.
 * Returns an error response or null. One quota pool: design proposals and
 * RIISHE chat draw from the same daily limit (surfaced as usedToday).
 *
 * BEAN Intelligence is available to EVERY authenticated user — the old
 * standalone consent toggle (and its 403 gate) was removed by owner
 * directive. Authorization and privacy boundaries are unchanged and live
 * elsewhere: every AI route authenticates the caller, every query is
 * owner-scoped, public/private profile visibility is enforced by the
 * serialize/visibility layer, and NO user's data is ever reachable by
 * another account through any AI surface. The persisted `User.aiConsent`
 * field remains (export/audit history) but gates nothing.
 */
export async function aiGate(user: User): Promise<NextResponse | null> {
  if (!rateLimit(`ai:${user.id}`, AI_BURST_LIMIT, 60_000)) return ERR.rateLimited();
  const used = await db.aiUsage.count({
    where: { userId: user.id, createdAt: { gte: startOfUtcDay() } },
  });
  if (used >= AI_DAILY_LIMIT) {
    return err(`Daily AI limit reached (${AI_DAILY_LIMIT}). Resets at midnight UTC.`, 429);
  }
  return null;
}

/**
 * Record one usage row for quota accounting. Used by every agent route after
 * a successful provider action. `costEstimateCents` carries the gateway's
 * documented cost ESTIMATE (0 for the unmetered managed gateway). Failure to
 * record is logged, never thrown — an accounting hiccup must not fail an
 * otherwise-successful AI response.
 */
export async function recordAiUsage(userId: string, feature: string, costEstimateCents = 0): Promise<void> {
  try {
    await db.aiUsage.create({ data: { userId, feature, costEstimateCents } });
  } catch (e) {
    log.error("ai.usage_record_failed", { message: String(e instanceof Error ? e.message : e).slice(0, 300) });
  }
}

function toProviderError(e: unknown): AiProviderError {
  if (e instanceof GatewayError) return new AiProviderError(e.message);
  return new AiProviderError(
    "The AI service is unavailable right now. Please try again shortly."
  );
}

/**
 * Run a completion through the BEAN Intelligence gateway. System prompt is
 * passed separately and prepended.
 *
 * `opts.thinking` enables deep-reasoning for calls that need it (Code Giftz's
 * plan/step/audit reasoning); the default stays disabled for fast
 * conversational turns. `opts.timeoutMs` extends the provider deadline. The
 * model itself is NEVER named here — selection stays with the gateway
 * configuration. `opts.agent`/`opts.feature`/`opts.userId` enrich routing
 * logs only.
 *
 * Throws AiProviderError with a SAFE, user-facing message on any failure —
 * internal provider errors are logged, never leaked to clients.
 */
export async function aiComplete(
  system: string,
  messages: AiMessage[],
  opts: {
    temperature?: number;
    thinking?: boolean;
    timeoutMs?: number;
    agent?: GatewayAgent;
    feature?: string;
    userId?: string;
  } = {}
): Promise<{ text: string }> {
  try {
    const result = await gatewayComplete({
      capability: "text",
      system,
      messages,
      temperature: opts.temperature,
      thinking: opts.thinking,
      timeoutMs: opts.timeoutMs,
      agent: opts.agent ?? "SYSTEM",
      feature: opts.feature ?? "complete",
      userId: opts.userId,
    });
    return { text: result.text };
  } catch (e) {
    throw toProviderError(e);
  }
}

/**
 * Open a STREAMING completion through the gateway (server-side only).
 * Returns the raw provider result — the caller owns the protocol handling
 * (SSE frames or a plain completion object). Used by the RIISHE streaming
 * chat route; the SDK type stays encapsulated behind this gateway function.
 */
export async function aiStream(
  system: string,
  messages: AiMessage[],
  opts: { timeoutMs?: number; agent?: GatewayAgent; feature?: string; userId?: string } = {}
): Promise<unknown> {
  try {
    const { stream } = await gatewayStream({
      system,
      messages,
      timeoutMs: opts.timeoutMs,
      agent: opts.agent ?? "SYSTEM",
      feature: opts.feature ?? "stream",
      userId: opts.userId,
    });
    return stream;
  } catch (e) {
    throw toProviderError(e);
  }
}

export type AiVisionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Run ONE vision completion through the gateway (server-side only).
 * Used by the Code Giftz materials pipeline to describe a small batch of the
 * user's uploaded images in a single call (cost/quota aware: 1 call for up to
 * 5 images). `images` are data URLs (base64) — the user's files never leave
 * the server except to the configured provider. Throws AiProviderError with a
 * SAFE message; callers degrade gracefully when vision is unavailable.
 */
export async function aiVision(
  prompt: string,
  images: string[],
  opts: { timeoutMs?: number; agent?: GatewayAgent; feature?: string; userId?: string } = {}
): Promise<{ text: string }> {
  try {
    const result = await gatewayVision({
      prompt,
      images,
      timeoutMs: opts.timeoutMs,
      agent: opts.agent ?? "SYSTEM",
      feature: opts.feature ?? "vision",
      userId: opts.userId,
    });
    return { text: result.text };
  } catch (e) {
    throw toProviderError(e);
  }
}

/** Parse a JSON object out of an LLM response (tolerates code fences). */
export function parseJsonFromText<T>(text: string): T | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
