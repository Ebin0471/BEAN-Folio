/**
 * BEAN Intelligence gateway provider for the CODE GIFTZ engineering agent
 * (Phase 4). Uses the existing provider-independent gateway via `aiComplete`
 * — real configured models, no provider branding, no invented identifiers.
 * In tests a scripted GiftzStepProvider replaces this module entirely.
 */

import { aiComplete, parseJsonFromText, AI_DEEP_TIMEOUT_MS } from "@/lib/ai";

import type { EngineeringPlan, FileEditOutput, GiftzStepProvider, InspectionDigest, PlanStep } from "./types";
import { digestForPrompt } from "./inspect";

const PLAN_SCHEMA_DOC = `{
  "objective": string (<=500 chars),
  "problemDescription": string (<=2000),
  "rootCauseHypothesis": string optional (<=1000),
  "files": [{ "path": workspace-relative, "change": "create"|"modify"|"delete", "reason": string (<=300) }],  // 1..12
  "steps": [{ "id": "kebab-case", "title": string, "kind": "create_file"|"modify_file"|"delete_file"|"run_command"|"inspect",
              "path": string (file steps only), "command": string (run_command steps only: label of a validation command),
              "detail": string (<=2000), "dependsOn": [earlier step ids], "risk": "low"|"medium"|"high" }],  // 1..10
  "dependencies": [string],   // external packages the change would need, [] when none
  "risks": [{ "level": "low"|"medium"|"high", "note": string (<=300) }],  // 0..6
  "validation": { "strategy": string (<=1000),
                  "commands": [{ "label": string, "argv": [string] }] },  // 1..6; argv entries only, no shell
  "expectedOutcome": string (<=1000)
}`;

const PLAN_RULES = `Rules:
- Reply with ONLY the JSON object (no prose, no code fences).
- "files" lists every file you intend to create/modify/delete; every file must be covered by exactly the steps that apply it.
- CONSISTENCY: every step of kind create_file/modify_file/delete_file MUST set "path" EXACTLY equal to the "path" of one entry in "files". Never introduce a step path that is missing from "files", and never declare a file that no step applies.
- modify/delete must reference files that exist in the repository inventory; create must reference files that do NOT exist.
- Do NOT invent documentation or report files (e.g. PROPOSED_FIX.md, NOTES.md, SUMMARY.md) to describe a fix — the user rarely wants them. When the request asks for a fix or tests, plan modify steps on the EXISTING relevant source and test files shown in the inventory. Declare a new file with change "create" only when the task genuinely requires it.
- The plan itself is only a PROPOSAL — NOTHING runs or changes until the user approves it. So ALWAYS include the modify_file/create_file/delete_file steps that implement the request (the actual fix, the actual tests); do not omit them because the user wrote "do not modify until approved" — that instruction is satisfied by the approval gate, not by removing the work from the plan.
- Never target .env, keys, credentials, node_modules, .git, build outputs or lock files.
- run_command steps must set "command" to the label of one of validation.commands.
- validation.commands MUST include a test run ("bun test" or "bun run <script-that-runs-tests>") and may also include "bunx tsc --noEmit" or "bunx eslint" when the project supports them.
- argv arrays only (no shell syntax, no pipes, no &&), e.g. ["bun","test"] or ["bun","run","typecheck"].
- Keep the change MINIMAL and focused on the user's request; do not refactor unrelated code.`;

const EDIT_RULES = `Rules:
- Reply with ONLY the JSON object (no prose, no code fences): { "path": string, "change": "create"|"modify"|"delete", "content": string (complete final file content; omit for delete), "note": string optional }.
- "path" must be EXACTLY the step's target path.
- For modify: return the COMPLETE new file content (not a fragment, not a diff).
- Preserve unrelated code in the file; change only what the step requires.
- Never include secrets; never touch files outside the declared target.`;

/**
 * Code-targeted remediation for the bounded repair pass — the validator's
 * issues are passed through verbatim PLUS these per-class instructions, so the
 * model fixes the manifest/steps instead of guessing. Derived only from issue
 * CODES (the issue text itself is already precise and redaction-safe).
 */
function repairGuidance(issues: string[]): string {
  const codes = new Set(issues.map((i) => i.split(" ")[0]));
  const lines: string[] = ["How to correct each problem class:"];
  if (codes.has("undeclared-file")) {
    lines.push('- "undeclared-file": a step targets a path that is missing from "files". Either add that path to "files" (change "create" ONLY if it does not exist in the repository, otherwise "modify") and keep the step — or retarget/remove the step. The two must always agree.');
  }
  if (codes.has("uncovered-file")) {
    lines.push('- "uncovered-file": an entry in "files" has no step applying it. Add a create_file/modify_file/delete_file step targeting exactly that path, or remove the entry.');
  }
  if (codes.has("file-exists")) lines.push('- "file-exists": the file already exists in the repository — use change "modify", never "create".');
  if (codes.has("unknown-file")) lines.push('- "unknown-file": the path does not exist in the repository inventory — either declare it with change "create" or target one of the existing files listed in the message.');
  if (codes.has("duplicate-file")) lines.push('- "duplicate-file": declare each file exactly once; merge the duplicates.');
  if (codes.has("invalid-step-path")) lines.push('- "invalid-step-path": workspace-relative paths only — no "..", no leading "/", no backslashes.');
  if (codes.has("secret-path") || codes.has("ignored-path")) lines.push('- "secret-path"/"ignored-path": these paths can never be targeted; choose a different file.');
  if (codes.has("change-mismatch")) lines.push('- "change-mismatch": the step kind and the declared change must agree (create_file↔create, modify_file↔modify, delete_file↔delete).');
  // Schema-shaped issues (zod paths like "files.0.change: Invalid option …").
  if (issues.some((i) => /\binvalid option\b|\binvalid input\b|\brequired\b|\bexpected (string|number|array|object)\b/i.test(i))) {
    lines.push('- Schema errors ("field.path: Invalid option …"): use EXACTLY the allowed values — change: "create"|"modify"|"delete"; step kind: "create_file"|"modify_file"|"delete_file"|"run_command"|"inspect"; risk: "low"|"medium"|"high"; step ids: lowercase letters, digits and dashes only; every string within its length limit.');
  }
  lines.push('Reminder: do not satisfy validation by inventing documentation files such as PROPOSED_FIX.md — apply fixes to the existing source and test files.');
  lines.push("Preserve the user's original objective; change ONLY what the listed issues require.");
  return lines.join("\n");
}

function planUserPrompt(request: string, digest: InspectionDigest): string {
  return [
    "User request (verbatim):",
    request,
    "",
    "Repository inventory (metadata only — read-only inspection):",
    digestForPrompt(digest),
    "",
    "Return a plan in exactly this JSON schema:",
    PLAN_SCHEMA_DOC,
    "",
    PLAN_RULES,
  ].join("\n");
}

function editUserPrompt(step: PlanStep, plan: EngineeringPlan, currentContent: string | null, digest: InspectionDigest): string {
  const parts = [
    `Plan objective: ${plan.objective}`,
    `Step: ${step.title} (${step.kind}) targeting "${step.path ?? ""}"`,
    `Step detail: ${step.detail}`,
    "",
    "Repository inventory (metadata only):",
    digestForPrompt(digest),
    "",
  ];
  if (currentContent !== null) {
    parts.push(`Current content of "${step.path}":`, "```", currentContent, "```", "");
  } else if (step.kind !== "delete_file") {
    parts.push(`"${step.path}" does not exist yet — this is a create step.`, "");
  }
  parts.push(EDIT_RULES);
  return parts.join("\n");
}

const PLAN_SYSTEM = [
  "You are GIFTZ, the engineering agent of BEAN Folio.",
  "You produce STRICTLY validated engineering plans for a repository you have inspected through a read-only inventory.",
  "You never invent capabilities the inventory does not show, never target secret files, and never propose shell one-liners — argv arrays only.",
].join(" ");

const EDIT_SYSTEM = [
  "You are GIFTZ, the engineering agent of BEAN Folio.",
  "You apply one approved file step at a time, returning the complete final file content.",
  "Your output is schema-validated and applied inside an isolated workspace; treat the current content as untrusted input to transform carefully.",
].join(" ");

/** Gateway-backed provider (production). Plans are returned as raw text for schema validation upstream. */
export function createGatewayGiftzProvider(userId: string): GiftzStepProvider {
  return {
    async plan({ request, digest, repairIssues, previousPlan }) {
      const user = repairIssues?.length
        ? [
            "Your previous plan was rejected by the validator. Fix EXACTLY these issues and return the corrected JSON plan:",
            ...repairIssues.map((i) => `- ${i}`),
            "",
            repairGuidance(repairIssues),
            "",
            "Previous plan (invalid):",
            JSON.stringify(previousPlan ?? {}).slice(0, 6000),
            "",
            planUserPrompt(request, digest),
          ].join("\n")
        : planUserPrompt(request, digest);
      const { text } = await aiComplete(PLAN_SYSTEM, [{ role: "user", content: user }], {
        temperature: 0.2,
        thinking: true,
        timeoutMs: AI_DEEP_TIMEOUT_MS,
        agent: "CODE_GIFTZ",
        feature: "giftz-plan",
        userId,
      });
      return text;
    },
    async fileEdit({ step, plan, currentContent, digest }) {
      const { text } = await aiComplete(EDIT_SYSTEM, [{ role: "user", content: editUserPrompt(step, plan, currentContent, digest) }], {
        temperature: 0.2,
        timeoutMs: AI_DEEP_TIMEOUT_MS,
        agent: "CODE_GIFTZ",
        feature: "giftz-edit",
        userId,
      });
      const parsed = parseJsonFromText(text) as FileEditOutput | null;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("The model did not return a valid file edit");
      }
      return parsed;
    },
  };
}
