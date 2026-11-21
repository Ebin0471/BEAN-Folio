/**
 * RIISHE safe-automation policy (blueprint §5, B2) — the user-configurable
 * layer that decides HOW a registered tool may start, on top of the
 * registry's own permission declarations.
 *
 * Layers of protection, in enforcement order:
 *  1. The REGISTRY declares each tool's automation level (1 safe-auto /
 *     2 confirm / 3 destructive-confirm), category, risk and approval flag.
 *     The planner can never change these (levels are read from the registry,
 *     never from model output).
 *  2. The USER's automation preferences (stored in the existing
 *     RiisheUserPreference KV store — no schema change) tune Level-1 auto-run,
 *     per-action Level-2 confirmation and category pre-authorization. Defaults
 *     are the SAFE side: Level 1 auto-runs, every Level-2 action confirms at
 *     run time, no category is pre-authorized.
 *  3. The EXECUTOR re-checks both at execution time — a stored flag can never
 *     let a Level-2 tool run unapproved, and a daily action cap (existing
 *     quota-architecture pattern: per-user UTC-day counting, exactly like the
 *     shared AI usage limit) bounds runaway automation.
 *
 * Level 3 tools are NEVER silently executed: they additionally require the
 * explicit typed confirm interaction (approve with confirm=true), which the
 * workflow engine already enforces for DESTRUCTIVE risk.
 */

import { db } from "@/lib/db";
import {
  getTool,
  TOOL_CATEGORIES,
  toolApprovalRequired,
  type RiisheToolDef,
  type ToolCategory,
} from "@/lib/riishe/tools";

export const DEFAULT_DAILY_ACTION_CAP = 20;
export const MIN_DAILY_ACTION_CAP = 1;
export const MAX_DAILY_ACTION_CAP = 200;

export const AUTOMATION_PREFERENCE_KEYS = [
  "automation.autoRunLevel1",
  "automation.confirmEachLevel2",
  "automation.allowedLevel2Categories",
  "automation.dailyActionCap",
] as const;

export type AutomationPreferenceKey = (typeof AUTOMATION_PREFERENCE_KEYS)[number];

export interface AutomationPreferences {
  /** Level-1 steps execute automatically (default true). */
  autoRunLevel1: boolean;
  /** Every Level-2 action requires per-action confirmation (default true). */
  confirmEachLevel2: boolean;
  /** Categories the owner explicitly pre-authorized (default: none). */
  allowedLevel2Categories: ToolCategory[];
  /** Max executed automation actions per UTC day (default 20). */
  dailyActionCap: number;
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function clampCap(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_DAILY_ACTION_CAP;
  return Math.min(MAX_DAILY_ACTION_CAP, Math.max(MIN_DAILY_ACTION_CAP, n));
}

function isToolCategory(v: unknown): v is ToolCategory {
  return typeof v === "string" && (TOOL_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Read the owner's automation preferences with SAFE defaults for anything
 * unset. Invalid rows degrade to defaults — a corrupted preference can never
 * loosen a permission.
 */
export async function getAutomationPreferences(userId: string): Promise<AutomationPreferences> {
  const rows = await db.riisheUserPreference.findMany({
    where: { userId, key: { in: [...AUTOMATION_PREFERENCE_KEYS] } },
    select: { key: true, valueJson: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.valueJson]));
  const parse = <T,>(key: AutomationPreferenceKey): T | null => {
    const raw = byKey.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const autoRun = parse<{ enabled?: unknown }>("automation.autoRunLevel1");
  const confirmEach = parse<{ enabled?: unknown }>("automation.confirmEachLevel2");
  const allowed = parse<{ categories?: unknown }>("automation.allowedLevel2Categories");
  const capPref = parse<{ cap?: unknown }>("automation.dailyActionCap");

  return {
    autoRunLevel1: typeof autoRun?.enabled === "boolean" ? autoRun.enabled : true,
    confirmEachLevel2: typeof confirmEach?.enabled === "boolean" ? confirmEach.enabled : true,
    allowedLevel2Categories: Array.isArray(allowed?.categories)
      ? [...new Set(allowed.categories.filter(isToolCategory))]
      : [],
    dailyActionCap: clampCap(capPref?.cap),
  };
}

/**
 * Whether a Level-2 tool may run without a per-step approval for this owner:
 * ONLY when the owner explicitly turned per-action confirmation OFF and
 * explicitly listed the tool's category as pre-authorized. Defaults refuse.
 */
async function isLevel2Preauthorized(userId: string, tool: RiisheToolDef<never>): Promise<boolean> {
  if (!toolApprovalRequired(tool) || tool.risk === "DESTRUCTIVE") return false;
  const prefs = await getAutomationPreferences(userId);
  if (prefs.confirmEachLevel2) return false;
  return prefs.allowedLevel2Categories.includes(tool.category);
}

/**
 * The initial status for a step whose dependencies are satisfied and whose
 * time has come: approval-gated when the registry/policy says so, otherwise
 * READY (auto-run) — or AWAITING_APPROVAL when the owner turned Level-1
 * auto-run off (their call, honored everywhere).
 */
export async function initialStatusForStep(userId: string, tool: RiisheToolDef<never> | null): Promise<"AWAITING_APPROVAL" | "READY"> {
  if (!tool) return "AWAITING_APPROVAL"; // unknown tool: refuse to auto-run
  if (toolApprovalRequired(tool)) {
    return (await isLevel2Preauthorized(userId, tool)) ? "READY" : "AWAITING_APPROVAL";
  }
  const prefs = await getAutomationPreferences(userId);
  return prefs.autoRunLevel1 ? "READY" : "AWAITING_APPROVAL";
}

/** Execution-time gate (defense in depth): may this queued step run now? */
export async function mayExecuteStep(userId: string, step: { requiresApproval: boolean; approvedAt: Date | null }, tool: RiisheToolDef<never> | null): Promise<boolean> {
  const registryRequires = tool ? toolApprovalRequired(tool) : step.requiresApproval;
  const requires = registryRequires || step.requiresApproval;
  if (!requires) return true;
  if (step.approvedAt !== null) return true;
  return tool ? await isLevel2Preauthorized(userId, tool) : false;
}

// ---------------------------------------------------------------- daily cap

export interface DailyActionCapStatus {
  cap: number;
  executedToday: number;
  allowed: boolean;
}

/**
 * Real executions counted per owner per UTC day: workflow tool executions
 * that actually STARTED (RUNNING / SUCCEEDED / FAILED) — queued, pending,
 * awaiting-approval or skipped steps never count. Mirrors the existing
 * AiUsage daily-quota architecture (count rows since UTC midnight).
 */
export async function dailyActionCapStatus(userId: string, prefs?: AutomationPreferences): Promise<DailyActionCapStatus> {
  const resolved = prefs ?? (await getAutomationPreferences(userId));
  const executedToday = await db.riisheWorkflowStep.count({
    where: {
      userId,
      startedAt: { gte: startOfUtcDay() },
      status: { in: ["RUNNING", "SUCCEEDED", "FAILED"] },
    },
  });
  return { cap: resolved.dailyActionCap, executedToday, allowed: executedToday < resolved.dailyActionCap };
}
