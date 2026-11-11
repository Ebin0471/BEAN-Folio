import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, err, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError, parseJsonFromText, recordAiUsage, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig } from "@/lib/site-config";
import { buildSiteDigest } from "@/lib/ai-design/digest";
import { validatePlan, designPlanSchema, dropUngroundedConstraints, dropUnresolvableConstraints, type DesignPlan, type PlanIssue, type PlanStep } from "@/lib/ai-design/plan";
import { planSystemPrompt } from "@/lib/ai-design/prompts";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";
import { loadMaterialsForRequest, materialsBlock } from "@/lib/ai-design/ingest";
import { createJob } from "@/lib/ai-design/jobs";
import { driveJob, KICK_BUDGET_MS } from "@/lib/ai-design/driver";
import type { StepContext, StepProvider } from "@/lib/ai-design/execute";

export const dynamic = "force-dynamic";
// Deep-reasoning planning legitimately runs long — keep the server deadline
// above the gateway's own AI_DEEP_TIMEOUT_MS.
export const maxDuration = 120;

/** The provider for model-tool steps: deep reasoning, extended deadline. */
const stepProvider: StepProvider = {
  complete: (system, messages, opts) =>
    aiComplete(system, messages, { ...opts, thinking: true, timeoutMs: AI_DEEP_TIMEOUT_MS }),
};

const contextSchema = z
  .object({
    device: z.string().max(20).optional(),
    pageName: z.string().max(60).optional(),
    sectionType: z.string().max(30).optional(),
    sectionTitle: z.string().max(120).optional(),
  })
  .optional();

const chatRequestSchema = z.object({
  message: z.string().trim().min(2).max(2000),
  /** The studio's current draft (unsaved canvas state included). */
  currentConfig: z.unknown(),
  /** Continue an existing conversation (owner-scoped) or start a new one. */
  conversationId: z.string().max(80).optional(),
  /** Explicit workflow: "create" = build my own website from materials. */
  mode: z.enum(["edit", "create"]).optional(),
  /** Media ids of the user's uploaded source materials (owner-scoped). */
  materialIds: z.array(z.string().min(1).max(40)).max(12).default([]),
  context: contextSchema,
});

/** The "create my own website" intent can also arrive as plain language. */
const CREATE_INTENT = /(create|build|make|start)\s+(me\s+)?(my|a|an)\s+(own\s+)?(new\s+)?(custom\s+)?(website|site|portfolio)\s+(from\s+scratch|from\s+my|from\s+the\s+ground)/i;

const MAX_MESSAGES_PER_CONVERSATION = 60;

/**
 * POST /api/ai/design/chat — the Website Studio's conversational coding entry.
 *
 * One streaming (SSE) endpoint that does what the old two-step panel UI did
 * client-side, durably and invisibly to the user:
 *   1. INSPECT  — server-computed digest of the REAL posted draft + the
 *      user's own portfolio grounding (owner-scoped, consent-gated).
 *   2. PLAN     — one deep-reasoning call produces the structured plan
 *      (registry tools, dependencies, preservation constraints); the plan is
 *      mechanically validated against the digest BEFORE anything runs.
 *   3. EXECUTE  — a DURABLE DesignJob is created (atomic lease, per-step
 *      persistence) and kicked in the background; the client drives the rest
 *      by polling /api/ai/design/job — progress, per-step events and the
 *      finished proposal all stream from there.
 *
 * Conversation history is persisted (DesignChatMessage — deliberately separate
 * from RIISHE's AiConversation). Zero-step plans are legitimate: off-scope
 * asks get a reply, under-specified asks get ONE clarifying question.
 *
 * SSE frames: {type:"status",phase} · {type:"reply",reply,steps} ·
 * {type:"plan",reply,steps,constraints,jobId} · {type:"done",conversationId} ·
 * {type:"error",message}.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, chatRequestSchema);
  if (r.response) return r.response;
  const { message, conversationId, materialIds, context } = r.data;
  const mode = r.data.mode ?? (CREATE_INTENT.test(message) ? "create" : "edit");

  const current = normalizeConfig(r.data.currentConfig);
  if (!current) return err("The current website configuration is invalid.", 400);

  // ---- conversation resolve (ownership is structural) ----
  let convoId: string;
  if (conversationId) {
    const exists = await db.designChatMessage.findFirst({
      where: { userId: user.id, conversationId },
      select: { id: true },
    });
    if (!exists) return err("That conversation does not exist for your account.", 404);
    convoId = conversationId;
  } else {
    convoId = `dc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // History for the prompt — the LAST 8 messages BEFORE this one.
  const prior = await db.designChatMessage.findMany({
    where: { userId: user.id, conversationId: convoId },
    orderBy: { createdAt: "desc" },
    take: 9,
  });
  const history = prior
    .reverse()
    .slice(-8)
    .map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content.slice(0, 2000) }));

  const count = await db.designChatMessage.count({ where: { userId: user.id, conversationId: convoId } });
  if (count >= MAX_MESSAGES_PER_CONVERSATION) {
    return err("This conversation is full — start a new one to keep Code Giftz's context focused.", 409);
  }

  await db.designChatMessage.create({
    data: { userId: user.id, conversationId: convoId, role: "USER", content: message },
  });

  // ---- grounding (server-computed, never client-supplied) ----
  const digest = buildSiteDigest(current);
  const portfolioBlock = await fetchPortfolioBlock(user);
  const stepContext: StepContext = { portfolioText: portfolioBlock };
  let materialsText = "";
  if (materialIds.length > 0) {
    const materials = await loadMaterialsForRequest(user.id, materialIds);
    if (materials.length > 0) {
      materialsText = materialsBlock(materials);
      stepContext.materialsText = materialsText;
      stepContext.allowedMediaIds = materialIds;
    }
  }

  const whereBlock = context
    ? `device ${context.device ?? "desktop"}, page ${context.pageName ?? "(home)"}, selected section ${
        context.sectionType ?? "(none)"
      }${context.sectionTitle ? ` ("${context.sectionTitle}")` : ""}`
    : "(no specific location)";
  const historyBlock =
    history.length > 0
      ? `\n\nRecent conversation (oldest first):\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}`
      : "";
  const system = planSystemPrompt(digest, portfolioBlock, mode);
  const materialsSuffix = materialsText ? `\n\n${materialsText}` : "";
  const userContent = `Where the user is looking right now: ${whereBlock}\n\nRequest: ${message}${historyBlock}${materialsSuffix}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };

      /** Persist an assistant turn (content + structured meta) — best effort. */
      const persistAssistant = async (content: string, meta: Record<string, unknown>) => {
        try {
          await db.designChatMessage.create({
            data: {
              userId: user.id,
              conversationId: convoId,
              role: "ASSISTANT",
              content: content.slice(0, 8000),
              metaJson: JSON.stringify(meta),
            },
          });
        } catch {
          /* the chat still streams; history persistence must never break it */
        }
      };

      try {
        send({ type: "status", phase: "inspect" });

        const { text } = await aiComplete(system, [{ role: "user", content: userContent }], {
          temperature: 0.3,
          thinking: true,
          timeoutMs: AI_DEEP_TIMEOUT_MS,
        });
        const parsed = parseJsonFromText<Record<string, unknown>>(text);
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Code Giftz returned an unreadable plan. Try rephrasing the request.");
        }

        const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, 800) : "";
        const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
        const clarifying =
          typeof parsed.clarifyingQuestion === "string" && parsed.clarifyingQuestion.trim().length > 0
            ? parsed.clarifyingQuestion.slice(0, 400)
            : null;

        // Zero-step outcomes are legitimate answers, not failures.
        if (stepsRaw.length === 0) {
          const content = reply || clarifying || "Could you clarify what you'd like changed?";
          await recordAiUsage(user.id, "design");
          await persistAssistant(content, { steps: [], clarifying: clarifying ?? null });
          send({ type: "reply", reply: content, clarifyingQuestion: clarifying });
          send({ type: "done", conversationId: convoId });
          finish();
          return;
        }

        send({ type: "status", phase: "plan" });

        const planCheck = designPlanSchema.safeParse(parsed);
        if (!planCheck.success) {
          throw new Error("The plan did not match Code Giftz's plan schema. Try rephrasing the request.");
        }
        let plan = planCheck.data as DesignPlan;

        const issues: PlanIssue[] = validatePlan(plan, digest);
        if (issues.length > 0) {
          const constraintRelated = (i: PlanIssue) =>
            i.code === "constraint-conflict" || (i.code === "unknown-section-target" && !i.stepId);
          if (issues.every(constraintRelated)) {
            const { plan: repaired, dropped } = dropUngroundedConstraints(plan, message);
            if (dropped.length > 0 && validatePlan(repaired, digest).length === 0) {
              plan = {
                ...repaired,
                notes: [repaired.notes, `Dropped ${dropped.length} preservation constraint${dropped.length === 1 ? "" : "s"} the model added on its own (you never asked for ${dropped.length === 1 ? "it" : "them"}).`].filter(Boolean).join(" "),
              };
            } else {
              const { plan: unblocked, dropped: unresolvable, narrowed } = dropUnresolvableConstraints(repaired, digest);
              if (unresolvable.length + narrowed.length > 0 && validatePlan(unblocked, digest).length === 0) {
                plan = unblocked;
              } else {
                throw new Error(
                  "Code Giftz's plan did not match your website's current state (it may name sections or pages that don't exist). Try rephrasing the request."
                );
              }
            }
          } else {
            const first = issues[0]!;
            throw new Error(
              `The plan was rejected before execution (${first.code}). Try rephrasing the request — nothing was changed.`
            );
          }
        }

        // ---- durable execution ----
        const job = await createJob({
          userId: user.id,
          plan,
          baseConfig: current,
          materialIds: mode === "create" ? materialIds : [],
          context: stepContext,
        });
        // Best-effort background kick; the studio's job poll drives the rest.
        void driveJob(user, job.id, stepProvider, { totalBudgetMs: KICK_BUDGET_MS }).catch(() => {});

        await recordAiUsage(user.id, "design");
        await persistAssistant(plan.reply || "Working on it.", {
          jobId: job.id,
          steps: plan.steps.map((s: PlanStep) => ({ id: s.id, title: s.title, tool: s.tool })),
          mode,
        });

        send({
          type: "plan",
          reply: plan.reply,
          notes: plan.notes ?? null,
          steps: plan.steps.map((s: PlanStep) => ({ id: s.id, title: s.title, tool: s.tool, kind: s.kind, summary: s.summary, targets: s.targets, risk: s.risk })),
          constraints: plan.constraints,
          jobId: job.id,
        });
        send({ type: "done", conversationId: convoId, jobId: job.id });
        finish();
      } catch (e) {
        const friendly =
          e instanceof AiProviderError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Code Giftz could not complete this request. Try again in a moment.";
        await persistAssistant(friendly, { error: true });
        send({ type: "error", message: friendly });
        finish();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

/**
 * GET /api/ai/design/chat[?conversationId=…] — conversation history.
 * Without `conversationId`: the user's conversations (latest first), titled
 * by their first user message. With it: that conversation's messages
 * (owner-scoped — another user's conversationId resolves to nothing).
 */
export const GET = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) {
    const rows = await db.designChatMessage.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 400,
    });
    const conversations = new Map<string, { conversationId: string; title: string; lastMessage: string; updatedAt: string; count: number }>();
    for (const row of rows) {
      const existing = conversations.get(row.conversationId);
      if (!existing) {
        conversations.set(row.conversationId, {
          conversationId: row.conversationId,
          title: "Website session",
          lastMessage: row.content.slice(0, 120),
          updatedAt: row.createdAt.toISOString(),
          count: 1,
        });
      } else {
        existing.count += 1;
      }
    }
    // Title each conversation by its OLDEST user message (the request that
    // started it) — rows arrive newest-first, so scan from the end.
    for (const convo of conversations.values()) {
      const oldestUser = [...rows].reverse().find((m) => m.conversationId === convo.conversationId && m.role === "USER");
      if (oldestUser) convo.title = oldestUser.content.slice(0, 64);
    }
    return NextResponse.json({
      conversations: [...conversations.values()].slice(0, 24),
    });
  }

  const owned = await db.designChatMessage.findFirst({
    where: { userId: user.id, conversationId },
    select: { id: true },
  });
  if (!owned) return err("That conversation does not exist for your account.", 404);

  const messages = await db.designChatMessage.findMany({
    where: { userId: user.id, conversationId },
    orderBy: { createdAt: "asc" },
    take: MAX_MESSAGES_PER_CONVERSATION,
  });
  return NextResponse.json({
    conversationId,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: m.metaJson ? JSON.parse(m.metaJson) : null,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

/** DELETE /api/ai/design/chat?conversationId=… — remove one conversation. */
export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) return err("conversationId is required.", 400);
  const res = await db.designChatMessage.deleteMany({ where: { userId: user.id, conversationId } });
  if (res.count === 0) return err("That conversation does not exist for your account.", 404);
  return NextResponse.json({ deleted: true });
});
