import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError } from "@/lib/ai";
import { riisheSystemPrompt } from "@/lib/intelligence/personas";
import { buildPortfolioContext } from "@/lib/intelligence/context";
import { detectDelegationIntent, prepareDelegation } from "@/lib/intelligence/delegation";
import { runAutomationIntent, detectAutomationIntent } from "@/lib/riishe/actions";
import { looksLikeWorkflow, planAndCreateWorkflow } from "@/lib/riishe/planner";
import type { RiisheActionCard } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const chatSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1).max(2000),
});

const MAX_HISTORY = 10;

/** POST /api/ai/chat — RIISHE, the GENERAL assistant (BEAN Intelligence). Advisory only. */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, chatSchema);
  if (r.response) return r.response;
  const { conversationId, message } = r.data;

  // Resolve or create the conversation (strict ownership).
  let conversation;
  if (conversationId) {
    conversation = await db.aiConversation.findFirst({
      where: { id: conversationId, userId: user.id },
    });
    if (!conversation) return ERR.notFound();
  } else {
    conversation = await db.aiConversation.create({
      data: { userId: user.id, title: message.slice(0, 40) },
    });
  }

  // ---- Context: ONLY the user's own data, never anyone else's. ----
  // Shared builder (src/lib/intelligence/context.ts) — the same authorized
  // portfolio context as every other RIISHE surface.
  const { profileBlock, projectsBlock, projects } = await buildPortfolioContext(user);

  const systemPrompt = riisheSystemPrompt(profileBlock, projectsBlock, projects.length);

  // Recent history for continuity (only USER/ASSISTANT rows).
  const history = await db.aiMessage.findMany({
    where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY,
  });
  history.reverse();

  const llmMessages = [
    ...history.map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: message },
  ];

  try {
    // ---- Automation intents (additive; delegation above keeps precedence).
    // When the message asks RIISHE to DO something inside the platform
    // (discover creators, prepare enquiries, schedule reminders, run
    // reports…), the automation layer executes it against real data and
    // returns a grounded reply + a structured action card for the existing
    // renderer. Every external side effect (sending an enquiry) still
    // requires an explicit confirmation afterwards. A bookkeeping failure
    // here falls back to the normal advisory chat path below — never a
    // failed turn.
    let automationOutcome: Awaited<ReturnType<typeof runAutomationIntent>> | null = null;
    let workflowCard: Extract<RiisheActionCard, { kind: "workflow" }> | null = null;
    const delegationIntent = detectDelegationIntent(message);
    if (!delegationIntent) {
      // Advanced agent path: multi-step goals become a VALIDATED, registry-
      // checked plan persisted as a real workflow. Execution runs through the
      // tool registry on the durable queue — never via model output alone.
      if (looksLikeWorkflow(message)) {
        try {
          const workflow = await planAndCreateWorkflow(user, message, {
            conversationId: conversation.id,
          });
          if (workflow) {
            workflowCard = { kind: "workflow", workflow };
          }
        } catch (e) {
          console.error("[ai-chat] workflow planning failed, falling back:", e instanceof Error ? e.message : e);
        }
      }
      if (!workflowCard) {
        const automationIntent = detectAutomationIntent(message);
        if (automationIntent) {
          try {
            automationOutcome = await runAutomationIntent(user, automationIntent);
          } catch (e) {
            console.error("[ai-chat] automation intent failed, falling back to advisory chat:", e instanceof Error ? e.message : e);
          }
        }
      }
    }

    const workflowGrounding = workflowCard
      ? [
          "WORKFLOW MODE — a real automation workflow was just created from the user's goal.",
          `Title: ${workflowCard.workflow.title}`,
          workflowCard.workflow.summary ? `Summary: ${workflowCard.workflow.summary}` : "",
          "Steps (execution runs on the durable queue through registered tools; every action is verified server-side):",
          ...workflowCard.workflow.steps.map(
            (s, i) =>
              `${i + 1}. ${s.title} [${s.tool}, risk ${s.risk}${s.requiresApproval ? ", needs explicit confirmation" : ""}${s.scheduledFor ? ", scheduled for later" : ""}]`
          ),
          "Explain the plan and note which steps need explicit confirmation. Results will be reported from real execution records — do not claim anything has executed beyond the plan itself.",
        ]
          .filter(Boolean)
          .join("\n")
      : null;

    const replySystemPrompt = workflowGrounding
      ? `${systemPrompt}

${workflowGrounding}`
      : automationOutcome
        ? `${systemPrompt}

AUTOMATION MODE — the user's request was executed against their real BEAN Folio data. Reply STRICTLY inside this grounding block:
${automationOutcome.grounding}

${automationOutcome.replyInstruction}`
        : systemPrompt;

    const { text: reply } = await aiComplete(
      replySystemPrompt,
      llmMessages.map((m) => ({ role: m.role, content: m.content })),
      { agent: "RIISHE", feature: "chat", userId: user.id }
    );

    // Cross-agent delegation (one hop, user-approved downstream): when the
    // message clearly asks for something a sibling agent owns, RIISHE
    // prepares a portfolio-grounded brief and records a durable AgentTask.
    // Nothing is generated or changed automatically — the user reviews and
    // executes in the target agent's studio.
    let delegation: Record<string, unknown> | undefined;
    if (delegationIntent) {
      try {
        const { taskId, plan } = await prepareDelegation(user, delegationIntent, message);
        delegation = {
          taskId,
          kind: plan.kind,
          targetAgent: plan.targetAgent,
          brief: plan.brief,
          destinationUrl: plan.destinationUrl,
          destinationLabel: plan.destinationLabel,
        };
      } catch (e) {
        // Delegation is an enhancement — a bookkeeping failure must not fail
        // an otherwise-successful chat turn.
        console.error("[ai-chat] delegation preparation failed:", e instanceof Error ? e.message : e);
      }
    }

    await db.aiMessage.createMany({
      data: [
        { conversationId: conversation.id, role: "USER", content: message },
        { conversationId: conversation.id, role: "ASSISTANT", content: reply },
      ],
    });

    // Touch the conversation so it sorts to the top of recency lists.
    await db.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    await db.aiUsage.create({ data: { userId: user.id, feature: "chat" } });

    return ok({
      conversationId: conversation.id,
      reply,
      ...(delegation ? { delegation } : {}),
      ...(automationOutcome ? { automation: automationOutcome.action } : {}),
      ...(workflowCard ? { automation: workflowCard } : {}),
    });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
