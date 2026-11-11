/**
 * CODE GIFTZ engineering workspace — browser API client (Phase 4).
 * All requests are relative; handlers live under /api/giftz/*.
 */

import { api } from "@/lib/client";

// ------------------------------------------------------------------ types

export interface GiftzRepositoryDTO {
  id: string;
  name: string;
  sizeBytes: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DigestEntryDTO {
  path: string;
  kind: "file" | "dir";
  bytes: number;
}

export interface InspectionDigestDTO {
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  treeCapped: boolean;
  tree: DigestEntryDTO[];
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
  skippedSecrets: number;
  skippedBinary: number;
  skippedIgnored: number;
}

export interface PlanFileDTO {
  path: string;
  change: "create" | "modify" | "delete";
  reason: string;
}

export interface PlanStepDTO {
  id: string;
  title: string;
  kind: "create_file" | "modify_file" | "delete_file" | "run_command" | "inspect";
  path?: string;
  command?: string;
  detail: string;
  dependsOn: string[];
  risk: "low" | "medium" | "high";
}

export interface EngineeringPlanDTO {
  objective: string;
  problemDescription: string;
  rootCauseHypothesis?: string;
  files: PlanFileDTO[];
  steps: PlanStepDTO[];
  dependencies: string[];
  risks: { level: "low" | "medium" | "high"; note: string }[];
  validation: { strategy: string; commands: { label: string; argv: string[] }[] };
  expectedOutcome: string;
}

export interface DiffHunkLineDTO {
  type: "add" | "del" | "ctx" | "meta";
  text: string;
}

export interface FileDiffDTO {
  path: string;
  change: "create" | "modify" | "delete";
  additions: number;
  deletions: number;
  truncated: boolean;
  hunks: { header: string; lines: DiffHunkLineDTO[] }[];
}

export interface CommandRunDTO {
  id: string;
  label: string;
  argv: string[];
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

export interface TaskReportDTO {
  generated: boolean;
  applied: boolean;
  commandsRun: number;
  commandsPassed: number;
  commandsFailed: number;
  validationStatus: "verified" | "failed" | "not_performed";
  summary: string;
}

export interface LifecycleStepDTO {
  step: string;
  status: "done" | "running" | "failed" | "skipped" | "pending";
  note?: string;
  at?: string;
}

export interface TaskResultDTO {
  request: string;
  plan: EngineeringPlanDTO | null;
  planIssues?: string[];
  planRepaired?: boolean;
  planRepairIssues?: string[];
  inspection: InspectionDigestDTO | null;
  edits: { path: string; change: string; bytes: number; ok: boolean; error?: string }[];
  diffs: FileDiffDTO[];
  runs: CommandRunDTO[];
  report: TaskReportDTO | null;
  attempts: number;
  revert?: { ok: boolean; restoredFiles: string[]; error?: string };
}

export interface TaskDetailDTO {
  id: string;
  status: string;
  title: string;
  request: string;
  repoId: string;
  steps: LifecycleStepDTO[];
  result: TaskResultDTO;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  inFlight: boolean;
  cancelRequested: boolean;
}

export interface TaskListItemDTO {
  id: string;
  status: string;
  title: string;
  repoId: string | null;
  repoName: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  validationStatus: TaskReportDTO["validationStatus"] | null;
}

// ------------------------------------------------------------------ api

export const giftzApi = {
  async listRepositories(): Promise<GiftzRepositoryDTO[]> {
    const data = await api<{ repositories: GiftzRepositoryDTO[] }>("/api/giftz/repositories");
    return data.repositories;
  },

  async createRepository(name?: string): Promise<GiftzRepositoryDTO> {
    const data = await api<{ repository: GiftzRepositoryDTO }>("/api/giftz/repositories", {
      method: "POST",
      json: name ? { name } : {},
    });
    return data.repository;
  },

  async getRepository(id: string): Promise<{ repository: GiftzRepositoryDTO; digest: InspectionDigestDTO; tree: DigestEntryDTO[] }> {
    return api(`/api/giftz/repositories/${id}`);
  },

  async deleteRepository(id: string): Promise<void> {
    await api(`/api/giftz/repositories/${id}`, { method: "DELETE" });
  },

  async listTasks(): Promise<{ tasks: TaskListItemDTO[]; swept: number }> {
    return api("/api/giftz/tasks");
  },

  async createTask(repoId: string, request: string): Promise<{ taskId: string; status: string; duplicate?: boolean }> {
    return api("/api/giftz/tasks", { method: "POST", json: { repoId, request } });
  },

  async getTask(id: string): Promise<TaskDetailDTO> {
    return api(`/api/giftz/tasks/${id}`);
  },

  async approveTask(id: string): Promise<void> {
    await api(`/api/giftz/tasks/${id}/approve`, { method: "POST", json: {} });
  },

  async rejectTask(id: string, reason?: string): Promise<void> {
    await api(`/api/giftz/tasks/${id}/reject`, { method: "POST", json: reason ? { reason } : {} });
  },

  async cancelTask(id: string): Promise<void> {
    await api(`/api/giftz/tasks/${id}/cancel`, { method: "POST", json: {} });
  },

  async retryTask(id: string): Promise<void> {
    await api(`/api/giftz/tasks/${id}/retry`, { method: "POST", json: {} });
  },

  async revertTask(id: string): Promise<{ restoredFiles: string[] }> {
    return api(`/api/giftz/tasks/${id}/revert`, { method: "POST", json: {} });
  },
};

// ------------------------------------------------------------------ Phase 5: cross-capability handoffs

export interface CreativeResultDTO {
  width: number;
  height: number;
  mime: string;
  sizeBytes: number;
  provider: string;
  model: string;
  attempts: number;
  qualitySummary: string;
}

export interface CreativeTaskDTO {
  id: string;
  status: string;
  request: string;
  repoId: string | null;
  proposal: { headline: string; visualDirection: string; audience?: string; avoid: string[]; rationale: string } | null;
  brief: {
    canvas: { width: number; height: number; presetSlug: string };
    direction: string;
    targetAudience: string;
    palette: string[];
    typography: { items: { text: string; role: string }[] };
    avoid: string[];
  } | null;
  assetSpec: { kind: string; width: number; height: number };
  artifactId: string | null;
  mediaId: string | null;
  result: CreativeResultDTO | null;
  integrationTaskId: string | null;
  digestSummary: { fileCount: number; packageName: string | null } | null;
  steps: { step: string; status: string; note?: string; at?: string }[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffDetailDTO {
  id: string;
  status: string;
  ownStatus: string;
  direction: string;
  source: { taskId: string | null; label: string };
  request: string;
  repoId: string | null;
  repoName: string | null;
  mediaId: string;
  mediaMeta: { mime: string; width: number | null; height: number | null; sizeBytes: number } | null;
  artifactId: string | null;
  downstreamTaskId: string | null;
  downstreamStatus: string | null;
  downstreamValidation: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const creativeApi = {
  async list(): Promise<{ tasks: CreativeTaskDTO[] }> {
    return api("/api/giftz/creative");
  },

  async create(repoId: string, request: string): Promise<{ taskId: string; status: string; duplicate?: boolean }> {
    return api("/api/giftz/creative", { method: "POST", json: { repoId, request } });
  },

  async get(id: string): Promise<CreativeTaskDTO> {
    return api(`/api/giftz/creative/${id}`);
  },

  async approve(id: string): Promise<void> {
    await api(`/api/giftz/creative/${id}/approve`, { method: "POST", json: {} });
  },

  async reject(id: string, reason?: string): Promise<void> {
    await api(`/api/giftz/creative/${id}/reject`, { method: "POST", json: reason ? { reason } : {} });
  },

  async integrate(id: string, request: string): Promise<{ integrationTaskId: string }> {
    return api(`/api/giftz/creative/${id}/integrate`, { method: "POST", json: { request } });
  },
};

export const intelligenceApi = {
  async listHandoffs(): Promise<{ handoffs: HandoffDetailDTO[] }> {
    return api("/api/intelligence/handoffs");
  },

  async createHandoff(input: { mediaId: string; repoId: string; request: string; sourceTaskId?: string | null; sourceLabel?: string }): Promise<{ handoffId: string; status: string; duplicate?: boolean }> {
    return api("/api/intelligence/handoffs", { method: "POST", json: input });
  },

  async getHandoff(id: string): Promise<HandoffDetailDTO> {
    return api(`/api/intelligence/handoffs/${id}`);
  },

  async approveHandoff(id: string): Promise<{ downstreamTaskId: string }> {
    return api(`/api/intelligence/handoffs/${id}/approve`, { method: "POST", json: {} });
  },

  async rejectHandoff(id: string, reason?: string): Promise<void> {
    await api(`/api/intelligence/handoffs/${id}/reject`, { method: "POST", json: reason ? { reason } : {} });
  },

  async cancelHandoff(id: string): Promise<void> {
    await api(`/api/intelligence/handoffs/${id}/cancel`, { method: "POST", json: {} });
  },
};
