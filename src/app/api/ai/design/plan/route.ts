import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, parseBody } from "@/lib/api-helpers";
import { aiGate, AiProviderError, recordAiUsage } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { normalizeConfig } from "@/lib/site-config";
import { planDesignChange } from "@/lib/ai-design/plan-core";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";
import { loadMaterialsForRequest, materialsBlock } from "@/lib/ai-design/ingest";

export const dynamic = "force-dynamic";
// Deep-reasoning planning legitimately runs long — keep the server deadline
// above the gateway's own AI_DEEP_TIMEOUT_MS.
export const maxDuration = 120;

const historyItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

const contextSchema = z
  .object({
    device: z.string().max(20).optional(),
    pageName: z.string().max(60).optional(),
    sectionType: z.string().max(30).optional(),
    sectionTitle: z.string().max(120).optional(),
  })
  .optional();

const planRequestSchema = z.object({
  request: z.string().trim().min(3).max(50_000),
  /** The builder's current config (unsaved canvas state included). */
  currentConfig: z.unknown(),
  context: contextSchema,
  history: z.array(historyItemSchema).max(8).default([]),
  /** "edit" (default) = repair/improve the current draft; "create" = the
   *  "create my own website" workflow (single site.compose plan). */
  mode: z.enum(["edit", "create"]).default("edit"),
  /** Media ids of the user's uploaded source materials (owner-scoped). */
  materialIds: z.array(z.string().min(1).max(40)).max(12).default([]),
});

/**
 * POST /api/ai/design/plan — Code Giftz, phase 1: REASONING.
 *
 * Turns a natural-language request into a STRUCTURED IMPLEMENTATION PLAN:
 * ordered steps, each bound to a real mutation tool from the registry, with
 * dependencies, change-family classification and the user's explicit
 * preservation constraints ("leave the project grid untouched").
 *
 * The planning pipeline itself (grounding → deep-reasoning call → schema
 * validation → digest validation → bounded self-repair) lives in
 * `@/lib/ai-design/plan-core` and is SHARED with the Website Studio's
 * conversational turns — both surfaces get identical safety semantics.
 *
 * This route never executes anything — approval and execution live in
 * /api/ai/design/execute. Nothing is persisted or published here.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, planRequestSchema);
  if (r.response) return r.response;
  const { request, context, history, mode, materialIds } = r.data;

  const current = normalizeConfig(r.data.currentConfig);
  if (!current) return err("The current website configuration is invalid.", 400);

  // ---- Grounding: computed digest + the user's own portfolio data ----
  // ---- + (create mode) the user's OWN uploaded source materials. ----
  const portfolioBlock = await fetchPortfolioBlock(user);
  let materialsText = "";
  if (mode === "create" && materialIds.length > 0) {
    const materials = await loadMaterialsForRequest(user.id, materialIds);
    materialsText = materialsBlock(materials);
  }

  try {
    const outcome = await planDesignChange({
      request,
      current,
      context: context ?? null,
      history,
      mode,
      portfolioBlock,
      materialsText: materialsText || undefined,
    });

    await recordAiUsage(user.id, "design");

    if (outcome.kind === "plan") return ok(outcome);
    if (outcome.kind === "reply") {
      return ok({
        kind: "reply" as const,
        reply: outcome.reply,
        clarifyingQuestion: outcome.clarifyingQuestion,
      });
    }
    return ok({
      kind: "invalid" as const,
      reply: outcome.reply,
      issues: outcome.issues,
    });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
