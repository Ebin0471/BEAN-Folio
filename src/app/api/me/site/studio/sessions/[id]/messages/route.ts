import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, err, parseBody, rateLimit, getClientKey, ERR } from "@/lib/api-helpers";
import { aiGate, recordAiUsage } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { startStudioTurn } from "@/lib/site-studio/turn";

export const dynamic = "force-dynamic";
// The route only CREATES the turn — the engine runs in the background and the
// studio polls /api/me/site/studio/turns/[taskId] (same 202 contract as the
// LAXII generation route).
export const maxDuration = 60;

/**
 * Hardening bound (Phase 6): the builder's draft is a JSON OBJECT on the wire
 * (ChatPanel posts `configRef.current`, a SiteConfig object — never a string,
 * array or scalar), so the structural check is intentionally light
 * (z.looseObject) and the real shape validation stays in turn.ts
 * (normalizeConfig). The bound that matters is SIZE: the largest legitimate
 * drafts serialize far below 1MB; 2MB is a generous ceiling that still stops
 * multi-megabyte abuse payloads. Exported for tests/security-hardening.test.ts.
 */
export const MAX_CURRENT_CONFIG_BYTES = 2_000_000;

export function currentConfigTooLarge(config: unknown): boolean {
  try {
    return JSON.stringify(config).length > MAX_CURRENT_CONFIG_BYTES;
  } catch {
    return true; // unserializable → treat as over the bound
  }
}

const bodySchema = z
  .object({
    /** The prompt — required for a new turn; ignored for a retry (the
     *  ORIGINAL persisted user message is reused verbatim). The 50,000 cap is
     *  the GIFTZ prompt limit — kept in lockstep with the studio composer
     *  (ChatPanel COMPOSER_MAX) and the turn persistence; a prompt accepted
     *  by the UI is never truncated downstream. */
    text: z.string().trim().max(50_000).optional(),
    /** The builder's current draft (unsaved canvas state included) — the base
     *  a PORTFOLIO turn plans against. Never mutated by this endpoint.
     *  Optional: GIFTZ sessions ignore it entirely (their base comes from the
     *  GiftzSite's own saved config — the portfolio draft can never leak into
     *  a GIFTZ generation). Structurally light here; size-bounded post-parse
     *  (see MAX_CURRENT_CONFIG_BYTES). */
    currentConfig: z.looseObject({}).optional(),
    mode: z.enum(["edit", "create"]).default("edit"),
    materialIds: z.array(z.string().min(1).max(40)).max(12).default([]),
    context: z
      .object({
        device: z.string().max(20).optional(),
        pageName: z.string().max(60).optional(),
        sectionType: z.string().max(30).optional(),
        sectionTitle: z.string().max(120).optional(),
      })
      .optional(),
    /** RETRY of a failed turn: reuse THIS user message's persisted prompt. */
    retryOfMessageId: z.string().min(1).max(64).optional(),
  })
  .refine((v) => (v.text && v.text.trim().length >= 2) || Boolean(v.retryOfMessageId), {
    message: "Provide a message (2-50000 chars) or a retryOfMessageId to re-run.",
    path: ["text"],
  });

export { bodySchema }; // exported for tests/security-hardening.test.ts

/** Cheap pre-parse ceiling: refuse oversized bodies before JSON.parse work. */
// 2MB draft + a full 50k-char prompt (up to ~200KB UTF-8 for multi-byte
// scripts) + the rest of the envelope — generous, still abuse-proof.
const MAX_BODY_BYTES = 2_400_000;

/**
 * POST /api/me/site/studio/sessions/[id]/messages — send one studio turn.
 *
 * Persists the USER message, creates the ASSISTANT placeholder + durable
 * AgentTask, and runs the REAL pipeline (plan → execute → isolated proposal)
 * in the background. Returns 202 immediately with the ids to poll.
 */
export const POST = handler(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`studio-msg:${getClientKey(req)}`, 20, 60_000)) return ERR.rateLimited();

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return err("Request body too large.", 413);
  }

  const gate = await aiGate(user);
  if (gate) return gate;

  const { id } = await params;
  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;

  if (r.data.currentConfig !== undefined && currentConfigTooLarge(r.data.currentConfig)) {
    return err("The website draft is too large to process.", 413);
  }

  try {
    const turn = await startStudioTurn({
      userId: user.id,
      sessionId: id,
      text: r.data.text ?? "",
      currentConfig: r.data.currentConfig ?? null,
      mode: r.data.mode,
      materialIds: r.data.materialIds,
      context: r.data.context ?? null,
      retryOfMessageId: r.data.retryOfMessageId,
    });
    await recordAiUsage(user.id, "design");
    return NextResponse.json(
      {
        userMessageId: turn.userMessageId,
        assistantMessageId: turn.assistantMessageId,
        taskId: turn.taskId,
      },
      { status: 202 }
    );
  } catch (e) {
    // startStudioTurn throws a SMALL SET of curated, user-safe messages for
    // client-fixable problems. Everything else (Prisma internals, IO faults)
    // must never reach the client (Phase 6 leak fix): unknown errors are
    // logged server-side and mapped to a typed generic. Statuses the client
    // relies on are preserved: 404 → session gone (studio refreshes the
    // session list), 400 → toast (ChatPanel reads only `error.message`).
    const message = e instanceof Error ? e.message : "";
    if (message === "Conversation not found") return err("Session not found", 404);
    if (
      message === "The current website configuration is invalid." ||
      message === "The original message of this retry no longer exists." ||
      message === "The message text is too short to send."
    ) {
      return err(message, 400);
    }
    console.error("[api] studio turn rejected:", e);
    return err("Invalid request", 400);
  }
});
