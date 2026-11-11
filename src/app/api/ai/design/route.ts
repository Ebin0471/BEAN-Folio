import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError, parseJsonFromText } from "@/lib/ai";
import { siteConfigSchema, SECTION_TYPES, HERO_VARIANTS, TEMPLATE_IDS, designPresets, normalizeConfig } from "@/lib/site-config";
import { SITE_FONTS, resolveFont } from "@/lib/site-fonts";
import { PALETTES } from "@/lib/site-palettes";
import { motionPresetsByScope, MOTION_EASING_IDS, getMotionPreset } from "@/lib/site-motion";
import type { SiteConfig } from "@/lib/site-config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

const designSchema = z.object({
  request: z.string().trim().min(3).max(1000),
  /** "edit" returns a config proposal; "audit" returns findings only. */
  mode: z.enum(["edit", "audit"]).default("edit"),
  /** The builder's current config (unsaved canvas state included). */
  currentConfig: siteConfigSchema,
  /** Optional follow-up context from a previous proposal (refine loop). */
  previousProposal: siteConfigSchema.nullish(),
  context: contextSchema,
  /** Recent conversation turns (oldest first, already trimmed by the client). */
  history: z.array(historyItemSchema).max(8).default([]),
});

/**
 * POST /api/ai/design — Code Giftz: the website-design agent inside Website
 * Studio. A DISTINCT agent from RIISHE (the general assistant at
 * #/intelligence): it shares only the server-side GLM gateway (`aiComplete`)
 * and the consent/quota gate (`aiGate`) — its persona, context and permissions
 * are its own. Code Giftz is responsible for website design only (layouts,
 * sections, tokens, typography, spacing, motion, templates, responsive and
 * accessibility review); general questions belong to RIISHE.
 *
 * edit mode  → a STRUCTURED, schema-validated config proposal. Never persisted
 *              or published here — the builder previews it until the user
 *              accepts it as a draft.
 * audit mode → findings and recommendations only; never a config.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, designSchema);
  if (r.response) return r.response;
  const { request, mode, previousProposal, context, history } = r.data;
  const current = normalizeConfig(r.data.currentConfig);
  if (!current) return err("The current website configuration is invalid.", 400);

  // ---- Context: the user's own portfolio data (authorized, server-fetched). ----
  const [professions, skills, projects, site] = await Promise.all([
    db.profileProfession.findMany({ where: { userId: user.id }, include: { profession: true } }),
    db.profileSkill.findMany({ where: { userId: user.id }, include: { skill: true } }),
    db.project.findMany({
      where: { ownerId: user.id, status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
      take: 12,
      select: { title: true, category: true, summary: true },
    }),
    db.siteDesign.findUnique({ where: { userId: user.id } }),
  ]);

  const portfolioBlock = [
    `- Name: ${user.name}`,
    `- Headline: ${user.headline ?? "(not set)"}`,
    `- Location: ${user.location ?? "(not set)"}`,
    `- Bio: ${(user.bio ?? "(not set)").slice(0, 400)}`,
    `- Professions: ${professions.map((p) => p.profession.slug).join(", ") || "(none)"}`,
    `- Skills: ${skills.map((s) => s.skill.label).slice(0, 15).join(", ") || "(none)"}`,
    `- Published projects (${projects.length}): ${projects.map((p) => `"${p.title}" [${p.category ?? "no category"}]`).join(", ") || "(none)"}`,
    `- Website publish state: ${site?.status ?? "never published"}`,
  ].join("\n");

  const contextBlock = context
    ? `\n\nWhere the user is looking right now:
- Preview device: ${context.device ?? "desktop"}
- Current page: ${context.pageName ?? "(home)"}
- Selected section: ${context.sectionType ?? "(none)"}${context.sectionTitle ? ` ("${context.sectionTitle}")` : ""}`
    : "";

  const historyBlock =
    history.length > 0
      ? `\n\nRecent conversation (oldest first):\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}`
      : "";

  const schemaDoc = `SiteConfig rules (STRICT — never invent fields outside this schema):
- version stays 2. template is one of: ${TEMPLATE_IDS.join(", ")}.
- name: 1-80 chars. tagline: optional, <=160 chars.
- pages: 1-8 items, each { id (short unique string), name (1-60 chars, shown in site nav), visible (boolean), sections (1-12 sections) }.
  Multi-page requests create additional pages; the first page is the home page. Keep unchanged pages byte-identical.
- Each section: unique id (any short string), type (one of: ${SECTION_TYPES.join(", ")}), visible (boolean), title (1-120 chars), and optional motion override { preset, duration (150-1200), intensity (0-100), stagger (0-240), disabled } — omit it unless the user asks for per-section animation.
  - hero: subtitle (<=280), variant ("${HERO_VARIANTS.join('" | "')}"), ctaLabel (<=40, empty = no button).
  - about: body (<=4000; "{bio}", "{name}", "{headline}", "{location}", "{availability}" placeholders allowed).
  - projects: limit (1-24), layout ("grid" | "featured" | "list" | "editorial"), category (empty or a category slug like "writing" or "software-dev" to filter).
  - collections: limit (1-12).
  - contact: body (<=1200; "{availability}" inserts availability).
  - services: layout ("cards" | "rows"), items: 0-8 of { title (1-80), description (<=300) }.
  - experience: layout ("timeline" | "rows"), entries: 0-10 of { role (1-80), org (<=80), period (<=40), description (<=400) }.
  - gallery: source ("projects" | "collections"), limit (1-24), layout ("masonry" | "grid" | "strip").
  - testimonials: layout ("cards" | "stack"), items: 0-8 of { quote (1-500), name (1-80), role (<=80) }.
    Only suggest testimonials as EMPTY containers the user fills with genuine quotes — never invent quotes, names or metrics.
  - skills and stats sections have no extra fields (they render real profile data).
- theme color tokens: background, foreground, accent, accent2, surface, border, muted, focus (hex like "#0a0a0c"); gradient null or { from, to, angle (0-360) }; surfaceOpacity (20-100, 100 = solid cards).
- fonts: headingFont/bodyFont/accentFont/codeFont must be an id from this library (use sparingly — change only when the user asks for type changes; keep the same id unless they do): ${SITE_FONTS.map((f) => f.id).join(", ")}.
- Curated color systems (apply by copying their tokens when the user asks for a palette): ${PALETTES.map((p) => `${p.id}`).join(", ")}.
- radius "none"|"md"|"full"; density "compact"|"regular"|"relaxed"; typeScale "intimate"|"balanced"|"grand"; lineHeight "tight"|"normal"|"relaxed"; letterSpacing "tight"|"normal"|"wide"; headingWeight "light"|"semibold"|"bold"; contentWidth "narrow"|"regular"|"wide"; columns 0|2|3; buttonStyle "sharp"|"rounded"|"pill"|"outline"; linkStyle "underline"|"accent"|"plain"; imageRatio "4/3"|"3/2"|"1/1"|"16/9"; divider "none"|"line"|"accent"; pageTransition "none"|"fade"|"slide"|"rise"|"zoom"; navLayout "inline"|"stacked"|"centered"; headingAlign "left"|"center".
- glass (only when the user asks for glassmorphism): { enabled (boolean), preset ("frosted"|"smoked"|"crystal"|"aurora"|"soft"|"dark"|"custom"), targets { nav, cards, buttons }, blur (0-40), opacity (0-90), tint (hex), borderOpacity (0-100), borderWidth (0-4), highlight (0-100), shadow (0-100), gradient (boolean) }.
- motion: { enabled (boolean), preset (one of the reveal presets: ${motionPresetsByScope("reveal").map((p) => p.id).join(", ")}), duration (150-1200 ms), stagger (0-240 ms), easing ("${MOTION_EASING_IDS.join('" | "')}"), intensity (0-100), hoverEffects (boolean), scrollReveal (boolean), once (boolean), background (one of: ${motionPresetsByScope("background").map((p) => p.id).join(", ")}), microInteractions (one of: ${motionPresetsByScope("hover").map((p) => p.id).join(", ")}) }.
  Keep motion restrained: presets "fadeUp", "subtle-rise" or "stagger" with duration <=700 and intensity <=70 are the sane default. Honor the user's request, but never stack heavy effects.
- Curated design presets (token sets you may apply when the user asks for a direction): ${designPresets().map((p) => `${p.id} (${p.label})`).join(", ")}.`;

const systemPrompt = `You are Code Giftz, the website-design agent inside the BEAN Folio "Website Studio" editor.
You are a distinct agent from RIISHE (the general assistant in BEAN Intelligence chat): RIISHE handles general questions, research, writing and career advice — you handle ONLY the design of this website.
You receive the user's current website configuration (JSON), where they are looking, a natural-language design request, and their own portfolio context (they consented to AI features).
You run on the shared server-side AI provider. Report honestly: never claim to have run code, tests, or a browser you do not have; never fabricate portfolio facts, metrics, testimonials or achievements; you never publish, save or delete anything — you only propose changes the user reviews.

${mode === "audit"
  ? `AUDIT MODE — do NOT return a config. Inspect the configuration like a design reviewer and answer with ONE JSON object:
{ "reply": "one or two sentences of overall assessment", "findings": ["specific, actionable finding", ...] }
Findings must reference concrete tokens/sections/values from the config (spacing, contrast, typography consistency, section order for the user's profession, excessive animation, redundancy, responsive risk). 3-8 findings, most important first, each one sentence. Never invent facts about the user's content.`
  : `EDIT MODE — apply the requested design changes and answer with ONE JSON object:
{
  "changes": ["short human-readable summary of each change", ...],
  "reply": "one or two friendly sentences explaining the proposal",
  "config": { ...the complete next SiteConfig... }
}
If the request is ambiguous or would destroy meaningful content, return the SAME object but OMIT "config" and "changes", and ask ONE clarifying question in "reply".
Scope guard 1 (design only): if the request is a general question or task that is NOT a change to this website — research, writing, career advice, platform questions — do NOT return "config" or "changes"; answer briefly in "reply" (two sentences max) and remind the user that general questions belong to RIISHE in BEAN Intelligence.
Scope guard 2 (surgical edits): if the user asks to change one section or one token, preserve every unrelated section, page and token exactly (byte-identical). Keep section/page ids stable when content is unchanged.
${schemaDoc}

The user's portfolio context (their own data):
${portfolioBlock}`
}
${mode === "audit" ? `The user's portfolio context (their own data):\n${portfolioBlock}` : ""}`;

  const userContent = [
    `Current config:\n${JSON.stringify(current)}`,
    previousProposal ? `Previous proposal I want refined:\n${JSON.stringify(previousProposal)}` : null,
    `Request (${mode}): ${request}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const { text } = await aiComplete(systemPrompt, [{ role: "user", content: userContent }], {
      temperature: 0.4,
    });

    const parsed = parseJsonFromText<{
      changes?: unknown;
      reply?: unknown;
      config?: unknown;
      findings?: unknown;
    }>(text);
    if (!parsed || typeof parsed !== "object") {
      return err("Code Giftz returned an unreadable response. Try rephrasing the request.", 502);
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, 600) : "";

    if (mode === "audit") {
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings.filter((f): f is string => typeof f === "string" && f.length > 0).slice(0, 8)
        : [];
      await db.aiUsage.create({ data: { userId: user.id, feature: "design" } });
      return ok({ reply, findings });
    }

    // Ambiguity escape hatch: the model asked a clarifying question instead.
    if (parsed.config === undefined || parsed.config === null) {
      await db.aiUsage.create({ data: { userId: user.id, feature: "design" } });
      return ok({ reply: reply || "Could you clarify what you'd like changed?" });
    }

    // Hard schema validation — malformed AI output never reaches the canvas.
    const configCheck = siteConfigSchema.safeParse(parsed.config);
    if (!configCheck.success) {
      return err("The proposal did not match the website schema. Try a more specific request.", 502);
    }
    const proposed = normalizeConfig(configCheck.data);
    if (!proposed) {
      return err("The proposal did not match the website schema. Try a more specific request.", 502);
    }

    const changes = Array.isArray(parsed.changes)
      ? parsed.changes.filter((c): c is string => typeof c === "string" && c.length > 0).slice(0, 12)
      : summarizeChanges(current, proposed);

    await db.aiUsage.create({ data: { userId: user.id, feature: "design" } });

    return ok({ config: proposed, changes, reply });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});

/** Deterministic fallback diff when the model omitted the change list. */
function summarizeChanges(before: SiteConfig, after: SiteConfig): string[] {
  const out: string[] = [];
  if (before.template !== after.template) out.push(`Switched template to ${after.template}.`);
  if (before.name !== after.name) out.push(`Renamed the website to “${after.name}”.`);
  if (before.tagline !== after.tagline) out.push("Updated the tagline.");
  for (const key of Object.keys(before.theme) as (keyof SiteConfig["theme"])[]) {
    if (before.theme[key] !== after.theme[key]) out.push(`Updated ${String(key)} in the design tokens.`);
  }
  for (const key of Object.keys(before.motion) as (keyof SiteConfig["motion"])[]) {
    if (before.motion[key] !== after.motion[key]) out.push(`Updated motion setting “${String(key)}”.`);
  }
  const beforePages = new Map(before.pages.map((p) => [p.id, p]));
  for (const page of after.pages) {
    const bp = beforePages.get(page.id);
    if (!bp) {
      out.push(`Added the page “${page.name}”.`);
      continue;
    }
    if (bp.name !== page.name) out.push(`Renamed the page to “${page.name}”.`);
    const beforeIds = new Map(bp.sections.map((s) => [s.id, s]));
    const afterIds = new Map(page.sections.map((s) => [s.id, s]));
    for (const s of page.sections) {
      if (!beforeIds.has(s.id)) out.push(`Added a ${s.type} section (“${s.title}”) on “${page.name}”.`);
      else if (JSON.stringify(beforeIds.get(s.id)) !== JSON.stringify(s)) out.push(`Updated the ${s.type} section (“${s.title}”).`);
    }
    for (const s of bp.sections) if (!afterIds.has(s.id)) out.push(`Removed the ${s.type} section (“${s.title}”).`);
  }
  for (const p of before.pages) if (!after.pages.some((ap) => ap.id === p.id)) out.push(`Removed the page “${p.name}”.`);
  return out.length > 0 ? out : ["Adjusted the website configuration."];
}
