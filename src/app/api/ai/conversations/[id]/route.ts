import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import type { AiMessageDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/ai/conversations/:id — owner only; SYSTEM rows are never exposed. */
export const GET = handler(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
    const user = await getSessionUser();
    if (!user) return ERR.unauthorized();

    const { id } = await params;

    // Strict ownership — another user's conversation id is a 404.
    const conversation = await db.aiConversation.findFirst({
      where: { id, userId: user.id },
      include: {
        messages: {
          where: { role: { in: ["USER", "ASSISTANT"] } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!conversation) return ERR.notFound();

    const messages: AiMessageDTO[] = conversation.messages.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    }));

    return ok({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        messages,
      },
    });
  }
);
