import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError, parseJsonFromText } from "@/lib/ai";
import { ensurePortfolio, validateConfig } from "@/lib/portfolio-server";
import { portfolioConfigSchema, SECTION_TYPES, WIDGET_TYPES } from "@/lib/portfolio-schema";
import { TEMPLATES } from "@/components/bean/portfolio/templates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ai/portfolio/design — the Portfolio Studio's Code Giftz AI
 * designer (M0.5 Stage F reconnection).
 *
 * This route restores the contract the studio's AiDesignerDialog has always
 * spoken ({ prompt, pageId, selection } → { summary, rationale, config }) —
 * the SAME shape it used when the feature was first built. The shared
 * `/api/ai/design` route now owns the WEBSITE Studio (SiteDesign) contract
 * and validates `siteConfigSchema`, so the two agents are cleanly separated:
 * both share only the server-side gateway (`aiComplete`), the consent/quota
 * gate (`aiGate`) and the JSON extraction helper — personas, context and
 * permissions are their own. The dialog's implementation is untouched; only
 * its endpoint constant points here.
 *
 * The current draft is loaded SERVER-SIDE (the dialog never uploads the
 * config) — the user can only ever edit their own portfolio (1:1 by session).
 * The proposal is NEVER persisted or published here: the studio previews it
 * and the user explicitly applies + saves + publishes.
 */

const bodySchema = z.object({
  prompt: z.string().trim().min(3).max(1000),
  pageId: z.string().max(40).default(""),
  selection: z.string().max(40).nullable().default(null),
});

const proposalSchema = z.object({
  summary: z.string().max(600),
  rationale: z.string().max(2000),
  config: portfolioConfigSchema,
});

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const { prompt, pageId, selection } = r.data;

  // ---- Context: the user's own portfolio (authorized, server-fetched). ----
  const row = await ensurePortfolio(user);
  if (!row) {
    return err("A username is required before the portfolio can be designed. Set one in My Folio first.", 400);
  }
  const currentCheck = validateConfig(JSON.parse(row.draft));
  if (!currentCheck.ok) return err("The current portfolio configuration is invalid.", 400);
  const current = JSON.parse(currentCheck.json);
  const activePage = pageId
    ? (current.pages as Array<{ id: string; name?: string; slug?: string }>).find((p) => p.id === pageId)
    : undefined;

  const schemaDoc = `PortfolioConfig rules (STRICT — never invent fields outside this schema):
- version stays 2. templateId is one of: ${TEMPLATES.map((t) => t.id).join(", ")}.
- pages: 1-12 items, each { id (short unique string), name (<=60), slug ("home" for the home page, 3-24 slug chars otherwise), isHome (exactly one true), inNav (boolean), isPublished (boolean), seoTitle (<=120, optional), seoDescription (<=200, optional), hero (object), sections (0-24) }.
  Keep unchanged pages byte-identical and preserve page/section ids when content is unchanged.
- Each section: unique id (any short string), type (one of: ${SECTION_TYPES.join(", ")}), title (<=120), and a "data" object whose shape depends on the type. Never fabricate testimonials, metrics or achievements — leave containers empty for the user to fill.
- Optional widgets: an "id", type (one of: ${WIDGET_TYPES.slice(0, 12).join(", ")}, …) and their own data — add widgets only when the user asks for dynamic content.
- theme: tokens as hex colors (background, foreground, accent, …), font choices and radii — change only when the user asks for a style change.
- layout/motion: keep restrained; honor the user's request without stacking heavy effects.
- The whole config must stay under 200 KB of JSON.`;

  const systemPrompt = `You are Code Giftz, the portfolio-design agent inside the BEAN Folio "Portfolio Studio" editor.
You are a distinct agent from RIISHE (the general assistant in BEAN Intelligence chat): RIISHE handles general questions, research and career advice — you handle ONLY the design of this portfolio website.
You receive the user's current portfolio configuration (JSON), which page they are editing, what section is selected (if any), and a natural-language design request (they consented to AI features).
You run on the shared server-side AI provider. Report honestly: never claim to have run code, tests, or a browser you do not have; never fabricate portfolio facts, metrics, testimonials or achievements; you never publish, save or delete anything — you only propose changes the user reviews.

EDIT MODE — apply the requested design changes and answer with ONE JSON object:
{
  "summary": "one or two friendly sentences explaining the proposal",
  "rationale": "short bullet-style reasoning: what you changed and why it serves the request",
  "config": { ...the complete next PortfolioConfig... }
}
If the request is ambiguous or would destroy meaningful content, return the SAME object but OMIT "config", and ask ONE clarifying question in "summary".
Scope guard 1 (design only): if the request is a general question that is NOT a change to this portfolio, do NOT return "config"; answer briefly in "summary" and remind the user that general questions belong to RIISHE in BEAN Intelligence.
Scope guard 2 (surgical edits): if the user asks to change one section or one token, preserve every unrelated section, page and token exactly (byte-identical). Keep ids stable when content is unchanged.
${schemaDoc}`;

  const userContent = [
    `Current config:\n${JSON.stringify(current)}`,
    activePage ? `Page being edited: "${activePage.name ?? activePage.slug ?? pageId}" (id ${pageId}).` : null,
    selection ? `Selected section type: ${selection}.` : null,
    `Request: ${prompt}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { text } = await aiComplete(systemPrompt, [{ role: "user", content: userContent }], {
      temperature: 0.4,
      feature: "portfolio-design",
      userId: user.id,
    });

    const parsed = parseJsonFromText<{
      summary?: unknown;
      rationale?: unknown;
      config?: unknown;
    }>(text);
    if (!parsed || typeof parsed !== "object") {
      return err("Code Giftz returned an unreadable response. Try rephrasing the request.", 502);
    }

    // Ambiguity escape hatch: the model asked a clarifying question instead.
    if (parsed.config === undefined || parsed.config === null) {
      return ok({
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 600) : "Could you clarify what you'd like changed?",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 2000) : "",
      });
    }

    // Hard schema validation — malformed AI output never reaches the canvas.
    const check = proposalSchema.safeParse({
      summary: parsed.summary ?? "",
      rationale: parsed.rationale ?? "",
      config: parsed.config,
    });
    if (!check.success) {
      return err("The proposal did not match the portfolio schema. Try a more specific request.", 502);
    }

    return ok({ summary: check.data.summary, rationale: check.data.rationale, config: check.data.config });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
