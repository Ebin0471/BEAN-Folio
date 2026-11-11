import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError } from "@/lib/ai";
import { riisheSystemPrompt } from "@/lib/intelligence/personas";
import { buildPortfolioContext } from "@/lib/intelligence/context";
import { detectDelegationIntent, prepareDelegation } from "@/lib/intelligence/delegation";

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
    const { text: reply } = await aiComplete(
      systemPrompt,
      llmMessages.map((m) => ({ role: m.role, content: m.content })),
      { agent: "RIISHE", feature: "chat", userId: user.id }
    );

    // Cross-agent delegation (one hop, user-approved downstream): when the
    // message clearly asks for something a sibling agent owns, RIISHE
    // prepares a portfolio-grounded brief and records a durable AgentTask.
    // Nothing is generated or changed automatically — the user reviews and
    // executes in the target agent's studio.
    let delegation: Record<string, unknown> | undefined;
    const intent = detectDelegationIntent(message);
    if (intent) {
      try {
        const { taskId, plan } = await prepareDelegation(user, intent, message);
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

    return ok({ conversationId: conversation.id, reply, ...(delegation ? { delegation } : {}) });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
