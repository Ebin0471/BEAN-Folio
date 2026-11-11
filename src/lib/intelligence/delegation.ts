/**
 * BEAN Intelligence — cross-agent delegation (Phase 5 protocol, one-hop;
 * Phase 3: structured design-brief handoff into LAXII).
 *
 * RIISHE recognises when a request belongs to a sibling agent, prepares the
 * structured handoff (with portfolio-grounded content), records a durable
 * AgentTask row (survives restarts), and returns it for the UI to present.
 *
 * Hard rules:
 *  - ONE hop: RIISHE creates a task for LAXII or Code Giftz; it never chains
 *    agent→agent→agent and never runs an autonomous loop.
 *  - Nothing destructive or externally visible happens automatically: the
 *    receiving agent's studio is opened with the prepared brief and the USER
 *    approves/creates there (generation, publishing remain user actions).
 *  - The brief uses ONLY the signed-in user's own authorized data.
 *  - LAXII receives the STRUCTURED brief object (schema-validated), not just a
 *    shortened natural-language summary — the human-readable paragraph is
 *    derived FROM the structure so they can never drift apart.
 */

import { db } from "@/lib/db";
import type { User } from "@prisma/client";
import { buildPortfolioContext } from "./context";
import { logGatewayEvent } from "./observability";

import {
  appendRevision,
  parseDesignBrief,
  type DesignBrief,
  type BriefRevision,
} from "@/lib/laxii/design-brief";
import { BANNER_PRESETS } from "@/lib/laxii/banner-presets";

export type DelegationKind = "BANNER_DESIGN" | "AVATAR_DESIGN" | "WEBSITE_DESIGN";

/** Persisted AgentTask.resultJson payload (superset — legacy consumers read `brief`). */
export interface AgentTaskResult {
  brief: string;
  structuredBrief?: DesignBrief;
  destinationUrl: string;
  destinationLabel: string;
}

export interface DelegationPlan {
  kind: DelegationKind;
  /** Agent that receives the task. */
  targetAgent: "LAXII" | "CODE_GIFTZ";
  title: string;
  /** Prepared, structured brief the target agent starts from. */
  brief: string;
  /** Where the user approves/executes the task. */
  destinationUrl: string;
  destinationLabel: string;
}

interface IntentRule {
  kind: DelegationKind;
  targetAgent: DelegationPlan["targetAgent"];
  destinationUrl: string;
  destinationLabel: string;
  patterns: RegExp[];
  negations?: RegExp[];
}

/**
 * Detection is intentionally conservative: clear creation requests only.
 * Questions ("what size should a banner be?") do not create tasks — the
 * negation patterns keep advisory questions advisory.
 */
const RULES: IntentRule[] = [
  {
    kind: "WEBSITE_DESIGN",
    targetAgent: "CODE_GIFTZ",
    destinationUrl: "#/studio/site",
    destinationLabel: "Open Website Studio → GIFTZ",
    patterns: [
      /\b(redesign|restyle|rebuild|restructure|design|customize|customise)\b[^.?!]*\b(my|the)\b[^.?!]*\b(website|portfolio site|site|homepage|landing page)\b/i,
      /\b(make|create|build)\b[^.?!]*\b(my|the|a)\b[^.?!]*\b(website|portfolio site|homepage|landing page)\b/i,
      /\bwebsite\s+(redesign|refresh|makeover|layout|sections|colors?|colours?|typography|fonts?|theme)\b/i,
    ],
    negations: [/what (do you|should|can) .*(think|recommend|suggest|advice)/i, /how (do|should|can) i\b/i],
  },
  {
    kind: "BANNER_DESIGN",
    targetAgent: "LAXII",
    destinationUrl: "#/laxii",
    destinationLabel: "Open LAXII banner studio",
    patterns: [
      /\b(create|make|design|generate|draw|produce|prepare|need|want)\b[^.?!]*\b(banner|cover image|profile banner|channel art|header image|hero image)\b/i,
      /\b(banner|header)\b[^.?!]*\b(for my (portfolio|profile|website|site|channel)|942|2048)\b/i,
    ],
    negations: [/what (size|dimensions|aspect)/i, /how (do|should|can) i\b/i, /(what|which) banner (should|would)/i],
  },
  {
    kind: "AVATAR_DESIGN",
    targetAgent: "LAXII",
    destinationUrl: "#/laxii",
    destinationLabel: "Open LAXII avatar studio",
    patterns: [
      /\b(create|make|design|generate|draw|produce|prepare|need|want)\b[^.?!]*\b(avatar|profile picture|profile photo|headshot|portrait)\b/i,
    ],
    negations: [/what (size|dimensions)/i, /how (do|should|can) i\b/i, /(what|which) (avatar|photo) (should|would)/i],
  },
];

export function detectDelegationIntent(message: string): DelegationPlan | null {
  for (const rule of RULES) {
    const hit = rule.patterns.some((p) => p.test(message));
    if (!hit) continue;
    const negated = rule.negations?.some((n) => n.test(message)) ?? false;
    if (negated) continue;
    return {
      kind: rule.kind,
      targetAgent: rule.targetAgent,
      title: message.slice(0, 80),
      brief: "", // filled by prepareDelegation with portfolio context
      destinationUrl: rule.destinationUrl,
      destinationLabel: rule.destinationLabel,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 3 — structured banner brief construction (own authorized data only)
// ---------------------------------------------------------------------------

/** Exact strings the user wrapped in quotes become the ONLY exact text. */
export function extractQuotedText(message: string): string[] {
  const matches = message.match(/[“"„«]([^“”"„«»]{1,60})[”"„»]/g) ?? [];
  return matches
    .map((m) => m.slice(1, -1).trim())
    .filter((s) => s.length >= 1 && s.length <= 60)
    .slice(0, 2);
}

interface SiteIdentityColors {
  accent?: string;
  accent2?: string;
  background?: string;
  foreground?: string;
}

function isHex(c: unknown): c is string {
  return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
}

/** The user's own existing visual identity from their site design (authorized own data). */
async function loadSiteIdentity(userId: string): Promise<SiteIdentityColors & { headingFont?: string }> {
  const site = await db.siteDesign.findUnique({ where: { userId } });
  const raw = site?.publishedConfig ?? site?.draftConfig;
  if (!raw) return {};
  try {
    const config = JSON.parse(raw) as { theme?: SiteIdentityColors & { headingFont?: string } };
    const t = config.theme ?? {};
    return {
      accent: isHex(t.accent) ? t.accent : undefined,
      accent2: isHex(t.accent2) ? t.accent2 : undefined,
      background: isHex(t.background) ? t.background : undefined,
      foreground: isHex(t.foreground) ? t.foreground : undefined,
      headingFont: typeof t.headingFont === "string" ? t.headingFont.slice(0, 40) : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Build the schema-validated structured brief for a banner delegation.
 * Every field is real: the request verbatim, own-data portfolio summary,
 * own-site palette hexes, the authoritative 2048×687 canvas + safe area.
 * Exact typography comes ONLY from the user's quoted strings — RIISHE never
 * invents text the user did not write.
 */
export async function buildStructuredBannerBrief(
  user: User,
  userMessage: string
): Promise<{ brief: DesignBrief; portfolioSummary: string[] }> {
  const preset = BANNER_PRESETS[0]; // the single authoritative BEAN Folio canvas
  const ctx = await buildPortfolioContext(user);
  const identity = await loadSiteIdentity(user.id);

  const portfolioSummary: string[] = [
    `Name: ${user.name}`,
    ctx.professions.length > 0 ? `Professions: ${ctx.professions.join(", ")}` : "",
    user.headline ? `Headline: ${user.headline.slice(0, 120)}` : "",
    ctx.projects.length > 0 ? `Recent work: ${ctx.projects.slice(0, 4).map((p) => p.title).join("; ")}` : "",
  ].filter(Boolean);

  const palette = [identity.accent, identity.accent2].filter(isHex).slice(0, 4);
  const quoted = extractQuotedText(userMessage);

  const raw: DesignBrief = {
    schemaVersion: 1,
    request: userMessage.slice(0, 2000),
    profession: ctx.professions[0] ?? null,
    targetAudience: "Clients and employers viewing the BEAN Folio profile",
    portfolio: { permission: "self", used: portfolioSummary.length > 0, summary: portfolioSummary.slice(0, 8) },
    visualIdentity: {
      toneWords: ["professional", "premium", "restrained"],
      notes: [
        identity.accent ? `Existing site accent color: ${identity.accent}` : "",
        identity.headingFont ? `Existing site heading typeface: ${identity.headingFont}` : "",
      ].filter(Boolean),
    },
    direction:
      "Premium, professional banner grounded in this portfolio: one clear focal subject, generous negative space, restrained premium palette, photorealistic lighting, single coherent scene.",
    subject: {
      description: user.headline ? `Visual anchor aligned with: ${user.headline.slice(0, 120)}` : "A single clear focal subject representing the portfolio owner's profession",
      focalPoint: "One dominant focal element; no competing subjects",
    },
    background: "Calm, premium environment that does not compete with the subject",
    composition: {
      hierarchy: "Subject first, supportive negative space second; text (if any) inside the safe zone",
      textPlacement: "left",
      notes: ["Composition reads at a glance even when cropped to the center band"],
    },
    palette,
    typography: {
      items: quoted.map((text, i) => ({
        text,
        role: i === 0 ? ("headline" as const) : ("subtext" as const),
        font: "sans" as const,
      })),
      notes: quoted.length > 0 ? ["Text is rendered deterministically by LAXII — keep the scene free of lettering"] : [],
    },
    canvas: { presetSlug: preset.slug, width: preset.width, height: preset.height },
    safeArea: preset.safeArea,
    referenceMediaIds: [],
    preserve: [],
    avoid: ["lettering, words or watermarks painted into the scene", "clutter near the frame edges", "competing focal subjects"],
    export: { format: "png", exactDimensions: true },
    revisions: [],
    source: "RIISHE",
    sourceTaskId: "pending",
    createdAt: new Date().toISOString(),
  };

  return { brief: parseDesignBrief(raw), portfolioSummary };
}

/** Human-readable paragraph derived FROM the structured brief (never independent). */
export function describeBrief(brief: DesignBrief): string {
  const lines: string[] = [];
  lines.push(`Design brief prepared by RIISHE (${new Date(brief.createdAt).toISOString().slice(0, 10)}):`);
  lines.push("", "— Request —", brief.request);
  if (brief.profession || brief.targetAudience) {
    lines.push("", "— Audience —", [brief.profession && `Profession: ${brief.profession}`, brief.targetAudience && `Audience: ${brief.targetAudience}`].filter(Boolean).join(" · "));
  }
  if (brief.portfolio.used && brief.portfolio.summary.length) {
    lines.push("", "— Portfolio context (your own data) —", ...brief.portfolio.summary.map((s) => `- ${s}`));
  }
  if (brief.visualIdentity.notes.length) {
    lines.push("", "— Existing visual identity —", ...brief.visualIdentity.notes.map((s) => `- ${s}`));
  }
  if (brief.direction) lines.push("", "— Design direction —", brief.direction);
  if (brief.subject.description) lines.push("", "— Subject —", brief.subject.description, brief.subject.focalPoint && `Focal point: ${brief.subject.focalPoint}`);
  if (brief.background) lines.push("", "— Background —", brief.background);
  if (brief.palette.length) lines.push("", "— Palette —", brief.palette.join(", "));
  if (brief.typography.items.length) {
    lines.push("", "— Exact text (rendered deterministically) —", ...brief.typography.items.map((t) => `(${t.role}) "${t.text}"`));
  }
  lines.push(
    "",
    "— Canvas —",
    `Exactly ${brief.canvas.width}×${brief.canvas.height} px · safe area ${brief.safeArea.width}×${brief.safeArea.height} px centered · export ${brief.export.format.toUpperCase()} at exact dimensions.`
  );
  if (brief.avoid.length) lines.push("", "— Avoid —", ...brief.avoid.map((s) => `- ${s}`));
  if (brief.revisions.length) {
    lines.push("", "— Revisions requested —", ...brief.revisions.map((r) => `- [${r.area}] ${r.instruction}`));
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Prepare a portfolio-grounded design brief and persist the AgentTask.
 * BANNER delegations carry the full STRUCTURED brief (Phase 3); other kinds
 * keep the human-readable brief. Returns the task id + the plan for the UI card.
 */
export async function prepareDelegation(
  user: User,
  plan: DelegationPlan,
  userMessage: string
): Promise<{ taskId: string; plan: DelegationPlan }> {
  let brief: string;
  let structuredBrief: DesignBrief | undefined;

  if (plan.kind === "BANNER_DESIGN") {
    const built = await buildStructuredBannerBrief(user, userMessage);
    structuredBrief = built.brief;
    brief = describeBrief(structuredBrief);
  } else {
    const { profileBlock, projectsBlock } = await buildPortfolioContext(user);
    brief = [
      `Design brief prepared by RIISHE from your portfolio (${new Date().toISOString().slice(0, 10)}):`,
      "",
      `— Portfolio context —`,
      profileBlock,
      `Recent projects:`,
      projectsBlock,
      "",
      `— Request —`,
      userMessage.slice(0, 400),
      "",
      plan.kind === "AVATAR_DESIGN"
        ? `— Direction for the avatar —\nProfessional, friendly, high-contrast against the BEAN Folio obsidian interface; face centered, works at small sizes. Identity preservation: render THIS person with best-effort likeness when a reference is provided.`
        : `— Direction for the website —\nPreserve the user's published content; improve structure, hierarchy, typography and visual consistency for the profession above. One reviewable plan; nothing is applied until the user accepts it in Website Studio.`,
    ].join("\n");
  }

  plan.brief = brief;

  const steps = [
    { step: "brief-prepared", status: "done", note: structuredBrief ? "Structured design brief built (own data only)." : "Portfolio context gathered (own data only)." },
    { step: "user-review", status: "awaiting-approval", note: `Open ${plan.targetAgent === "LAXII" ? "LAXII" : "Website Studio"} to review the brief and create — nothing is generated or changed automatically.` },
    { step: "execute", status: "pending", note: plan.targetAgent === "LAXII" ? "Generate in the LAXII studio (banner canvas 2048×687 enforced)." : "Plan/execute in Website Studio with explicit approval." },
  ];

  const task = await db.agentTask.create({
    data: {
      userId: user.id,
      agent: plan.targetAgent === "LAXII" ? "LAXII" : "CODE_GIFTZ",
      kind: plan.kind,
      title: plan.title,
      status: "AWAITING_APPROVAL",
      stepsJson: JSON.stringify(steps),
      resultJson: JSON.stringify({
        brief,
        ...(structuredBrief ? { structuredBrief } : {}),
        destinationUrl: plan.destinationUrl,
        destinationLabel: plan.destinationLabel,
      } satisfies AgentTaskResult),
    },
  });

  // The structured brief must reference its durable task row.
  if (structuredBrief) {
    structuredBrief.sourceTaskId = task.id;
    structuredBrief.createdAt = task.createdAt.toISOString();
    await db.agentTask.update({
      where: { id: task.id },
      data: {
        resultJson: JSON.stringify({
          brief,
          structuredBrief,
          destinationUrl: plan.destinationUrl,
          destinationLabel: plan.destinationLabel,
        } satisfies AgentTaskResult),
      },
    });
  }

  logGatewayEvent({
    event: "gateway.request",
    agent: "RIISHE",
    feature: `delegation.${plan.kind.toLowerCase()}`,
    capability: "task",
    outcome: "success",
    userId: user.id,
    error: `task ${task.id} → ${plan.targetAgent}`,
  });

  return { taskId: task.id, plan };
}

// ---------------------------------------------------------------------------
// Phase 3 — brief task lifecycle helpers (used by /api/laxii/brief)
// ---------------------------------------------------------------------------

export interface LoadedBriefTask {
  id: string;
  status: string;
  kind: string;
  title: string;
  brief: DesignBrief;
  humanBrief: string;
  destinationUrl: string;
  destinationLabel: string;
  generation: { conversationId?: string; messageId?: string; mediaId?: string; approved?: boolean; rejected?: boolean };
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Load + validate a user-owned AgentTask carrying a structured brief. */
export async function loadBriefTask(userId: string, taskId: string): Promise<LoadedBriefTask | null> {
  const task = await db.agentTask.findFirst({ where: { id: taskId, userId, kind: "BANNER_DESIGN", agent: "LAXII" } });
  if (!task) return null;
  let parsed: AgentTaskResult & { generation?: LoadedBriefTask["generation"] };
  try {
    parsed = JSON.parse(task.resultJson ?? "{}") as AgentTaskResult & { generation?: LoadedBriefTask["generation"] };
  } catch {
    return null;
  }
  if (!parsed.structuredBrief) return null;
  let brief: DesignBrief;
  try {
    brief = parseDesignBrief(parsed.structuredBrief);
  } catch {
    return null;
  }
  return {
    id: task.id,
    status: task.status,
    kind: task.kind,
    title: task.title,
    brief,
    humanBrief: parsed.brief ?? "",
    destinationUrl: parsed.destinationUrl ?? "",
    destinationLabel: parsed.destinationLabel ?? "",
    generation: parsed.generation ?? {},
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** Apply a bounded targeted revision to the persisted brief. */
export async function reviseBriefTask(userId: string, taskId: string, area: BriefRevision["area"], instruction: string): Promise<LoadedBriefTask | null> {
  const loaded = await loadBriefTask(userId, taskId);
  if (!loaded) return null;
  if (loaded.brief.revisions.length >= 3) {
    throw new Error("This brief already carries the maximum of 3 targeted revisions — generate with what you have or start a new brief.");
  }
  const updated = appendRevision(loaded.brief, area, instruction);
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      status: "AWAITING_APPROVAL",
      resultJson: JSON.stringify({
        brief: describeBrief(updated),
        structuredBrief: updated,
        destinationUrl: loaded.destinationUrl,
        destinationLabel: loaded.destinationLabel,
        generation: loaded.generation,
      }),
    },
  });
  return loadBriefTask(userId, taskId);
}

/** Record the user's result decision (approval gate before export/publish). */
export async function recordBriefDecision(
  userId: string,
  taskId: string,
  decision: "approved" | "rejected",
  mediaId: string | null,
  reason?: string
): Promise<LoadedBriefTask | null> {
  const loaded = await loadBriefTask(userId, taskId);
  if (!loaded) return null;
  const generation: LoadedBriefTask["generation"] = {
    ...loaded.generation,
    ...(mediaId ? { mediaId } : {}),
    approved: decision === "approved" ? true : loaded.generation.approved,
    rejected: decision === "rejected" ? true : loaded.generation.rejected,
  };
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      status: decision === "approved" ? "COMPLETED" : "AWAITING_APPROVAL",
      error: decision === "rejected" ? (reason ?? "Result rejected by the user — revise the brief and generate again.").slice(0, 300) : null,
      resultJson: JSON.stringify({
        brief: describeBrief(loaded.brief),
        structuredBrief: loaded.brief,
        destinationUrl: loaded.destinationUrl,
        destinationLabel: loaded.destinationLabel,
        generation,
      }),
    },
  });
  return loadBriefTask(userId, taskId);
}

/** Record the conversation/message a brief generation produced (RUNNING → COMPLETED). */
export async function recordBriefGeneration(
  userId: string,
  taskId: string,
  generation: NonNullable<LoadedBriefTask["generation"]> & { mediaId?: string }
): Promise<void> {
  const loaded = await loadBriefTask(userId, taskId);
  if (!loaded) return;
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      status: "COMPLETED",
      resultJson: JSON.stringify({
        brief: describeBrief(loaded.brief),
        structuredBrief: loaded.brief,
        destinationUrl: loaded.destinationUrl,
        destinationLabel: loaded.destinationLabel,
        generation: { ...loaded.generation, ...generation },
      }),
    },
  });
}

/** Mark a brief task RUNNING (user pressed Generate) or FAILED (pipeline outcome). */
export async function setBriefTaskStatus(userId: string, taskId: string, status: "RUNNING" | "FAILED", note?: string): Promise<void> {
  const loaded = await loadBriefTask(userId, taskId);
  if (!loaded) return;
  const steps = [
    { step: "brief-prepared", status: "done", note: "Structured design brief built (own data only)." },
    { step: "user-review", status: "done", note: "User reviewed the brief in LAXII and started generation." },
    { step: "execute", status: status === "RUNNING" ? "running" : "failed", note: note ?? (status === "RUNNING" ? "Banner pipeline running in LAXII." : "Generation failed — see the LAXII thread.") },
  ];
  await db.agentTask.update({
    where: { id: taskId },
    data: {
      status,
      stepsJson: JSON.stringify(steps),
      ...(status === "FAILED" && note ? { error: note.slice(0, 300) } : {}),
    },
  });
}
