/**
 * CODE GIFTZ engineering workspace — browser API client (Phase 4).
 * All requests are relative; handlers live under /api/giftz/*.
 */

import { api } from "@/lib/client";
import type { SiteConfig } from "@/lib/site-config";

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

// ------------------------------------------------------------------ GIFTZ site project (website platform) ---
// Client for the file-level GIFTZ website platform (contract §4): project file
// tree, builds, versions, deployments, domains and activity. All shapes mirror
// the API routes 1:1 — never invented fields on the wire.

export interface GiftzProjectFileDTO {
  path: string;
  /** generated | user | ai */
  source: string;
  sizeBytes: number;
  encoding: "utf8" | "base64";
  updatedAt: string;
  mime: string;
}

export interface GiftzFileTreeSummaryDTO {
  fileCount: number;
  totalBytes: number;
  lastUpdatedAt: string | null;
}

export interface GiftzFileContentDTO {
  path: string;
  /** Absent for base64 rows unless explicitly requested raw. */
  content?: string;
  encoding: "utf8" | "base64";
  source: string;
  mime: string;
  updatedAt: string;
}

export interface GiftzBuildDiagnosticDTO {
  path: string;
  severity: "error" | "warning";
  message: string;
}

export interface GiftzBuildDTO {
  id: string;
  status: "QUEUED" | "BUILDING" | "SUCCEEDED" | "FAILED" | string;
  trigger: string;
  summary: string | null;
  checksRun: number | null;
  durationMs: number | null;
  /** Full detail only — GET builds/[buildId]; the list omits diagnostics. */
  diagnostics?: GiftzBuildDiagnosticDTO[];
  createdAt: string;
  finishedAt: string | null;
}

export interface GiftzDeploymentDTO {
  id: string;
  buildId: string | null;
  status: "PREPARING" | "DEPLOYING" | "LIVE" | "FAILED" | "ROLLED_BACK" | string;
  provider: string;
  url: string | null;
  error: string | null;
  deployedAt: string | null;
  createdAt: string;
}

export interface GiftzDomainDTO {
  id: string;
  hostname: string;
  status: "PENDING" | "VERIFIED" | "FAILED" | string;
  verificationToken: string;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface GiftzActivityDTO {
  id: string;
  kind: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface GiftzVersionDTO {
  id: string;
  label: string;
  source: string;
  createdAt: string;
  fileCount: number;
}

export interface GiftzVersionDetailDTO {
  id: string;
  label: string;
  source: string;
  createdAt: string;
  files: { path: string; sizeBytes: number }[];
}

export interface GiftzVersionChangedFileDTO {
  path: string;
  action: "added" | "removed" | "modified" | string;
  patch: string | null;
}

export interface GiftzApplyFilesResultDTO {
  applied: number;
  files: { path: string; action: string }[];
  config?: SiteConfig | null;
}

/** File-tree listing (NO content — tree only, per contract §4). */
export async function listSiteFiles(siteId: string): Promise<{ files: GiftzProjectFileDTO[]; summary: GiftzFileTreeSummaryDTO | null }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/files`);
}

/** Read one file's content. `binary: true` means the row is base64 — no content is returned unless raw is requested. */
export async function readSiteFile(siteId: string, path: string): Promise<{ file: GiftzFileContentDTO; binary: boolean }> {
  return api(
    `/api/giftz/sites/${encodeURIComponent(siteId)}/files/content?path=${encodeURIComponent(path)}`
  );
}

/** Write one UTF-8 text file (source becomes "user"). Writing site.config.json syncs the site config server-side. */
export async function writeSiteFile(siteId: string, path: string, content: string, encoding?: "utf8"): Promise<{ file: GiftzFileContentDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/files/content`, {
    method: "PUT",
    json: { path, content, ...(encoding ? { encoding } : {}) },
  });
}

/** Delete one file. The server refuses site.config.json with an honest 400. */
export async function deleteSiteFile(siteId: string, path: string): Promise<void> {
  await api(`/api/giftz/sites/${encodeURIComponent(siteId)}/files/content?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
}

/** Rename (move) one file; source preserved; refuses when the destination exists. */
export async function renameSiteFile(siteId: string, from: string, to: string): Promise<{ file: GiftzFileContentDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/files/rename`, {
    method: "POST",
    json: { from, to },
  });
}

/** Apply a kind-"files" chat proposal (source "ai") to the working tree. */
export async function applyFileProposal(siteId: string, messageId: string): Promise<GiftzApplyFilesResultDTO> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/files/apply-proposal`, {
    method: "POST",
    json: { messageId },
  });
}

/** Run one synchronous production/validation build. */
export async function runSiteBuild(siteId: string): Promise<{ build: GiftzBuildDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/builds`, { method: "POST", json: {} });
}

/** Newest 20 builds (list omits diagnostics). */
export async function listSiteBuilds(siteId: string): Promise<{ builds: GiftzBuildDTO[] }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/builds`);
}

/** One build with full diagnostics. */
export async function getSiteBuild(siteId: string, buildId: string): Promise<{ build: GiftzBuildDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/builds/${encodeURIComponent(buildId)}`);
}

export async function listSiteVersions(siteId: string): Promise<{ versions: GiftzVersionDTO[] }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/versions`);
}

/** Manual snapshot (source "user"). */
export async function createSiteVersion(siteId: string, label?: string): Promise<{ version: GiftzVersionDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/versions`, {
    method: "POST",
    json: label ? { label } : {},
  });
}

export async function getSiteVersion(siteId: string, versionId: string): Promise<{ version: GiftzVersionDetailDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}`);
}

/** Unified diff of one version against the current working tree. */
export async function getVersionDiff(siteId: string, versionId: string): Promise<{ changed: GiftzVersionChangedFileDTO[] }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/diff`);
}

/** Restore a version — replaces the working tree (a restore snapshot is kept server-side). */
export async function restoreSiteVersion(siteId: string, versionId: string): Promise<{ restored: true; fileCount: number; config: SiteConfig | null }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/versions/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
    json: {},
  });
}

export async function listSiteDeployments(siteId: string): Promise<{ deployments: GiftzDeploymentDTO[]; adapter?: { configured: boolean; provider: string; note: string } }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/deployments`);
}

/** Roll back to a previous deployment (creates a new LIVE deployment from its artifact). */
export async function rollbackSiteDeployment(siteId: string, deploymentId: string): Promise<{ deployment: GiftzDeploymentDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
    method: "POST",
    json: {},
  });
}

export async function listSiteDomains(siteId: string): Promise<{ domains: GiftzDomainDTO[] }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/domains`);
}

export async function addSiteDomain(siteId: string, hostname: string): Promise<{ domain: GiftzDomainDTO }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/domains`, { method: "POST", json: { hostname } });
}

export async function deleteSiteDomain(siteId: string, domainId: string): Promise<void> {
  await api(`/api/giftz/sites/${encodeURIComponent(siteId)}/domains/${encodeURIComponent(domainId)}`, { method: "DELETE" });
}

export async function verifySiteDomain(siteId: string, domainId: string): Promise<{ domain: GiftzDomainDTO; routingNote?: string }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/domains/${encodeURIComponent(domainId)}/verify`, {
    method: "POST",
    json: {},
  });
}

export async function listSiteActivity(siteId: string): Promise<{ activity: GiftzActivityDTO[] }> {
  return api(`/api/giftz/sites/${encodeURIComponent(siteId)}/activity`);
}
