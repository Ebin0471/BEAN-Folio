/**
 * Code Giftz — the step executor (server-only).
 *
 * Runs a job's steps against the working config using the ONLY supported
 * mutation surface: the validated SiteConfig. Deterministic tools (token
 * patches, curated library ids) apply exactly and need no model call; model
 * tools run one scoped LLM step each whose output must pass the site schema
 * before it touches the working config. After EVERY step the plan's
 * preservation constraints are enforced — violations are repaired
 * byte-identically from the base config and reported, never silently kept.
 *
 * The provider is injected, so tests can exercise the full pipeline (success,
 * tool failure, retry, cancellation) without any network.
 */
import { normalizeConfig, designPresets, templatePresets, deriveTheme, normalizeMotion, TEMPLATE_IDS, explainConfigIssues } from "@/lib/site-config";
import type { SiteConfig } from "@/lib/site-config";
import { getPalette } from "@/lib/site-palettes";
import { parseJsonFromText, type AiMessage } from "@/lib/ai";
import type { DesignPatch, PlanStep } from "@/lib/ai-design/plan";
import type { DesignJob } from "@/lib/ai-design/jobs";
import { touch, appendEvent, nextRetryBackoffMs } from "@/lib/ai-design/jobs";
import { resolvedConstraintTargets, checkConstraints, restorePreserved, type ResolvedConstraintTarget } from "@/lib/ai-design/constraints";
import { buildVerificationReport, type VerificationReport } from "@/lib/ai-design/verify";
import { summarizeChanges } from "@/lib/ai-design/diff";
import { stepSystemPrompt, composeStepSystemPrompt, stepRepairPrompt } from "@/lib/ai-design/prompts";
import { getTool } from "@/lib/ai-design/tools";
import { loadMaterialsForRequest, materialsBlock } from "@/lib/ai-design/ingest";
import { persistDesignJobTerminalState } from "@/lib/ai-design/durability";

export interface StepProvider {
  /**
   * `opts.feature` (optional) labels repair calls in the gateway routing logs
   * — implementations pass it through to aiComplete, tests may ignore it.
   */
  complete(system: string, messages: AiMessage[], opts?: { temperature?: number; feature?: string }): Promise<{ text: string }>;
}

/**
 * Server-side grounding passed to model steps. Built ONCE per job by the
 * execute route (which owns the DB session) so steps never fetch per-step.
 */
export interface StepContext {
  /** Pre-rendered source-materials block (user's own uploaded content). */
  materialsText?: string;
  /** Pre-rendered portfolio grounding block (the user's own data). */
  portfolioText?: string;
  /** Pre-rendered BINDING creative-direction block — keeps every step on-brief. */
  directionText?: string;
  /**
   * Media ids the execution may reference (driver-supplied; owner-validated
   * before every chunk — see resolveStepContext in ai-design/driver.ts).
   */
  allowedMediaIds?: string[];
}

/** Error with a user-safe message — step-level failures never leak internals. */
export class StepError extends Error {}

// ------------------------------------------------------------ model steps

/** Result of running one model response through the step resolver. */
interface StepResolution {
  ok: boolean;
  config?: SiteConfig;
  changes?: string[];
  /** Precise, schema-derived diagnostics when !ok — never internal noise. */
  issues: string[];
  /** The raw model text the issues refer to (fed back to the repair round). */
  rawText: string;
}

/**
 * Parse one model response into a validated step result. EXACTLY the same
 * acceptance rules as before (parse → shape check → site schema) — but a
 * rejection now carries the REAL reasons from `explainConfigIssues` instead
 * of collapsing into a generic "did not match" message.
 */
function resolveStepResult(text: string, working: SiteConfig, composeCoerceTemplate: boolean): StepResolution {
  const parsed = parseJsonFromText<{ changes?: unknown; config?: unknown }>(text);
  if (!parsed || typeof parsed !== "object" || parsed.config === undefined || parsed.config === null) {
    return { ok: false, issues: ["The response was not a single JSON object with a \"config\"."], rawText: text };
  }
  // The compose prompt tells the model the template id is a LABEL ("pick the
  // closest one — the theme tokens you write define the real look"). Models
  // still sometimes return an out-of-library name; coerce that one field to
  // the neutral generalist template instead of discarding the whole
  // (expensive) composition. Everything else must pass the real schema.
  if (composeCoerceTemplate && parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config)) {
    const cfg = parsed.config as Record<string, unknown>;
    if (typeof cfg.template !== "string" || !(TEMPLATE_IDS as readonly string[]).includes(cfg.template)) {
      cfg.template = "polymath-index";
    }
  }
  const normalized = normalizeConfig(parsed.config);
  if (!normalized) {
    const issues = explainConfigIssues(parsed.config);
    return {
      ok: false,
      issues: issues.length > 0 ? issues : ["The result did not satisfy the website schema."],
      rawText: text,
    };
  }
  const changes =
    Array.isArray(parsed.changes) && parsed.changes.every((c) => typeof c === "string" && c.length > 0)
      ? (parsed.changes as string[]).slice(0, 10)
      : summarizeChanges(working, normalized);
  return { ok: true, config: normalized, changes, issues: [], rawText: text };
}

/**
 * Run ONE model step with the SAME bounded self-repair the planner has:
 * when the site schema rejects the result, the model gets exactly ONE repair
 * round — its own rejected JSON + the REAL validation issues — and the
 * repaired answer re-enters the identical resolver. A first-try-valid result
 * behaves byte-for-byte as before (no extra model call). A step that cannot
 * be repaired fails with the precise schema diagnostics, never a generic
 * "did not match the website schema" shrug.
 */
async function runModelStep(
  step: PlanStep,
  system: string,
  messages: AiMessage[],
  working: SiteConfig,
  provider: StepProvider,
  composeCoerceTemplate: boolean
): Promise<{ config: SiteConfig; changes: string[] }> {
  let text: string;
  try {
    ({ text } = await provider.complete(system, messages, { temperature: 0.4 }));
  } catch (e) {
    const reason = e instanceof Error && e.message ? e.message.slice(0, 200) : "the model call did not complete";
    throw new StepError(`The model call for this step failed — ${reason}`);
  }

  const first = resolveStepResult(text, working, composeCoerceTemplate);
  if (first.ok) return { config: first.config!, changes: first.changes! };

  console.warn(
    `[ai-design] step "${step.title}" (${step.tool}) was rejected — starting one bounded repair round. Issues: ${first.issues.join(" | ").slice(0, 500)}`
  );

  let repairText: string;
  try {
    ({ text: repairText } = await provider.complete(
      stepRepairPrompt(step, first.rawText, first.issues),
      messages,
      { temperature: 0.2, feature: "step-repair" }
    ));
  } catch {
    // The repair call itself failing (quota, timeout) must not mask the real
    // schema diagnostics — they ARE the useful error.
    throw new StepError(
      `Schema validation rejected the step's result (${first.issues.slice(0, 3).join(";").slice(0, 300)}), and the one repair attempt could not run.`
    );
  }

  const second = resolveStepResult(repairText, working, composeCoerceTemplate);
  if (second.ok) {
    console.warn(`[ai-design] step "${step.title}" (${step.tool}) was repaired successfully after one schema-rejection round.`);
    return { config: second.config!, changes: second.changes! };
  }
  throw new StepError(
    `Schema validation rejected the step's result twice — ${second.issues.slice(0, 3).join(";").slice(0, 300)}`
  );
}

// ------------------------------------------------------------ deterministic tools

/**
 * Merge a deterministic token patch onto a config and re-validate through the
 * site schema. Structural fields (pages/sections/template) are never patched.
 */
export function applyPatchConfig(config: SiteConfig, patch: DesignPatch): SiteConfig {
  const themeInput = { ...config.theme } as Record<string, unknown>;
  const motionInput = { ...config.motion } as Record<string, unknown>;
  if (patch.theme) {
    const { headingFont, bodyFont, accentFont, codeFont, glass, ...tokens } = patch.theme;
    Object.assign(themeInput, tokens);
    if (headingFont !== undefined) themeInput.headingFont = headingFont;
    if (bodyFont !== undefined) themeInput.bodyFont = bodyFont;
    if (accentFont !== undefined) themeInput.accentFont = accentFont;
    if (codeFont !== undefined) themeInput.codeFont = codeFont;
    if (glass !== undefined) {
      // Glass is DEEP-MERGED, not replaced: a step that tunes ONE aspect
      // ("blur: 24") must not reset the user's preset/tint/targets, and a
      // partial targets patch keeps the untouched targets. null = glass off.
      if (glass === null) {
        themeInput.glass = null;
      } else {
        const base =
          themeInput.glass && typeof themeInput.glass === "object" && !Array.isArray(themeInput.glass)
            ? (themeInput.glass as Record<string, unknown>)
            : {};
        const merged: Record<string, unknown> = { ...base, ...glass };
        const baseTargets =
          base.targets && typeof base.targets === "object" && !Array.isArray(base.targets)
            ? (base.targets as Record<string, unknown>)
            : {};
        merged.targets = { ...baseTargets, ...(glass.targets ?? {}) };
        themeInput.glass = merged;
      }
    }
  }
  if (patch.motion) {
    const { gsap, ...motionTokens } = patch.motion;
    Object.assign(motionInput, motionTokens);
    if (gsap === null) {
      delete motionInput.gsap;
    } else if (gsap !== undefined) {
      // GSAP block deep-merges scalars and REPLACES the animation list when
      // the patch carries one — a deterministic, auditable contract.
      const base = (motionInput.gsap && typeof motionInput.gsap === "object" && !Array.isArray(motionInput.gsap)
        ? (motionInput.gsap as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...base, ...gsap };
      if (gsap.animations === undefined) delete merged.animations;
      if (Object.keys(merged).length === 0) delete motionInput.gsap;
      else motionInput.gsap = merged;
    }
  }

  try {
    const candidate: SiteConfig = {
      ...config,
      name: patch.name ?? config.name,
      tagline: patch.tagline ?? config.tagline,
      theme: deriveTheme(themeInput as Parameters<typeof deriveTheme>[0]),
      motion: normalizeMotion({ ...motionInput }),
      ...(patch.backgroundEffects !== undefined
        ? { backgroundEffects: patch.backgroundEffects === null ? undefined : patch.backgroundEffects }
        : config.backgroundEffects !== undefined
          ? { backgroundEffects: config.backgroundEffects }
          : {}),
      ...(patch.scene3d !== undefined
        ? { scene3d: patch.scene3d === null ? undefined : patch.scene3d }
        : config.scene3d !== undefined
          ? { scene3d: config.scene3d }
          : {}),
      pages: config.pages,
    };
    const normalized = normalizeConfig(candidate);
    if (!normalized) throw new StepError("The step's token patch did not produce a valid website configuration.");
    return normalized;
  } catch (e) {
    // Schema parsing can throw (zod) on malformed token values — always
    // surface a SAFE StepError, never a raw parser error.
    if (e instanceof StepError) throw e;
    throw new StepError("The step's token patch did not produce a valid website configuration.");
  }
}

/** palette.apply — copy the curated palette's color tokens (color tokens ONLY). */
function applyPalette(config: SiteConfig, paletteId: string): SiteConfig {
  const p = getPalette(paletteId);
  if (!p) throw new StepError(`Palette “${paletteId}” is not in the color-system library.`);
  return applyPatchConfig(config, {
    theme: {
      background: p.tokens.background,
      foreground: p.tokens.foreground,
      accent: p.tokens.accent,
      accent2: p.tokens.accent2,
      surface: p.tokens.surface,
      border: p.tokens.border,
      muted: p.tokens.muted,
      focus: p.tokens.focus,
      gradient: p.tokens.gradient ?? null,
    },
  });
}

/** preset.apply — a curated full token set (colors + type + motion). */
function applyPreset(config: SiteConfig, presetId: string): SiteConfig {
  const preset = designPresets().find((p) => p.id === presetId);
  if (!preset) throw new StepError(`Design preset “${presetId}” is not in the library.`);
  const next: SiteConfig = {
    ...config,
    theme: deriveTheme({ ...preset.theme }),
    motion: preset.motion ? normalizeMotion({ ...config.motion, ...preset.motion }) : config.motion,
  };
  const normalized = normalizeConfig(next);
  if (!normalized) throw new StepError("The design preset did not produce a valid configuration.");
  return normalized;
}

/** template.apply — template defaults (theme/motion/nav); pages and content kept. */
function applyTemplate(config: SiteConfig, templateId: string): SiteConfig {
  const t = templatePresets().find((x) => x.id === templateId);
  if (!t) throw new StepError(`Template “${templateId}” is not in the library.`);
  const next: SiteConfig = {
    ...config,
    template: t.id,
    theme: deriveTheme(t.theme),
    motion: t.motion ? normalizeMotion({ ...config.motion, ...t.motion }) : config.motion,
  };
  const normalized = normalizeConfig(next);
  if (!normalized) throw new StepError("The template did not produce a valid configuration.");
  return normalized;
}

// ------------------------------------------------------------ step execution

function targetsDoc(step: PlanStep): string {
  if (step.targets.length === 0) return "(no specific targets — the step defines its own)";
  return step.targets.map((t) => `“${t}”`).join(", ");
}

/**
 * Execute one step → the next working config + its change list.
 * `constraintTargets` are the plan's resolved preservation constraints —
 * passed to the model PROACTIVELY so protected regions are respected during
 * generation, not just repaired after. `ctx` carries the job's grounding for
 * site.compose steps. Throws StepError with a SAFE message on failure.
 */
export async function applyStep(
  working: SiteConfig,
  step: PlanStep,
  baseConfig: SiteConfig,
  provider: StepProvider,
  constraintTargets: ResolvedConstraintTarget[] = [],
  ctx: StepContext = {}
): Promise<{ config: SiteConfig; changes: string[] }> {
  const tool = getTool(step.tool);
  if (!tool) throw new StepError(`Unknown tool “${step.tool}” — step cannot run.`);

  // -------- deterministic tools --------
  if (tool.id === "theme.tokens" || tool.id === "typography.fonts" || tool.id === "motion.configure") {
    if (!step.patch || Object.keys(step.patch).length === 0) throw new StepError("The step carries no token patch to apply.");
    const next = applyPatchConfig(working, step.patch);
    return { config: next, changes: summarizeChanges(working, next) };
  }
  if (tool.id === "palette.apply") {
    const next = applyPalette(working, step.targets[0] ?? "");
    return { config: next, changes: summarizeChanges(working, next) };
  }
  if (tool.id === "preset.apply") {
    const next = applyPreset(working, step.targets[0] ?? "");
    return { config: next, changes: summarizeChanges(working, next) };
  }
  if (tool.id === "template.apply") {
    const next = applyTemplate(working, step.targets[0] ?? "");
    return { config: next, changes: summarizeChanges(working, next) };
  }

  // -------- model tools --------
  // The plan's REAL preservation constraints go into the step prompt, so the
  // model respects them while generating (the runner still enforces them
  // mechanically after every step — belt and braces).
  const constraintsText =
    constraintTargets.length > 0
      ? `Preservation constraints (MUST stay byte-identical): ${constraintTargets
          .map((t) => `${t.kind} ${t.value}`)
          .join(", ")}.`
      : "No explicit preservation constraints.";

  // site.compose — a COMPLETE custom composition from the user's own
  // materials + vision (the "create my own website" workflow).
  if (tool.id === "site.compose") {
    const materialsBlockText = ctx.materialsText?.trim()
      ? ctx.materialsText
      : "Source materials: none uploaded — compose from the portfolio context and the vision alone, leaving content placeholders the user fills in.";
    const portfolioBlockText = ctx.portfolioText?.trim() ? ctx.portfolioText : "Portfolio context: unavailable.";
    const system = composeStepSystemPrompt(constraintsText, ctx.directionText);
    const userContent = [
      `The user's vision (verbatim):
"""
${step.instruction}
"""`,
      materialsBlockText,
      portfolioBlockText,
      `For schema-label purposes the current draft is (its structure should NOT be copied):
${JSON.stringify(working)}`,
    ].join("\n\n");
    return runModelStep(step, system, [{ role: "user", content: userContent }], working, provider, true);
  }

  const system = stepSystemPrompt(constraintsText, ctx.directionText);
  const userContent = [
    `Current website configuration:\n${JSON.stringify(working)}`,
    `Step to execute — ${step.title} (tool: ${step.tool})`,
    `Targets: ${targetsDoc(step)}`,
    `Instruction: ${step.instruction}`,
    `Context for this step: preserve everything not in scope; the base draft the plan was approved against is:\n${JSON.stringify(baseConfig)}`,
  ].join("\n\n");
  return runModelStep(step, system, [{ role: "user", content: userContent }], working, provider, false);
}

// The executor receives constraints straight from the job's plan.
/** Compact page/section shape the constraint resolver needs. */
function digestShape(base: SiteConfig) {
  return {
    pages: base.pages.map((p) => ({ id: p.id, name: p.name, sections: p.sections.map((s) => ({ id: s.id, type: s.type })) })),
  };
}

// ------------------------------------------------------------ job runner

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled" | "yielded";
  failedSteps: number;
}

/**
 * Optional driver controls (M20 audit fix): the execution driver drives jobs
 * in BOUNDED chunks under an atomic lease. When `budgetMs` is provided the
 * runner yields between steps once the budget is spent (completed steps are
 * persisted and never re-run); `persist` receives the job after every step
 * so progress survives; `recheckCancel` re-validates cancellation against
 * the live store before each step starts. All are optional — the routes'
 * direct run-to-completion calls are unchanged.
 */
export interface RunOptions {
  budgetMs?: number;
  persist?: (job: DesignJob) => void | Promise<unknown>;
  recheckCancel?: () => Promise<boolean>;
}

/**
 * Honest, specific failure report for a finished job with failed steps:
 * WHICH steps failed (name + operation type + the ACTUAL error), WHAT
 * survived (completed steps preserved and previewable), and whether a retry
 * is possible. Replaces the old generic one-liner that claimed "completed
 * steps are previewable" even when the pipeline discarded them.
 */
export function describeFailedSteps(job: DesignJob): string {
  const failed = job.steps.filter((s) => s.status === "failed");
  const done = job.steps.filter((s) => s.status === "done" || s.status === "repaired").length;
  const total = job.steps.length;
  const list = failed
    .map((s) => `“${s.title}” (tool ${s.tool}, stage: execution) — ${s.error ?? "the step failed"}`)
    .join("; ");
  const capped = list.length > 600 ? `${list.slice(0, 597)}…` : list;
  if (done === 0) {
    return `${failed.length} of ${total} steps could not be completed — no changes were applied and your draft is unchanged. Failed: ${capped}. You can retry the failed step${failed.length === 1 ? "" : "s"}.`;
  }
  return `${failed.length} of ${total} steps could not be completed — the other ${done} completed step${done === 1 ? " was" : "s were"} preserved and ${done === 1 ? "is" : "are"} previewable. Failed: ${capped}. You can retry just the failed step${failed.length === 1 ? "" : "s"}.`;
}

/**
 * Run a job to completion (in dependency order, honoring cancellation and
 * previous progress). Mutates the job in place; the route reads progress by
 * polling the store. `stepContext` carries the grounding built once by the
 * execute route (source materials + portfolio block).
 */
export async function runDesignJob(job: DesignJob, provider: StepProvider, stepContext: StepContext = {}, opts: RunOptions = {}): Promise<RunOutcome> {
  job.status = "running";
  touch(job);
  // Crash recovery (durable store): a step left "running" by a dead executor
  // is reset and re-run from its start on the next claim — never silently
  // lost, never double-applied (steps are idempotent by construction).
  if (job.steps.some((s) => s.status === "running")) {
    for (const s of job.steps) if (s.status === "running") s.status = "pending";
    appendEvent(job, "warn", "Resumed after an interruption — the interrupted step re-runs from its start.");
    touch(job);
  }
  const constraintTargets = resolvedConstraintTargets(job.plan, digestShape(job.baseConfig));
  // `budgetMs: 0` is a legitimate "yield before the first step" budget —
  // check explicitly instead of by truthiness.
  const budgetDeadline = opts.budgetMs !== undefined ? Date.now() + opts.budgetMs : null;

  for (const step of job.steps) {
    const cancelFlagged = job.cancelRequested || (opts.recheckCancel ? await opts.recheckCancel().catch(() => false) : false);
    if (cancelFlagged) {
      for (const s of job.steps) if (s.status === "pending") s.status = "skipped";
      job.status = "cancelled";
      job.error = "Cancelled at your request — completed steps are kept in the preview.";
      touch(job);
      // Terminal state is persisted through the SAME durable store the driver
      // uses (the job may be executed by a worker on another instance) plus
      // the additive AgentTask shadow for history.
      if (opts.persist) await Promise.resolve(opts.persist(job)).catch(() => {});
      void persistDesignJobTerminalState(job);
      return { status: "cancelled", failedSteps: 0 };
    }
    // Bounded chunking: yield BEFORE starting another step once the budget
    // is spent — completed steps are persisted and the next poll resumes.
    if (budgetDeadline !== null && Date.now() >= budgetDeadline && job.steps.some((s) => s.status === "pending")) {
      return { status: "yielded", failedSteps: 0 };
    }
    // dependent steps of a failed/skipped step are skipped
    if (step.status === "pending") {
      const failedDep = step.dependsOn.some((dep) => {
        const d = job.steps.find((s) => s.id === dep);
        return d && (d.status === "failed" || d.status === "skipped");
      });
      if (failedDep) {
        step.status = "skipped";
        step.error = "Skipped — a step it depends on did not complete.";
        touch(job);
      }
    }
    if (step.status !== "pending") continue;

    step.status = "running";
    touch(job);
    try {
      const before = job.working;
      const result = await applyStep(before, step, job.baseConfig, provider, constraintTargets, stepContext);
      let next = result.config;

      // Constraint enforcement — protected regions are restored byte-identically.
      const violations = checkConstraints(job.baseConfig, next, constraintTargets);
      if (violations.length > 0) {
        const repaired = restorePreserved(job.baseConfig, next, constraintTargets);
        next = repaired.config;
        const normalized = normalizeConfig(next);
        if (!normalized) throw new StepError("The step conflicted with a preservation constraint and could not be repaired.");
        next = normalized;
        step.status = "repaired";
        step.changes = [...result.changes, `Restored protected content that the step had changed: ${repaired.restored.join(", ")}.`];
      } else {
        step.status = "done";
        step.changes = result.changes;
      }
      job.working = next;
      job.changes = [...job.changes, ...step.changes];
    } catch (e) {
      step.status = "failed";
      step.error = e instanceof StepError ? e.message : "The step failed while applying changes. You can retry from here.";
      touch(job);
    }
    // Structured execution log, persisted per step with the job (bounded).
    appendEvent(
      job,
      step.status === "failed" ? "error" : "info",
      step.status === "failed"
        ? `Step "${step.title}" failed: ${step.error ?? "unknown error"}`
        : `Step "${step.title}" ${step.status}.`
    );
    // Per-step progress persistence (driver lease model: whoever can execute
    // drives progress; a vanished poll never loses completed work).
    if (opts.persist) await Promise.resolve(opts.persist(job)).catch(() => {});
  }

  const failed = job.steps.filter((s) => s.status === "failed").length;
  const skipped = job.steps.filter((s) => s.status === "skipped").length;

  if (failed > 0) {
    job.status = "failed";
    job.error = describeFailedSteps(job);
    job.verification = buildVerificationReport(job.baseConfig, job.working, constraintTargets);
    // Retry backpressure: a failed run stamps the exponential gate so a
    // failing job cannot hammer the provider via immediate retries.
    job.nextAttemptAt = Date.now() + nextRetryBackoffMs(job.attempt ?? 0);
    touch(job);
    if (opts.persist) await Promise.resolve(opts.persist(job)).catch(() => {});
    void persistDesignJobTerminalState(job);
    return { status: "failed", failedSteps: failed };
  }

  job.status = "completed";
  job.verification = buildVerificationReport(job.baseConfig, job.working, constraintTargets);
  if (skipped > 0) job.error = `${skipped} step${skipped === 1 ? " was" : "s were"} skipped because an earlier step failed previously.`;
  touch(job);
  if (opts.persist) await Promise.resolve(opts.persist(job)).catch(() => {});
  void persistDesignJobTerminalState(job);
  return { status: "completed", failedSteps: 0 };
}

/** Run verification over the current working config (used after retries too). */
export function verifyJob(job: DesignJob): VerificationReport {
  const constraintTargets = resolvedConstraintTargets(job.plan, digestShape(job.baseConfig));
  return buildVerificationReport(job.baseConfig, job.working, constraintTargets);
}
