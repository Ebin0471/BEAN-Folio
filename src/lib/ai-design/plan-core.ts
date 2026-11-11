import { aiComplete, parseJsonFromText, AI_DEEP_TIMEOUT_MS, AiProviderError } from "@/lib/ai";
import type { SiteConfig } from "@/lib/site-config";
import { buildSiteDigest } from "./digest";
import {
  resolvePlanJson,
  type PlanOutcome,
} from "./plan";
import { planSystemPrompt, planRepairPrompt } from "./prompts";

/**
 * Shared planning core for Code Giftz website changes.
 *
 * Extracted from the original /api/ai/design/plan route so TWO consumers can
 * run the EXACT same planning pipeline (grounding → one deep-reasoning call →
 * normalization → schema validation → digest validation → bounded repair):
 *   1. the plan route (explicit plan review UI), and
 *   2. the Website Studio conversational turns (plan + auto-execute in one
 *      user action, with the same safety semantics).
 *
 * Failure policy (bounded, honest, never silent):
 *  - The model's JSON first goes through normalizePlanJson (representation
 *    repair: nulls, single-string arrays, unknown patch keys) — pure, local.
 *  - If the STRICT schema still rejects it, the model gets exactly ONE
 *    repair round: its own JSON + the real validation errors + the same
 *    contract, asked to return corrected JSON. The repaired answer runs the
 *    same resolver — approval gates, digest validation and tool checks are
 *    identical for both attempts.
 *  - If the repair also fails, the error carries the ACTUAL schema issues —
 *    planning fails loudly with diagnostics instead of a generic "rephrase".
 * Pure orchestration: no DB access, no usage recording — callers own both
 * (they own the session and the quota gate).
 */

export type { PlanOutcome } from "./plan";

export interface PlanRequestContext {
  device?: string;
  pageName?: string;
  sectionType?: string;
  sectionTitle?: string;
}

export interface PlanDesignChangeParams {
  request: string;
  current: SiteConfig;
  context: PlanRequestContext | null;
  history: { role: string; content: string }[];
  mode: "edit" | "create";
  /** Pre-fetched grounding blocks (callers own the DB session). */
  portfolioBlock: string;
  materialsText?: string;
  /** Pre-rendered BINDING creative-direction block (from the direction engine). */
  directionBlock?: string;
}

/** The one completion function the pipeline needs — injectable for tests. */
export type PlanCompleteFn = typeof aiComplete;

/** How many MODEL attempts planning may use (1 plan + 1 repair). Bounded. */
export const PLAN_MAX_ATTEMPTS = 2;

function summarizeSchemaErrors(errors: string[]): string {
  return errors.slice(0, 3).join("; ");
}

export async function planDesignChange(
  params: PlanDesignChangeParams,
  deps: { complete?: PlanCompleteFn } = {}
): Promise<PlanOutcome> {
  const { request, current, context, history, mode } = params;
  const complete = deps.complete ?? aiComplete;

  const digest = buildSiteDigest(current);

  const whereBlock = context
    ? `device ${context.device ?? "desktop"}, page ${context.pageName ?? "(home)"}, selected section ${
        context.sectionType ?? "(none)"
      }${context.sectionTitle ? ` ("${context.sectionTitle}")` : ""}`
    : "(no specific location)";

  const historyBlock =
    history.length > 0
      ? `\n\nRecent conversation (oldest first):\n${history.map((h) => `${h.role}: ${h.content.slice(0, 1200)}`).join("\n")}`
      : "";

  const system = planSystemPrompt(digest, params.portfolioBlock, mode, params.directionBlock);
  const materialsSuffix = params.materialsText ? `\n\n${params.materialsText}` : "";
  const userContent = `Where the user is looking right now: ${whereBlock}\n\nRequest: ${request}${historyBlock}${materialsSuffix}`;

  // Deep-reasoning mode: planning is the agent's hardest step — schema
  // grounding, dependency ordering and constraint extraction all benefit.
  const { text } = await complete(system, [{ role: "user", content: userContent }], {
    temperature: 0.3,
    thinking: true,
    timeoutMs: AI_DEEP_TIMEOUT_MS,
  });

  return resolvePlanResponse({
    system,
    userContent,
    firstResponse: text,
    digest,
    request,
    complete,
  });
}

/**
 * Turn the model's first JSON answer into a PlanOutcome — with ONE bounded
 * repair round when the strict schema rejects it. Shared by planDesignChange
 * and (via re-export) available for direct testing.
 */
export async function resolvePlanResponse(args: {
  system: string;
  userContent: string;
  firstResponse: string;
  digest: ReturnType<typeof buildSiteDigest>;
  request: string;
  complete: PlanCompleteFn;
}): Promise<PlanOutcome> {
  const { system, userContent, firstResponse, digest, request, complete } = args;

  const parsedJson = parseJsonFromText<Record<string, unknown>>(firstResponse);
  if (!parsedJson || typeof parsedJson !== "object") {
    // Unparseable output — one bounded repair round before giving up.
    const repaired = await repairAttempt(system, userContent, firstResponse, ["The response was not a single JSON object."], digest, request, complete);
    if (repaired !== null) return repaired;
    throw new AiProviderError(
      "GIFTZ returned an unreadable plan and the one repair attempt also failed. Send the request again — if it keeps failing, rephrase it."
    );
  }

  const first = resolvePlanJson(parsedJson, digest, request);
  if (first.ok) {
    const outcome = first.resolved.outcome;
    // Digest-level rejection (unknown targets, conflicts) previously went
    // straight back to the user as a failed turn — even though the validator
    // issues name the EXACT invalid targets and the model can fix them. Give
    // it the SAME one bounded repair round schema failures get: the repair
    // sees its own JSON + the real issues and re-enters the identical
    // resolver (canonicalization + validation — no gate skipped). Still
    // failing plans surface honestly; nothing is silently weakened.
    if (outcome.kind === "invalid") {
      const repaired = await repairAttempt(
        system,
        userContent,
        firstResponse,
        outcome.issues.map((i) => i.message),
        digest,
        request,
        complete
      );
      // A repair that resolves to anything (plan, reply, or a fresher invalid
      // with new diagnostics) is returned as-is — the pipeline judged it.
      return repaired ?? outcome;
    }
    return outcome;
  }

  // STRICT schema rejection — one bounded repair round with REAL diagnostics.
  const repaired = await repairAttempt(system, userContent, firstResponse, first.schemaErrors, digest, request, complete);
  if (repaired !== null) return repaired;

  // Planning genuinely failed: surface the ACTUAL validation problems so the
  // failure is meaningful (and support can see the real cause) — never hide
  // it behind a generic rephrase loop.
  throw new AiProviderError(
    `The plan did not match GIFTZ's plan schema after one repair attempt. Schema issues: ${summarizeSchemaErrors(first.schemaErrors)}`
  );
}

/** One repair round. Returns the resolved outcome, or null when it failed again. */
async function repairAttempt(
  system: string,
  userContent: string,
  invalidResponse: string,
  errors: string[],
  digest: ReturnType<typeof buildSiteDigest>,
  request: string,
  complete: PlanCompleteFn
): Promise<PlanOutcome | null> {
  let text: string;
  try {
    const r = await complete(planRepairPrompt(invalidResponse, errors), [{ role: "user", content: userContent }], {
      temperature: 0.2,
      thinking: true,
      timeoutMs: AI_DEEP_TIMEOUT_MS,
      // Same feature label family — routing logs show this was a repair.
      feature: "plan-repair",
    });
    text = r.text;
  } catch {
    // The repair call itself failing (quota, timeout) must not mask the real
    // schema diagnostics — the caller reports them.
    return null;
  }

  const parsed = parseJsonFromText<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== "object") return null;
  // The repaired answer runs the EXACT same resolver — same schema, same
  // digest validation, same constraint rules. No gate is skipped or weakened.
  const resolved = resolvePlanJson(parsed, digest, request);
  if (resolved.ok) return resolved.resolved.outcome;
  return null;
}
