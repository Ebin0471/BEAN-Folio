/**
 * CODE GIFTZ — Engineering Agent (Phase 4) shared types.
 *
 * Lifecycle (persisted on AgentTask.status for kind "ENGINEERING_TASK"):
 *   QUEUED → ANALYZING → PLANNING → AWAITING_APPROVAL → EXECUTING → VALIDATING
 *   → TESTING → COMPLETED | FAILED | CANCELLED
 *
 * The status column is a plain string shared with the other agents; the
 * engineering vocabulary is additive and documented in prisma/schema.prisma.
 */

export const GIFTZ_AGENT = "CODE_GIFTZ" as const;
export const GIFTZ_TASK_KIND = "ENGINEERING_TASK" as const;

export type EngineeringStatus =
  | "QUEUED"
  | "ANALYZING"
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VALIDATING"
  | "TESTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export const TERMINAL_STATUSES: readonly EngineeringStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Statuses in which an execution runner may still be alive. */
export const ACTIVE_STATUSES: readonly EngineeringStatus[] = [
  "QUEUED",
  "ANALYZING",
  "PLANNING",
  "EXECUTING",
  "VALIDATING",
  "TESTING",
];

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Lifecycle timeline entry — persisted in stepsJson. */
export interface LifecycleStep {
  step: string; // inspect | analyze | plan | approve | execute | validate | test | report
  status: "done" | "running" | "failed" | "skipped" | "pending";
  note?: string;
  at?: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Inspection digest
// ---------------------------------------------------------------------------

export interface InspectionEntry {
  path: string;
  kind: "file" | "dir";
  bytes: number;
}

export interface InspectionDigest {
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  treeCapped: boolean;
  tree: InspectionEntry[];
  languages: { language: string; files: number; bytes: number }[];
  frameworks: string[];
  packageManager: string | null;
  packageName: string | null;
  scripts: { name: string; argv: string[] }[];
  entryPoints: string[];
  routeFiles: string[];
  testFiles: string[];
  schemaFiles: string[];
  configFiles: string[];
  gitInitialized: boolean;
  gitClean: boolean;
  gitPending: number;
  /** Files deliberately NOT read (secrets/binary/ignored) — counts only, never secret paths. */
  skippedSecrets: number;
  skippedBinary: number;
  skippedIgnored: number;
}

// ---------------------------------------------------------------------------
// Engineering plan (model output, schema-validated)
// ---------------------------------------------------------------------------

export type PlanFileChange = "create" | "modify" | "delete";

export interface PlanFile {
  path: string;
  change: PlanFileChange;
  reason: string;
}

export interface PlanStep {
  id: string;
  title: string;
  kind: "create_file" | "modify_file" | "delete_file" | "run_command" | "inspect";
  /** Target file path (file steps) or omitted for commands. */
  path?: string;
  /** For run_command steps: the label of the validation command this step runs. */
  command?: string;
  /** What to do — for command steps this is a human summary; the argv comes from validation.commands. */
  detail: string;
  dependsOn: string[];
  risk: "low" | "medium" | "high";
}

export interface PlanCommand {
  label: string;
  /** argv array — validated against the allowlist before approval is accepted. */
  argv: string[];
}

export interface EngineeringPlan {
  objective: string;
  problemDescription: string;
  rootCauseHypothesis?: string;
  files: PlanFile[];
  steps: PlanStep[];
  dependencies: string[];
  risks: { level: "low" | "medium" | "high"; note: string }[];
  validation: {
    strategy: string;
    commands: PlanCommand[];
  };
  expectedOutcome: string;
}

// ---------------------------------------------------------------------------
// Execution records (persisted in resultJson)
// ---------------------------------------------------------------------------

export interface FileEditRecord {
  path: string;
  change: PlanFileChange;
  bytes: number;
  ok: boolean;
  error?: string;
  /** Phase 5: set when the content came from the approved artifact, not the model. */
  note?: string;
}

export interface DiffHunk {
  header: string;
  lines: { type: "add" | "del" | "ctx" | "meta"; text: string }[];
}

export interface FileDiff {
  path: string;
  change: PlanFileChange;
  additions: number;
  deletions: number;
  truncated: boolean;
  hunks: DiffHunk[];
}

export interface CommandRun {
  id: string;
  label: string;
  argv: string[];
  cwd: string; // workspace-relative, always "."
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  status: "passed" | "failed" | "timeout" | "killed" | "error";
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  redactionCount: number;
  at: string;
}

/** Task outcome semantics — "applied" is never reported as "verified". */
export interface TaskReport {
  generated: boolean;
  applied: boolean;
  commandsRun: number;
  commandsPassed: number;
  commandsFailed: number;
  validationStatus: "verified" | "failed" | "not_performed";
  summary: string;
}

export interface TaskResult {
  request: string; // verbatim user request
  plan: EngineeringPlan | null;
  planIssues?: string[];
  /** True when the ONE bounded structured repair ran; on success it fixed the plan, on failure the issues below are final. */
  planRepaired?: boolean;
  /** Issues from the first (rejected) plan attempt when a repair happened — kept so the user can see what was wrong and what the repair had to fix. */
  planRepairIssues?: string[];
  inspection: InspectionDigest | null;
  edits: FileEditRecord[];
  diffs: FileDiff[];
  runs: CommandRun[];
  report: TaskReport | null;
  attempts: number; // execution attempts (bounded)
  revert?: { ok: boolean; restoredFiles: string[]; error?: string };
  /** Phase 5: an approved cross-capability artifact wired into this task — its bytes are substituted deterministically at execution. */
  linkedArtifact?: { artifactId: string; assetTargets: string[] };
}

// ---------------------------------------------------------------------------
// Model-step contract for file edits (execution-time, schema-validated)
// ---------------------------------------------------------------------------

export interface FileEditOutput {
  path: string;
  change: PlanFileChange;
  /** Complete new file content (create/modify). Delete steps omit this. */
  content?: string;
  note?: string;
}

/** Injected model provider — tests run the full pipeline without credentials. */
export interface GiftzStepProvider {
  /** Produce the raw plan text (JSON) from the request + inspection digest. Parsed/validated by jobs.ts. */
  plan(input: {
    request: string;
    digest: InspectionDigest;
    repairIssues?: string[];
    previousPlan?: unknown;
  }): Promise<string> | string;
  /** Produce one file edit at execution time. */
  fileEdit(input: {
    step: PlanStep;
    plan: EngineeringPlan;
    currentContent: string | null;
    digest: InspectionDigest;
  }): Promise<FileEditOutput> | FileEditOutput;
}
