import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { err, ERR, parseBody, handler } from "@/lib/api-helpers";
import { aiGate, aiStream, AiProviderError } from "@/lib/ai";
import { riisheSystemPrompt } from "@/lib/intelligence/personas";
import { buildPortfolioContext } from "@/lib/intelligence/context";
import { classifyMode, systemPromptWithMode } from "@/lib/riishe/modes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ai/chat/stream — Server-Sent-Events streaming variant of the
 * BEAN Intelligence chat used by the RIISHE assistant.
 *
 * Protocol (SSE):  data: {"delta":"text"}  …  data: {"done":true,"conversationId":"…"}
 *                  data: {"error":"message"} on failure.
 *
 * The provider is streamed through when the gateway answers with an event
 * stream; if it answers with plain JSON despite stream:true, the full reply is
 * forwarded as a single delta — the client experience is identical either way.
 * The reply is persisted only after the stream completes.
 */

const chatSchema = z.object({
  conversationId: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1).max(2000),
});

const MAX_HISTORY = 10;

/** Extract the incremental text from one gateway SSE line. */
function extractDelta(line: string): string {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: { content?: string }; message?: { content?: string } }[];
      content?: string;
      delta?: { content?: string };
    };
    return (
      json.choices?.[0]?.delta?.content ??
      json.choices?.[0]?.message?.content ??
      json.delta?.content ??
      (typeof json.content === "string" ? json.content : "") ??
      ""
    );
  } catch {
    // Gateway sent raw text instead of JSON frames — surface it verbatim.
    return payload;
  }
}

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, chatSchema);
  if (r.response) return r.response;
  const { conversationId, message } = r.data;

  let conversation;
  // Whether THIS request created the row — a failed turn must not leave an
  // empty orphan conversation behind in the owner's history list.
  let createdConversation = false;
  if (conversationId) {
    conversation = await db.aiConversation.findFirst({ where: { id: conversationId, userId: user.id } });
    if (!conversation) return ERR.notFound();
  } else {
    conversation = await db.aiConversation.create({ data: { userId: user.id, title: message.slice(0, 40) } });
    createdConversation = true;
  }

  // ---- Context: ONLY the user's own data (same contract as /api/ai/chat).
  // Shared builder + unified persona — RIISHE has ONE identity regardless of
  // entry point (defect fixed: this route previously carried an older persona
  // with a false provenance claim).
  const { profileBlock, projectsBlock, projects } = await buildPortfolioContext(user);

  // Response loop (B1): the active response mode shapes prompt emphasis.
  // Execution intent detection is deliberately NOT repeated here — the
  // non-streaming chat route is the action path; streaming stays advisory.
  const systemPrompt = systemPromptWithMode(
    riisheSystemPrompt(profileBlock, projectsBlock, projects.length),
    classifyMode(message)
  );

  const history = await db.aiMessage.findMany({
    where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: MAX_HISTORY,
  });
  history.reverse();

  const llmMessages = [
    ...history.map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content })),
    { role: "user" as const, content: message },
  ];

  const conversationIdForClient = conversation.id;

  const encoder = new TextEncoder();
  const sse = (obj: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      let failed = false;
      try {
        // Streamed through the shared gateway (same contract as aiComplete).
        const result = (await aiStream(systemPrompt, llmMessages, {
          agent: "RIISHE",
          feature: "chat-stream",
          userId: user.id,
        })) as unknown;

        if (result instanceof ReadableStream || (result && typeof (result as ReadableStream).getReader === "function")) {
          const reader = (result as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const deadline = Date.now() + 55_000;
          for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            // Race each read against the remaining deadline: a provider stream
            // that stops sending bytes (and never closes) must not hold this
            // route — and the client's loading state — open forever.
            let timedOut = false;
            const readResult = await Promise.race([
              reader.read(),
              new Promise<"timeout">((resolve) => setTimeout(() => { timedOut = true; resolve("timeout"); }, remaining)),
            ]);
            if (readResult === "timeout" || timedOut) {
              void reader.cancel().catch(() => undefined);
              break;
            }
            const { done, value } = readResult;
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const delta = extractDelta(line);
              if (delta) {
                full += delta;
                controller.enqueue(sse({ delta }));
              }
            }
          }
          if (buffer) {
            const delta = extractDelta(buffer);
            if (delta) {
              full += delta;
              controller.enqueue(sse({ delta }));
            }
          }
        } else {
          // Non-streaming fallback: gateway answered with a plain completion JSON.
          const completion = result as { choices?: { message?: { content?: string } }[] };
          const text = completion?.choices?.[0]?.message?.content?.trim() ?? "";
          if (!text) throw new Error("empty response");
          full = text;
          controller.enqueue(sse({ delta: text }));
        }

        if (full.trim()) {
          await db.aiMessage.createMany({
            data: [
              { conversationId: conversation.id, role: "USER", content: message },
              { conversationId: conversation.id, role: "ASSISTANT", content: full },
            ],
          });
          await db.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
          await db.aiUsage.create({ data: { userId: user.id, feature: "chat" } });
        }
        controller.enqueue(sse({ done: true, conversationId: conversationIdForClient }));
      } catch (e) {
        failed = true;
        const errMsg =
          e instanceof AiProviderError
            ? e.message
            : "The AI service is unavailable right now. Please try again shortly.";
        // Persist what streamed so nothing the user saw disappears from history.
        if (full.trim()) {
          await db.aiMessage
            .createMany({
              data: [
                { conversationId: conversation.id, role: "USER", content: message },
                { conversationId: conversation.id, role: "ASSISTANT", content: full },
              ],
            })
            .catch(() => undefined);
        } else if (createdConversation) {
          // Nothing streamed and the row was created by this request — remove
          // the empty orphan so the history list stays clean.
          const orphaned = await db.aiMessage.count({ where: { conversationId: conversation.id } }).catch(() => 1);
          if (orphaned === 0) {
            await db.aiConversation.delete({ where: { id: conversation.id } }).catch(() => undefined);
          }
        }
        controller.enqueue(sse({ error: errMsg }));
      } finally {
        void failed;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  }) as unknown as NextResponse;
});
