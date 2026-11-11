/**
 * CODE GIFTZ engineering planner (Phase 4 spec §4).
 *
 * Model output is NEVER trusted: every plan passes a strict zod schema plus a
 * semantic validator (paths confined, declared files match steps, command
 * steps backed by allowlisted argv, dependency DAG well-formed). Invalid plans
 * get ONE bounded structured repair attempt with the validation errors fed
 * back; persistent failure produces an actionable error — the user is never
 * asked to "rephrase" because of internal schema mismatches.
 */

import { z } from "zod";

import type { EngineeringPlan, InspectionDigest, PlanStep } from "./types";
import { isIgnoredPath, isSecretPath } from "./redact";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const planFileSchema = z.object({
  path: boundedText(256).refine((p) => !p.includes("..") && !p.startsWith("/"), "path must be workspace-relative"),
  change: z.enum(["create", "modify", "delete"]),
  reason: boundedText(300),
});

export const planStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "step id: lowercase alphanum and dashes"),
  title: boundedText(160),
  kind: z.enum(["create_file", "modify_file", "delete_file", "run_command", "inspect"]),
  path: z.string().max(256).optional(),
  command: z.string().max(120).optional(),
  detail: boundedText(2000),
  dependsOn: z.array(z.string()).max(6).default([]),
  risk: z.enum(["low", "medium", "high"]).default("low"),
});

export const planCommandSchema = z.object({
  label: boundedText(120),
  argv: z.array(z.string().max(256)).min(1).max(12),
});

export const engineeringPlanSchema = z.object({
  objective: boundedText(500),
  problemDescription: boundedText(2000),
  rootCauseHypothesis: z.string().max(1000).optional(),
  files: z.array(planFileSchema).min(1).max(12),
  steps: z.array(planStepSchema).min(1).max(10),
  dependencies: z.array(boundedText(120)).max(8).default([]),
  risks: z.array(z.object({ level: z.enum(["low", "medium", "high"]), note: boundedText(300) })).max(6).default([]),
  validation: z.object({
    strategy: boundedText(1000),
    commands: z.array(planCommandSchema).max(6).default([]),
  }),
  expectedOutcome: boundedText(1000),
});

export type PlanIssue = {
  code: string;
  message: string;
  stepId?: string;
  path?: string;
  /** Actionable remediation — safe to show to the user (no secrets, workspace-relative paths only). */
  hint?: string;
};

// ---------------------------------------------------------------------------
// Semantic validation (on top of the schema)
// ---------------------------------------------------------------------------

export interface PlanValidationContext {
  digest: InspectionDigest;
  /** Phase 5: paths that MUST be declared as create — approved cross-capability asset targets. */
  requiredCreates?: string[];
}

export function validateEngineeringPlan(plan: EngineeringPlan, ctx: PlanValidationContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const knownPaths = new Set(plan.files.map((f) => f.path));

  // Each file must be declared exactly once.
  const declared = new Set<string>();
  for (const file of plan.files) {
    if (declared.has(file.path)) {
      issues.push({
        code: "duplicate-file",
        message: `"${file.path}" is declared more than once in files`,
        path: file.path,
        hint: "declare each file exactly once — merge the duplicate entries",
      });
    }
    declared.add(file.path);

    if (isSecretPath(file.path)) {
      issues.push({ code: "secret-path", message: `"${file.path}" looks like a secret file (env/key/credentials) and cannot be touched`, path: file.path });
    } else if (isIgnoredPath(file.path)) {
      issues.push({ code: "ignored-path", message: `"${file.path}" is inside an ignored/build directory`, path: file.path });
    } else if (file.change !== "create" && !fileExistsInTree(ctx.digest, file.path)) {
      const near = closestRepositoryMatches(ctx.digest, file.path);
      issues.push({
        code: "unknown-file",
        message: `"${file.path}" does not exist in the repository but the change is "${file.change}"${near.length ? ` — closest repository files: ${near.join(", ")}` : ""}`,
        path: file.path,
        hint: `use change "create" for genuinely new files, or target one of the existing repository files`,
      });
    } else if (file.change === "create" && fileExistsInTree(ctx.digest, file.path)) {
      issues.push({ code: "file-exists", message: `"${file.path}" already exists — use change "modify"`, path: file.path, hint: "switch the change to \"modify\" and target the existing file" });
    }
  }

  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      issues.push({ code: "duplicate-step", message: `duplicate step id "${step.id}"`, stepId: step.id });
    }
    stepIds.add(step.id);
    for (const dep of step.dependsOn) {
      if (!plan.steps.some((s) => s.id === dep)) {
        issues.push({ code: "unknown-dependency", message: `step "${step.id}" depends on unknown step "${dep}"`, stepId: step.id });
      }
    }

    if (step.kind === "create_file" || step.kind === "modify_file" || step.kind === "delete_file") {
      const target = step.path ?? "";
      if (!step.path) {
        issues.push({
          code: "undeclared-file",
          message: `step "${step.id}" has no target path — file steps must set "path" to a file declared in files`,
          stepId: step.id,
          hint: "set the step's path to a declared file, or drop the step",
        });
      } else if (isUnsafeStepPath(target)) {
        issues.push({
          code: "invalid-step-path",
          message: `step "${step.id}" targets "${target}" which is not a valid workspace-relative path`,
          stepId: step.id,
          path: target,
          hint: 'use a workspace-relative path like "src/lib/ledger.ts" — no "..", no leading "/", no backslashes',
        });
      } else if (isSecretPath(target)) {
        issues.push({
          code: "secret-path",
          message: `step "${step.id}" targets "${target}" which looks like a secret file and cannot be touched`,
          stepId: step.id,
          path: target,
        });
      } else if (!knownPaths.has(target)) {
        // Root cause of the PROPOSED_FIX.md failure: the planner's steps and its
        // file manifest diverged. Report exactly where they diverged — does the
        // target exist, and did the planner intend to create or modify it?
        const exists = fileExistsInTree(ctx.digest, target);
        const intent = step.kind === "create_file" ? "create" : step.kind === "delete_file" ? "delete" : "modify";
        const hint = exists
          ? `declare "${target}" in files with change "${intent === "create" ? "modify" : intent}" and keep the step`
          : intent === "create"
            ? `declare "${target}" in files with change "create" — but do NOT invent documentation/report files (e.g. PROPOSED_FIX.md) to describe a fix; prefer modifying the existing source and test files`
            : `the planner intended to ${intent} a file that is neither declared nor present — target an existing repository file, or declare a new file with change "create"`;
        issues.push({
          code: "undeclared-file",
          message: `step "${step.id}" targets "${target}" which is not declared in files — the file ${exists ? "exists in the repository" : "does not exist in the repository"} and the planner intended to ${intent} it`,
          stepId: step.id,
          path: target,
          hint,
        });
      } else {
        const expected: Record<PlanStep["kind"], string> = {
          create_file: "create",
          modify_file: "modify",
          delete_file: "delete",
          run_command: "",
          inspect: "",
        };
        const file = plan.files.find((f) => f.path === step.path);
        if (file && expected[step.kind] && file.change !== expected[step.kind]) {
          issues.push({
            code: "change-mismatch",
            message: `step "${step.id}" is ${step.kind} but "${step.path}" is declared as "${file.change}"`,
            stepId: step.id,
            path: step.path,
          });
        }
      }
    }
    // run_command steps get their argv from validation.commands — checked there.
  }

  // Every declared file must be covered by at least one file step (no orphan writes).
  for (const file of plan.files) {
    const covered = plan.steps.some((s) => s.path === file.path && s.kind !== "run_command" && s.kind !== "inspect");
    if (!covered) {
      issues.push({ code: "uncovered-file", message: `"${file.path}" is declared but no step applies it`, path: file.path });
    }
  }

  // Phase 5: approved asset targets must actually be declared as create — an
  // integration plan that forgets the asset file is incomplete.
  for (const target of ctx.requiredCreates ?? []) {
    const declared = plan.files.find((f) => f.path === target);
    if (!declared) {
      issues.push({ code: "missing-asset-declaration", message: `the approved asset target "${target}" is not declared in files`, path: target, hint: `declare "${target}" with change "create" and a create_file step — its binary content is provided by the system` });
    } else if (declared.change !== "create") {
      issues.push({ code: "missing-asset-declaration", message: `the approved asset target "${target}" must be declared with change "create"`, path: target, hint: "the asset is new to the repository; its bytes are provided by the system" });
    }
  }

  // Command steps must reference an allowlisted command declared in validation.commands.
  const commandByLabel = new Map(plan.validation.commands.map((c) => [c.label, c]));
  for (const step of plan.steps) {
    if (step.kind === "run_command") {
      if (!step.command) {
        issues.push({ code: "command-unlinked", message: `step "${step.id}" must set "command" to the label of a declared validation command`, stepId: step.id });
      } else if (!commandByLabel.has(step.command)) {
        issues.push({
          code: "command-undeclared",
          message: `step "${step.id}" references "${step.command}" which is not in validation.commands (declared: ${[...commandByLabel.keys()].join(", ") || "none"})`,
          stepId: step.id,
        });
      }
    } else if (step.command) {
      issues.push({ code: "command-stray", message: `step "${step.id}" is a ${step.kind} step and cannot reference a command`, stepId: step.id });
    }
  }

  if (plan.steps.some((s) => s.kind === "run_command") && plan.validation.commands.length === 0) {
    issues.push({ code: "no-commands", message: "the plan runs commands but validation.commands is empty" });
  }

  if (plan.validation.commands.length === 0) {
    issues.push({ code: "validation-without-commands", message: "declare at least the workspace test command in validation.commands" });
  } else if (!plan.validation.commands.some((c) => /^bun( run .+)? test( .+)?$|^bun test/.test(c.argv.join(" ")))) {
    issues.push({ code: "no-test-command", message: "validation.commands must include a bun test run (bun test or bun run <script> pointing at tests)" });
  }

  return issues;
}

function fileExistsInTree(digest: InspectionDigest, relPath: string): boolean {
  const target = relPath.replace(/\/$/, "");
  return digest.tree.some((entry) => entry.path === target && entry.kind === "file")
    // tree is capped/depth-limited — fall back to the declared inventory lists
    || digest.testFiles.includes(target)
    || digest.entryPoints.includes(target)
    || digest.configFiles.includes(target)
    || digest.schemaFiles.includes(target)
    || digest.routeFiles.includes(target);
}

/** Step paths get the same traversal hygiene the file manifest enforces (schema + semantic). */
function isUnsafeStepPath(p: string): boolean {
  return p.includes("..") || p.startsWith("/") || p.includes("\\");
}

/**
 * Bounded "did you mean" candidates from the inspection inventory — the same
 * workspace-relative paths already shown to the model and the user. Never
 * returns secret/ignored paths (they never entered the digest).
 */
function closestRepositoryMatches(digest: InspectionDigest, target: string, max = 3): string[] {
  const candidates = new Set<string>();
  for (const entry of digest.tree) {
    if (entry.kind === "file") candidates.add(entry.path);
  }
  for (const list of [digest.testFiles, digest.entryPoints, digest.configFiles, digest.schemaFiles, digest.routeFiles]) {
    for (const p of list) candidates.add(p);
  }
  const lower = target.toLowerCase();
  const stem = (lower.split("/").pop() ?? lower).replace(/\.[a-z0-9]+$/, "");
  const targetTokens = new Set(lower.split(/[/.\-_]+/).filter((t) => t.length >= 3));
  return [...candidates]
    .map((p) => {
      const pl = p.toLowerCase();
      let score = 0;
      if (pl === lower) score = 100;
      else {
        if (stem.length >= 3 && pl.includes(stem)) score += 50;
        const pTokens = pl.split(/[/.\-_]+/);
        for (const tok of pTokens) {
          if (tok.length >= 3 && targetTokens.has(tok)) score += 15;
        }
      }
      return { p, score };
    })
    .filter((s) => s.score >= 30)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.p);
}

// ---------------------------------------------------------------------------
// Bounded structured repair
// ---------------------------------------------------------------------------

export interface PlanParseOutcome {
  ok: boolean;
  plan?: EngineeringPlan;
  issues: string[];
  repaired: boolean;
  /** Issues captured from the FIRST attempt whenever a repair happened; absent otherwise. */
  firstIssues?: string[];
}

/**
 * Parse + validate a model plan. On schema/semantic failure, `repair` is
 * invoked ONCE with the precise validation issues (spec §4: bounded repair,
 * then an actionable error — never a silent bypass, never a fake approval).
 */
export async function parsePlanWithRepair(
  rawText: string,
  ctx: PlanValidationContext,
  repair: (issues: string[], previousRaw: string) => Promise<string>,
): Promise<PlanParseOutcome> {
  const first = tryParse(rawText, ctx);
  if (first.ok) return { ...first, repaired: false };

  const repairRaw = await repair(first.issues, rawText);
  const second = tryParse(repairRaw, ctx);
  if (second.ok) return { ...second, repaired: true, firstIssues: first.issues };
  return { ok: false, issues: second.issues, repaired: true, firstIssues: first.issues };
}

function tryParse(rawText: string, ctx: PlanValidationContext): { ok: boolean; plan?: EngineeringPlan; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(rawText));
  } catch {
    return { ok: false, issues: ["Model output was not valid JSON"] };
  }
  json = canonicalizePlanVocabulary(json);
  // zod v4 does not surface the rejected value on enum failures — capture the
  // off-enum vocabulary ourselves so the bounded repair (and the user) sees
  // exactly which word to fix.
  const receivedValues = collectOffEnumValues(json);
  const parsed = engineeringPlanSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 10).map((i) => {
        const key = i.path.join(".");
        const raw = receivedValues.get(key);
        const suffix = raw ? ` (received: "${raw}")` : "";
        return `${key || "(root)"}: ${i.message}${suffix}`;
      }),
    };
  }
  const semantic = validateEngineeringPlan(parsed.data, ctx);
  if (semantic.length > 0) {
    return { ok: false, issues: semantic.slice(0, 10).map((i) => `${i.code}${i.stepId ? ` [${i.stepId}]` : ""}: ${i.message}`) };
  }
  return { ok: true, plan: parsed.data, issues: [] };
}

/**
 * Deterministic, semantics-preserving canonicalization of model plan vocabulary:
 * step IDs, file "change" verbs and step "kind" labels. Models routinely emit
 * "Propose_Fix", "update" or "edit_file" — a valid plan then dies on enum/regex
 * nits (observed live 2026-11-03, twice). Canonicalize BEFORE validation so
 * the full schema + semantic checks still run on the result; nothing is
 * bypassed. Unknown values are left untouched and fail validation honestly.
 * File PATHS are NEVER touched here (security-relevant content).
 */
const CHANGE_SYNONYMS: Record<string, string> = {
  add: "create", added: "create", new: "create", write: "create", generate: "create", insert: "create",
  update: "modify", updated: "modify", edit: "modify", edited: "modify", change: "modify", changed: "modify", refactor: "modify", patch: "modify", rewrite: "modify", implement: "modify", fix: "modify", touch: "modify",
  remove: "delete", removed: "delete", drop: "delete", rm: "delete",
  // Read-only intent: the model listed a file it only wants to LOOK at.
  // There is no read change type — the entry is dropped (never turned into a
  // write) by canonicalizePlanVocabulary.
  inspect: "READ_ONLY", read: "READ_ONLY", view: "READ_ONLY", examine: "READ_ONLY", review: "READ_ONLY", analyze: "READ_ONLY",
};

const KIND_SYNONYMS: Record<string, string> = {
  // The model conflates the change vocabulary with the step-kind vocabulary
  // (observed live: steps with kind "modify"). Map the change words onto the
  // file-step kinds.
  add: "create_file", added: "create_file", new: "create_file", write: "create_file", generate: "create_file", create: "create_file",
  edit: "modify_file", update: "modify_file", change: "modify_file", patch: "modify_file", modify: "modify_file", fix: "modify_file", implement: "modify_file", refactor: "modify_file",
  remove: "delete_file", rm: "delete_file", drop: "delete_file", delete: "delete_file",
  command: "run_command", run: "run_command", execute: "run_command", run_cmd: "run_command",
  read: "inspect", review: "inspect", analyze: "inspect", examine: "inspect", inspect: "inspect",
  add_file: "create_file", new_file: "create_file", write_file: "create_file", generate_file: "create_file",
  edit_file: "modify_file", update_file: "modify_file", change_file: "modify_file", patch_file: "modify_file", fix_file: "modify_file",
  remove_file: "delete_file", drop_file: "delete_file",
};

function canonicalizePlanVocabulary(json: unknown): unknown {
  if (typeof json !== "object" || json === null) return json;
  const obj = json as Record<string, unknown>;

  if (Array.isArray(obj.files)) {
    const kept: unknown[] = [];
    for (const file of obj.files) {
      if (typeof file !== "object" || file === null) {
        kept.push(file);
        continue;
      }
      const f = file as Record<string, unknown>;
      if (typeof f.change === "string") {
        const key = f.change.trim().toLowerCase();
        const mapped = CHANGE_SYNONYMS[key];
        if (mapped === "READ_ONLY") continue; // read-only intent — not a file change
        if (mapped && f.change !== mapped) f.change = mapped;
      }
      kept.push(f);
    }
    obj.files = kept;
  }

  const steps = obj.steps;
  if (!Array.isArray(steps)) return json;

  const used = new Set<string>();
  const idMap = new Map<string, string>();
  const canonical = (raw: string): string => {
    let next =
      raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "step";
    let n = 2;
    while (used.has(next)) next = `${next.replace(/-\d+$/, "")}-${n++}`;
    used.add(next);
    return next;
  };

  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;
    if (typeof s.kind === "string") {
      const key = s.kind.trim().toLowerCase();
      const mapped = KIND_SYNONYMS[key];
      if (mapped && s.kind !== mapped) s.kind = mapped;
    }
    if (typeof s.id !== "string") continue;
    const mappedId = /^[a-z0-9][a-z0-9-]{0,39}$/.test(s.id) ? s.id : canonical(s.id);
    if (mappedId !== s.id) idMap.set(s.id, mappedId);
    s.id = mappedId;
  }
  // Keep dependsOn references pointing at the same steps after normalization.
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const deps = (step as Record<string, unknown>).dependsOn;
    if (!Array.isArray(deps)) continue;
    for (let i = 0; i < deps.length; i += 1) {
      const mapped = idMap.get(String(deps[i]));
      if (mapped) deps[i] = mapped;
    }
  }
  return json;
}

/**
 * Capture off-enum vocabulary (files[].change, steps[].kind) before the schema
 * runs — zod v4 does not echo the rejected value, and "Invalid option" without
 * the received word is not actionable for the repair pass or the user.
 */
function collectOffEnumValues(json: unknown): Map<string, string> {
  const received = new Map<string, string>();
  if (typeof json !== "object" || json === null) return received;
  const obj = json as Record<string, unknown>;
  const CHANGE_ALLOWED = new Set(["create", "modify", "delete"]);
  const KIND_ALLOWED = new Set(["create_file", "modify_file", "delete_file", "run_command", "inspect"]);
  if (Array.isArray(obj.files)) {
    (obj.files as unknown[]).forEach((f, i) => {
      if (typeof f !== "object" || f === null) return;
      const change = (f as Record<string, unknown>).change;
      if (typeof change === "string") {
        const trimmed = change.trim().slice(0, 60);
        if (trimmed && !CHANGE_ALLOWED.has(trimmed.toLowerCase())) received.set(`files.${i}.change`, trimmed);
      }
    });
  }
  if (Array.isArray(obj.steps)) {
    (obj.steps as unknown[]).forEach((s, i) => {
      if (typeof s !== "object" || s === null) return;
      const kind = (s as Record<string, unknown>).kind;
      if (typeof kind === "string") {
        const trimmed = kind.trim().slice(0, 60);
        if (trimmed && !KIND_ALLOWED.has(trimmed.toLowerCase())) received.set(`steps.${i}.kind`, trimmed);
      }
    });
  }
  return received;
}

function stripFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return body.trim();
  return body.slice(start, end + 1);
}
