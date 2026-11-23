/**
 * RIISHE tool contracts (M31) — the shared type + registration vocabulary
 * for every tool in the platform. Split from tools.ts so specialist tool
 * modules can register against the SAME contract without import cycles:
 *
 *   tool-contracts.ts  <-  specialist-tools.ts
 *        ^                    |
 *        |                    v
 *        +--------------- tools.ts (merges core + specialist into RIISHE_TOOLS)
 *
 * The registry remains the single source of truth: the planner may only
 * reference tools that are registered here, and the executor only runs
 * handlers from the registry. See tools.ts for the full permission model.
 */

import { z, type ZodType } from "zod";
import type { NextRequest } from "next/server";

export type ToolRisk = "LOW" | "MEDIUM" | "HIGH" | "DESTRUCTIVE";

export const TOOL_RISKS: ToolRisk[] = ["LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"];

export const RISK_APPROVAL: Record<ToolRisk, boolean> = {
  LOW: false,
  MEDIUM: false,
  HIGH: true,
  DESTRUCTIVE: true,
};

// ------------------------------------------------------------- automation policy

/**
 * Automation level (blueprint §5, B2) — the REGISTRY-level permission
 * declaration. The planner reads these values; it can never set, raise or
 * bypass them.
 *
 *  1  Safe automatic execution — drafts, private records, read-only analysis.
 *     Nothing public changes and nothing is sent.
 *  2  Explicit user confirmation required for EVERY execution — anything that
 *     sends a message, publishes/schedules public content or otherwise makes
 *     the owner visible to others. approval:true is enforced even where the
 *     generic risk map would have permitted silent execution (e.g. the
 *     MEDIUM-risk scheduled post below).
 *  3  Never silently executed — destructive actions with irreversible
 *     effects. They additionally require the typed confirm interaction
 *     (approve with confirm=true) and otherwise answer confirm-required.
 *     RIISHE has NO tools for spending money or purchasing services and must
 *     never gain them.
 */
export type ToolAutomationLevel = 1 | 2 | 3;

export const TOOL_LEVELS: ToolAutomationLevel[] = [1, 2, 3];

/** Registry-level automation category (drives pre-authorization preferences). */
export type ToolCategory = "discovery" | "outreach" | "content" | "relationship" | "growth";

export const TOOL_CATEGORIES: ToolCategory[] = ["discovery", "outreach", "content", "relationship", "growth"];

/** Undo metadata: the honest reversal story for a tool's persistent effect. */
export interface ToolUndo {
  supported: boolean;
  /** How to reverse it (user-facing, honest); null when nothing persists. */
  how: string | null;
}

/** Verification result recorded in the step's resultJson (B2 verify phase). */
export interface ToolVerification {
  ok: boolean;
  /** Evidence: what was re-read from the backend and what it showed. */
  detail: string;
}

export interface ToolContext {
  /** The workflow owner — every handler re-verifies ownership server-side. */
  userId: string;
  workflowId?: string;
  stepId?: string;
  /**
   * Present ONLY when executed at approval time inside an authenticated HTTP
   * request. HIGH tools that reuse a real API route handler (enquiry send)
   * require it — the queue never executes them.
   */
  createInquiry?: (req: NextRequest) => Promise<Response>;
  /**
   * M31 (additive): the workspace the workflow was created in. The value is
   * a PLANNING HINT captured at creation time — every handler that touches
   * organization data MUST independently re-verify membership and role via
   * the existing authorization matrix (requireOrgRole) before acting on it.
   * Null organizationId = the personal workspace.
   */
  workspace?: {
    type: "PERSONAL" | "ORGANIZATION";
    organizationId: string | null;
    membershipRole: string | null;
  };
  /** M31 (additive): correlation id for cross-log audit tracing. */
  auditTraceId?: string;
}

export interface RiisheToolDef<S = unknown> {
  name: string;
  title: string;
  description: string;
  risk: ToolRisk;
  /** Registry-level automation level (see ToolAutomationLevel). */
  level: ToolAutomationLevel;
  /** Registry-level automation category. */
  category: ToolCategory;
  inputSchema: ZodType<S>;
  timeoutMs: number;
  maxAttempts: number;
  /** Re-execution after a partial failure cannot duplicate the effect. */
  idempotent: boolean;
  auditAction: string;
  execute: (ctx: ToolContext, input: S) => Promise<Record<string, unknown>>;
  /**
   * B2 verify phase: re-read the persistent output from the backend after the
   * handler returns. A failed verification is a FAILED step — success is
   * never reported before the persistent result is confirmed. Read-only tools
   * (no persistent output) declare no verify function.
   */
  verify?: (ctx: ToolContext, input: S, result: Record<string, unknown>) => Promise<ToolVerification>;
  /** Honest reversal story for the tool's persistent effect (null = read-only). */
  undo: ToolUndo | null;
}

/**
 * Approval rule of record: a tool requires explicit user approval when the
 * REGISTRY says so — its automation level is 2 or 3 (or its risk tier is
 * HIGH/DESTRUCTIVE). The generic risk map alone is never sufficient: a
 * Level-2 MEDIUM-risk tool still requires approval.
 */
export function toolApprovalRequired(tool: Pick<RiisheToolDef, "level" | "risk">): boolean {
  return tool.level >= 2 || tool.risk === "HIGH" || tool.risk === "DESTRUCTIVE";
}


export function defineTool<S>(def: RiisheToolDef<S>): RiisheToolDef<never> {
  return def as unknown as RiisheToolDef<never>;
}
