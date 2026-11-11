import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, parseBody } from "@/lib/api-helpers";
import { aiComplete, aiGate, AiProviderError, parseJsonFromText, recordAiUsage, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";
import { getSessionUser } from "@/lib/auth";
import { normalizeConfig } from "@/lib/site-config";
import { buildSiteDigest, digestSummaryLine } from "@/lib/ai-design/digest";
import { auditSystemPrompt, digestDoc } from "@/lib/ai-design/prompts";
import { fetchPortfolioBlock } from "@/lib/ai-design/context";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

const auditRequestSchema = z.object({
  request: z.string().trim().min(3).max(50_000),
  currentConfig: z.unknown(),
  context: contextSchema,
  history: z.array(historyItemSchema).max(8).default([]),
  /** REAL measurements from the client's live preview iframe (browser-checks
   *  module) — passed as evidence so the audit cannot contradict them. */
  browserEvidence: z
    .array(
      z.object({
        id: z.string().max(40),
        label: z.string().max(80),
        status: z.enum(["pass", "warn", "fail"]),
        detail: z.string().max(400),
      })
    )
    .max(8)
    .optional(),
});

export const auditFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  area: z.string().max(30),
  finding: z.string().min(3).max(500),
  evidence: z.string().max(500).default(""),
  suggestion: z.string().max(500).default(""),
});
export type AuditFinding = z.infer<typeof auditFindingSchema>;

/**
 * POST /api/ai/design/audit — Code Giftz, AUDIT MODE. Strictly read-only.
 *
 * The audit is grounded in checks the platform actually ran: the computed
 * site digest (WCAG contrast ratios, structure inventory, motion settings,
 * empty sections, duplicate titles) is passed to the model as EVIDENCE, and
 * the model adds what those checks cannot see. Findings are prioritized,
 * each with severity, area, the concrete evidence and a specific fix. No
 * config is ever returned — audits change nothing.
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return err("Authentication required", 401);

  const gate = await aiGate(user);
  if (gate) return gate;

  const r = await parseBody(req, auditRequestSchema);
  if (r.response) return r.response;
  const { request, context, history, browserEvidence } = r.data;

  const current = normalizeConfig(r.data.currentConfig);
  if (!current) return err("The current website configuration is invalid.", 400);

  const digest = buildSiteDigest(current);
  const portfolioBlock = await fetchPortfolioBlock(user);

  const whereBlock = context
    ? `The user is looking at: device ${context.device ?? "desktop"}, page ${context.pageName ?? "(home)"}, selected section ${
        context.sectionType ?? "(none)"
      }${context.sectionTitle ? ` ("${context.sectionTitle}")` : ""}.`
    : "";

  const historyBlock =
    history.length > 0
      ? `\n\nRecent conversation (oldest first):\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}`
      : "";

  const browserBlock =
    browserEvidence && browserEvidence.length > 0
      ? `\n- browser preview measurements (REAL, from the live preview iframe at the user's current device — treat as authoritative for layout/assets/runtime at that width):\n${browserEvidence
          .map((c) => `  · ${c.label} [${c.status}]: ${c.detail}`)
          .join("\n")}`
      : "";

  const computed = `${digestDoc(digest)}\n- summary: ${digestSummaryLine(digest)}${browserBlock}`;
  const system = auditSystemPrompt(computed, portfolioBlock);
  const userContent = [
    whereBlock,
    `Audit request: ${request}${historyBlock}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    // Deep-reasoning mode: the auditor reasons over computed evidence.
    const { text } = await aiComplete(system, [{ role: "user", content: userContent }], {
      temperature: 0.2,
      thinking: true,
      timeoutMs: AI_DEEP_TIMEOUT_MS,
    });

    const parsed = parseJsonFromText<{ reply?: unknown; findings?: unknown }>(text);
    if (!parsed || typeof parsed !== "object") {
      return err("GIFTZ returned an unreadable audit. Try again.", 502);
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply.slice(0, 800) : "";
    const findings: AuditFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings
          .map((f) => auditFindingSchema.safeParse(f))
          .filter((x) => x.success)
          .map((x) => x.data as AuditFinding)
          .slice(0, 8)
      : [];

    await recordAiUsage(user.id, "design");
    return ok({ reply, findings });
  } catch (e) {
    if (e instanceof AiProviderError) return err(e.message, 502);
    throw e;
  }
});
