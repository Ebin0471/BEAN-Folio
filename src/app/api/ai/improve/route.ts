import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const improveSchema = z.object({
  field: z.enum(["description", "summary", "bio", "process", "outcome"]),
  content: z.string().trim().min(1).max(8000),
  projectContext: z.string().trim().max(2000).optional(),
});

const SYSTEM_PROMPT = `You are a professional portfolio copyeditor for BEAN Folio, a platform where professionals of EVERY kind showcase their work — designers, developers, journalists, doctors, architects, teachers, founders, researchers, tradespeople and more.
Improve the user's text for clarity, impact, and authenticity.
Rules:
- Keep the first person voice.
- Preserve the original meaning and every factual claim.
- NEVER invent credentials, metrics, employers, clients, dates, or any new claims.
- Match the register of a polished professional portfolio.
- When the project context names the creator's field or work type (e.g. a clinical record, a showreel, an architectural project, an API), use that profession's natural vocabulary and presentation conventions — clinical work reads like clinical documentation, engineering like an engineering write-up.
- Return ONLY the rewritten text — no preamble, no explanations, no quotes around the result.`;

/** POST /api/ai/improve — LLM copyedit of the user's own draft text (never auto-saved). */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, improveSchema);
  if (r.response) return r.response;
  const { field, content, projectContext } = r.data;

  const userMessage = [
    `Field to improve: ${field}`,
    "--- Text ---",
    content,
    "--- End of text ---",
    projectContext
      ? `Project context (reference only — do not introduce facts from it):
${projectContext}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text } = await aiComplete(SYSTEM_PROMPT, [{ role: "user", content: userMessage }]);

    await db.aiUsage.create({ data: { userId: user.id, feature: "improve" } });

    return ok({ text });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
