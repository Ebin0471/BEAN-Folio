/**
 * BEAN Intelligence gateway — unified provider entry point (server-side only).
 *
 * Every AI call in the application flows through here. The gateway owns:
 *  - capability-based provider routing (registry.ts),
 *  - timeouts, transient-only retries and per-provider circuit breaking
 *    (circuit.ts),
 *  - within-capability fallback that NEVER changes the task contract (an
 *    image request can never be answered by a text model, a refused safety
 *    case is never retried elsewhere),
 *  - structured observability without prompt contents or credentials,
 *  - honest failure: no fabricated responses, no fake success, no silent
 *    provider substitution beyond the declared same-capability chain.
 *
 * Product code (agents) only states WHAT capability it needs; the concrete
 * provider/model decision stays here. Provider/model names may appear in
 * server logs but are never part of user-facing payloads from this module.
 */

import ZAI from "z-ai-web-dev-sdk";

import {
  allowProvider,
  isTransientProviderError,
  withIntelligenceRetries,
  providerHealthSnapshot,
} from "./circuit";
import { providersFor, type IntelligenceCapability } from "./registry";
import { logGatewayEvent, type GatewayAgent } from "./observability";
import { withTimeout } from "./with-timeout";

/** Safe, user-facing gateway failure. Internal details are logged, never leaked. */
export class GatewayError extends Error {}

const DEFAULT_TIMEOUT_MS = 60_000;

const globalForGateway = globalThis as unknown as {
  __beanGatewayZai?: Awaited<ReturnType<typeof ZAI.create>>;
};

/** Init deadline for the managed SDK client — an SDK bootstrap hang must not
 *  hold an AI request (and the user's chat loading state) forever. */
const ZAI_INIT_TIMEOUT_MS = 15_000;

/** Managed gateway client (text / vision). One instance per process. */
async function getGatewayZai() {
  const existing = globalForGateway.__beanGatewayZai;
  if (existing) return existing;
  // The instance (not the promise) is memoized AFTER a successful create, so
  // a failed/hung init is never cached — the next request retries creation.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const created = (await Promise.race([
      ZAI.create(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayError("The AI service is unavailable right now. Please try again shortly.")), ZAI_INIT_TIMEOUT_MS);
      }),
    ])) as Awaited<ReturnType<typeof ZAI.create>>;
    globalForGateway.__beanGatewayZai = created;
    return created;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GatewayCallParams {
  /** Defaults to "text". "code" is served by the same reasoning providers. */
  capability?: "text" | "code";
  system: string;
  messages: GatewayMessage[];
  temperature?: number;
  /** Deep-reasoning mode for calls that legitimately need it. */
  thinking?: boolean;
  timeoutMs?: number;
  /**
   * Explicit output budget in tokens, forwarded to the provider as
   * `max_tokens`. Without it the provider's default cap TRUNCATES long
   * structured responses mid-string (GZ-BENCH-1 evidence: a file-batch JSON
   * was cut at ~10.5k chars — "Unterminated string" — unrecoverable by any
   * retry). Only set this for calls that legitimately produce large output.
   */
  maxTokens?: number;
  /** Who is calling — for routing logs and usage accounting. */
  agent: GatewayAgent;
  feature: string;
  userId?: string;
}

export interface GatewayResult {
  text: string;
  /** Internal provider id that served the call. */
  provider: string;
  model: string;
  durationMs: number;
}

function safeGatewayMessage(e: unknown): string {
  return e instanceof Error && e.message === "timeout"
    ? "The AI took too long to respond. Please try again."
    : "The AI service is unavailable right now. Please try again shortly.";
}

async function callManagedText(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  system: string,
  messages: GatewayMessage[],
  thinking: boolean,
  timeoutMs: number,
  maxTokens?: number
): Promise<string> {
  // Per the provider contract, the system prompt uses the assistant role.
  const completion = (await withTimeout(
    zai.chat.completions.create({
      messages: [{ role: "assistant", content: system }, ...messages] as never,
      thinking: { type: thinking ? "enabled" : "disabled" },
      // Explicit output ceiling — verified live: with max_tokens=32000 the
      // same call that truncated at ~10.5k chars returned 31.9k chars with
      // parseable JSON (probe-giftz-batch.ts, GZ-BENCH-1).
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    }),
    timeoutMs,
  )) as { choices?: { message?: { content?: string } }[] };
  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty response");
  return text;
}

/**
 * Run one text/code completion through the gateway. Throws GatewayError with
 * a SAFE message after all configured same-capability providers are exhausted.
 */
export async function gatewayComplete(params: GatewayCallParams): Promise<GatewayResult> {
  const capability: IntelligenceCapability = params.capability ?? "text";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entries = providersFor(capability).filter((p) => p.available());
  const routable = entries.filter((p) => allowProvider(p.id));

  if (routable.length === 0) {
    logGatewayEvent({
      event: "gateway.refused",
      agent: params.agent,
      feature: params.feature,
      capability,
      error: entries.length === 0 ? "no provider configured for capability" : "all providers circuit-open",
    });
    throw new GatewayError(
      entries.length === 0
        ? `No ${capability} provider is configured on this deployment.`
        : "The AI service is temporarily unavailable. Please try again shortly."
    );
  }

  let lastError: unknown;
  for (let i = 0; i < routable.length; i += 1) {
    const entry = routable[i];
    const startedAt = Date.now();
    try {
      const zai = await getGatewayZai();
      const text = await withIntelligenceRetries(
        () =>
          callManagedText(
            zai,
            params.system,
            params.messages,
            params.thinking ?? false,
            timeoutMs,
            params.maxTokens
          ),
        { label: `${capability}:${params.feature}`, providerId: entry.id, attempts: 2 }
      );
      const durationMs = Date.now() - startedAt;
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        model: entry.model,
        outcome: "success",
        durationMs,
        userId: params.userId,
      });
      return { text, provider: entry.id, model: entry.model, durationMs };
    } catch (e) {
      lastError = e;
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        outcome: "failure",
        durationMs: Date.now() - startedAt,
        userId: params.userId,
        error: e instanceof Error ? e.message : String(e),
      });
      // Fallback rule: same capability only, transient failures only, and
      // never after the last candidate. A safety/auth/invalid-output refusal
      // ends the chain immediately — it will not behave differently elsewhere.
      if (!isTransientProviderError(e) || i === routable.length - 1) break;
      logGatewayEvent({
        event: "gateway.fallback",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        error: "transient failure — trying next same-capability provider",
      });
    }
  }

  throw new GatewayError(safeGatewayMessage(lastError));
}

/**
 * Open a STREAMING text completion through the gateway. Returns the raw
 * provider stream; the caller owns protocol handling. The initial provider
 * call is covered by retries + the circuit breaker; mid-stream failures are
 * the caller's contract (partial persistence, as before).
 */
export async function gatewayStream(
  params: Omit<GatewayCallParams, "thinking" | "temperature">
): Promise<{ stream: unknown; provider: string; model: string }> {
  const capability: IntelligenceCapability = "text";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entries = providersFor(capability).filter((p) => p.available());
  const routable = entries.filter((p) => allowProvider(p.id));
  if (routable.length === 0) {
    logGatewayEvent({
      event: "gateway.refused",
      agent: params.agent,
      feature: params.feature,
      capability,
      error: "no routable streaming provider",
    });
    throw new GatewayError("The AI service is temporarily unavailable. Please try again shortly.");
  }
  let lastError: unknown;
  for (let i = 0; i < routable.length; i += 1) {
    const entry = routable[i];
    try {
      const zai = await getGatewayZai();
      const stream = await withIntelligenceRetries(
        () =>
          withTimeout(
            zai.chat.completions.create({
              // Per the provider contract, the system prompt uses the assistant role.
              messages: [{ role: "assistant", content: params.system }, ...params.messages] as never,
              thinking: { type: "disabled" },
              stream: true,
            }),
            timeoutMs,
          ),
        { label: `stream:${params.feature}`, providerId: entry.id, attempts: 2 }
      );
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        model: entry.model,
        outcome: "success",
        userId: params.userId,
      });
      return { stream, provider: entry.id, model: entry.model };
    } catch (e) {
      lastError = e;
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        outcome: "failure",
        userId: params.userId,
        error: e instanceof Error ? e.message : String(e),
      });
      if (!isTransientProviderError(e) || i === routable.length - 1) break;
    }
  }
  throw new GatewayError(safeGatewayMessage(lastError));
}

export interface GatewayVisionParams {
  prompt: string;
  /** Data URLs (base64). At most 5 images per call (provider contract). */
  images: string[];
  timeoutMs?: number;
  agent: GatewayAgent;
  feature: string;
  userId?: string;
}

export interface GatewayVisionPart {
  type: "text";
  text: string;
}
interface VisionContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/** Run ONE vision completion (≤5 images) through the gateway. */
export async function gatewayVision(params: GatewayVisionParams): Promise<GatewayResult> {
  const capability: IntelligenceCapability = "vision";
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const entries = providersFor(capability).filter((p) => p.available());
  const routable = entries.filter((p) => allowProvider(p.id));
  if (routable.length === 0) {
    logGatewayEvent({
      event: "gateway.refused",
      agent: params.agent,
      feature: params.feature,
      capability,
      error: entries.length === 0 ? "no vision provider configured" : "all vision providers circuit-open",
    });
    throw new GatewayError("The AI service is unavailable right now. Please try again shortly.");
  }
  let lastError: unknown;
  for (let i = 0; i < routable.length; i += 1) {
    const entry = routable[i];
    const startedAt = Date.now();
    try {
      const zai = await getGatewayZai();
      const content: VisionContentPart[] = [
        { type: "text", text: params.prompt },
        ...params.images.slice(0, 5).map((url) => ({ type: "image_url" as const, image_url: { url } })),
      ];
      const text = await withIntelligenceRetries(async () => {
        // The SDK types `model` as required, but the gateway contract resolves
        // the vision model server-side when omitted — model selection stays
        // with the gateway configuration (no id pinned, none invented).
        const completion = (await withTimeout(
          zai.chat.completions.createVision({
            messages: [{ role: "user", content }] as never,
            thinking: { type: "disabled" },
          } as unknown as Parameters<typeof zai.chat.completions.createVision>[0]),
          timeoutMs,
        )) as { choices?: { message?: { content?: string } }[] };
        const out = completion?.choices?.[0]?.message?.content?.trim();
        if (!out) throw new Error("empty response");
        return out;
      }, { label: `vision:${params.feature}`, providerId: entry.id, attempts: 2 });
      const durationMs = Date.now() - startedAt;
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        model: entry.model,
        outcome: "success",
        durationMs,
        userId: params.userId,
      });
      return { text, provider: entry.id, model: entry.model, durationMs };
    } catch (e) {
      lastError = e;
      logGatewayEvent({
        event: "gateway.request",
        agent: params.agent,
        feature: params.feature,
        capability,
        provider: entry.id,
        outcome: "failure",
        durationMs: Date.now() - startedAt,
        userId: params.userId,
        error: e instanceof Error ? e.message : String(e),
      });
      if (!isTransientProviderError(e) || i === routable.length - 1) break;
    }
  }
  throw new GatewayError(safeGatewayMessage(lastError));
}

/** Operator-facing status (ids/labels/health only — no secrets, no keys). */
export function gatewayStatus() {
  return {
    label: "BEAN Intelligence gateway",
    provider: "BEAN Intelligence gateway (server-side)",
    providers: [
      ...providersFor("text").map((p) => ({ ...p, available: p.available() })),
      ...providersFor("image").map((p) => ({ ...p, available: p.available() })),
    ],
    health: providerHealthSnapshot(),
    embedding: { available: false, note: "No embedding provider is configured on this deployment." },
  };
}

/**
 * M31 — source-grounded web search through the same gateway client.
 *
 * Uses the platform SDK's web_search function (real results with URLs,
 * titles, snippets and hosts). Server-side only, like every gateway call.
 * Results are NEVER fabricated by this layer: what comes back from the
 * search function is what the caller receives — an empty result set is
 * reported as empty, not invented.
 */
export interface GatewaySearchResultItem {
  url: string;
  name: string;
  snippet: string;
  hostName: string;
  rank: number;
  date: string;
}

export async function gatewayWebSearch(params: {
  query: string;
  num?: number;
  recencyDays?: number;
  timeoutMs?: number;
}): Promise<GatewaySearchResultItem[]> {
  const zai = await getGatewayZai();
  const results = (await withTimeout(
    zai.functions.invoke("web_search", {
      query: params.query,
      ...(params.num !== undefined ? { num: params.num } : {}),
      ...(params.recencyDays !== undefined ? { recency_days: params.recencyDays } : {}),
    }) as unknown as Promise<{ url: string; name: string; snippet: string; host_name: string; rank: number; date: string }[]>,
    params.timeoutMs ?? 15_000
  )) as { url: string; name: string; snippet: string; host_name: string; rank: number; date: string }[];

  return (Array.isArray(results) ? results : [])
    .filter((r) => r && typeof r.url === "string" && typeof r.name === "string")
    .slice(0, params.num ?? 8)
    .map((r) => ({
      url: r.url,
      name: r.name,
      snippet: typeof r.snippet === "string" ? r.snippet.slice(0, 500) : "",
      hostName: typeof r.host_name === "string" ? r.host_name : "",
      rank: typeof r.rank === "number" ? r.rank : 0,
      date: typeof r.date === "string" ? r.date.slice(0, 40) : "",
    }));
}
