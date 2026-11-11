import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError, parseJsonFromText } from "@/lib/ai";
import { listFlat } from "@/lib/professions/service";
import { mergedPlaybookGuidance } from "@/lib/professions/playbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const suggestSchema = z.object({
  projectId: z.string().trim().min(1).optional(),
  title: z.string().trim().max(140).optional(),
  description: z.string().trim().max(8000).optional(),
});

/**
 * BEAN Intelligence metadata suggestions — UNIVERSAL, profession-aware.
 *
 * The category whitelist is the LIVE profession taxonomy (DB-backed, seeded
 * on read) rather than a frozen legacy list, so every profession in the
 * registry can be suggested. Grounding uses the same family playbooks that
 * power Code Giftz: content types and anti-fabrication rules follow the
 * user's DECLARED professions (read server-side from their profile — client
 * input is never trusted for identity or profession).
 */
function buildSystemPrompt(categorySlugs: string[], guidance: string | null): string {
  const slugList = categorySlugs.join(", ");
  return `You are the metadata assistant for BEAN Folio, a portfolio platform for professionals of every kind — designers, developers, journalists, doctors, architects, teachers, founders, researchers, tradespeople and more.
Based ONLY on the provided content (never invent facts, clients, metrics or credentials), return STRICT JSON — no markdown, no commentary — with exactly this shape:
{ "summary": string (a compelling one-liner for the project, at most 180 characters),
  "skills": string[] (3 to 8 short skill labels relevant to the work),
  "category": string (exactly one of these profession slugs: ${slugList}) }${
    guidance ? `\n\nProfession guidance for this user (suggestions, not requirements — their real data is authoritative):\n${guidance}` : ""
  }`;
}

type SuggestedMeta = {
  summary: string;
  skills: string[];
  category: string | null;
};

function coerceMeta(raw: unknown, validSlugs: Set<string>): SuggestedMeta {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const summary =
    typeof obj.summary === "string" && obj.summary.trim()
      ? obj.summary.trim().slice(0, 200)
      : "";

  const skills = Array.isArray(obj.skills)
    ? obj.skills
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 40))
        .slice(0, 10)
    : [];

  const category =
    typeof obj.category === "string" && validSlugs.has(obj.category) ? obj.category : null;

  return { summary, skills, category };
}

/** POST /api/ai/suggest — propose summary/skills/category from the user's own draft. */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, suggestSchema);
  if (r.response) return r.response;
  const { projectId, title, description } = r.data;

  let inputTitle = title ?? "";
  let inputDescription = description ?? "";
  let inputCategory: string | null = null;

  if (projectId) {
    // Only the user's OWN project can be used as input.
    const project = await db.project.findFirst({
      where: { id: projectId, ownerId: user.id },
    });
    if (!project) return ERR.notFound();
    inputTitle = project.title;
    inputDescription = project.description ?? "";
    inputCategory = project.category;
  }

  if (!inputTitle && !inputDescription) {
    return err("Provide a title or description (or a projectId)", 400);
  }

  // Live taxonomy (cached; seeds itself on a cold deploy) + the user's real
  // declared professions for grounding. DB failures degrade, never 500:
  // an empty whitelist simply disables category suggestions this request.
  const [flat, professionRows] = await Promise.all([
    listFlat().catch(() => [] as { slug: string }[]),
    db.user
      .findUnique({
        where: { id: user.id },
        select: { professions: { include: { profession: { select: { slug: true } } }, orderBy: { profession: { order: "asc" } } } },
      })
      .catch(() => null),
  ]);
  const validSlugs = new Set(flat.map((p) => p.slug));
  const userProfessionSlugs = (professionRows?.professions ?? []).map((p) => p.profession.slug);
  const guidance = mergedPlaybookGuidance(userProfessionSlugs);

  const userMessage = [
    inputCategory ? `Current category: ${inputCategory}` : "",
    userProfessionSlugs.length > 0 ? `The creator's declared professions: ${userProfessionSlugs.join(", ")}` : "",
    `Title: ${inputTitle || "(none)"}`,
    `Description: ${inputDescription ? inputDescription.slice(0, 4000) : "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text } = await aiComplete(buildSystemPrompt([...validSlugs], guidance), [
      { role: "user", content: userMessage },
    ]);
    const parsed = parseJsonFromText<unknown>(text);
    if (!parsed) {
      return err("The AI returned an unexpected format. Try again.", 502);
    }

    await db.aiUsage.create({ data: { userId: user.id, feature: "suggest" } });

    return ok(coerceMeta(parsed, validSlugs));
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
