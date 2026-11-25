"use client";

/**
 * Typed client for the LAXII studio APIs. Thin wrappers over the shared
 * `api()` helper — all relative paths, cookie auth included automatically.
 */

import { api } from "@/lib/client";

export interface LaxiiProviderCapability {
  supported: boolean;
  maxReferences?: number;
  maxVariantsPerCall?: number;
  transparent?: boolean;
  sizes?: string[];
  note?: string;
}

export interface LaxiiProviderInfo {
  id: "managed" | "gemini" | "openai" | "diffusers";
  label: string;
  available: boolean;
  model: string;
  capabilities: {
    generate: LaxiiProviderCapability;
    edit: LaxiiProviderCapability;
    variations: LaxiiProviderCapability;
    upscale: LaxiiProviderCapability;
    removeBackground: LaxiiProviderCapability;
    expand: LaxiiProviderCapability;
  };
  aspects: string[];
}

export interface LaxiiBannerPreset {
  slug: string;
  label: string;
  description: string;
  width: number;
  height: number;
  safeArea: { x: number; y: number; width: number; height: number };
  compositionHint: string;
}

export interface LaxiiAvatarPreset {
  slug: string;
  label: string;
  blurb: string;
  defaultAspect: string;
}

export interface LaxiiResumeType {
  slug: string;
  label: string;
  blurb: string;
}

export interface LaxiiResumeProfession {
  slug: string;
  label: string;
  blurb: string;
}

export interface LaxiiStylePreset {
  slug: string;
  label: string;
  blurb: string;
  settings: {
    composition: string;
    lighting: string;
    camera: string;
    colorGrading: string;
    treatment: string;
    background: string;
  };
  defaultAspect: string;
  referenceBehavior: "subject" | "style" | "compose" | "optional";
  variationStrategy: "composition" | "lighting" | "mood" | "angle";
  providerPreference: ("managed" | "gemini" | "openai" | "diffusers")[];
}

export interface LaxiiEngineInfo {
  id: "laxii-v1";
  label: "LAXII V1";
  provider: "managed";
  model: string;
  available: boolean;
  note: string;
}

export interface LaxiiCapabilities {
  defaultProvider: "managed" | "gemini" | "openai" | "diffusers";
  providers: LaxiiProviderInfo[];
  /** The single user-facing image engine (LAXII V1). */
  engine?: LaxiiEngineInfo;
  limits: { burstPerMinute: number; dailyImages: number };
  conversational?: {
    enabled: boolean;
    defaultOperation: "AUTO";
    intents: string[];
  };
  styles?: LaxiiStylePreset[];
  bannerPresets: LaxiiBannerPreset[];
  avatarPresets: LaxiiAvatarPreset[];
  resumeTypes: LaxiiResumeType[];
  resumeProfessions?: LaxiiResumeProfession[];
}

export interface LaxiiVersion {
  id: string;
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  isSelected: boolean;
  isFavourite: boolean;
  parentVersionId: string | null;
  operation: string | null;
  prompt: string | null;
  createdAt: string;
}

export interface LaxiiMessage {
  id: string;
  role: string;
  text: string;
  operation: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  error: string | null;
  meta: {
    aspect?: string;
    refs?: string[];
    warnings?: string[];
    estimatedCostUsd?: number;
    durationMs?: number;
    intent?: { kind: string; source: string };
    style?: string;
    banner?: { bannerKind: string; width: number; height: number };
    // Phase 3: brief pipeline fields (all optional, honest presence).
    briefTaskId?: string;
    stage?: string;
    stageLabel?: string;
    stageDetail?: string;
    stageAttempt?: number;
    stageMaxAttempts?: number;
    qualityReport?: LaxiiQualityReport;
    pipelineAttempts?: LaxiiPipelineAttempt[];
    pipelineDecisions?: { scrimAdded?: boolean; typographyRendered?: boolean; revisionAddendaApplied?: number };
  } | null;
  createdAt: string;
  versions: LaxiiVersion[];
}

export interface LaxiiQualityFinding {
  id: string;
  area: "technical" | "visual" | "typography" | "compliance";
  status: "pass" | "warn" | "fail";
  check: string;
  measured?: string;
  note?: string;
}

export interface LaxiiQualityReport {
  overall: "pass" | "warn" | "fail";
  findings: LaxiiQualityFinding[];
  evaluator: "deterministic" | "deterministic+ai-review";
  aiReview?: { ran: boolean; findings: { area: string; severity: string; note: string }[]; note: string };
  evaluatedAt: string;
}

export interface LaxiiPipelineAttempt {
  index: number;
  engine: { provider: string; model: string; durationMs: number; estimatedCostUsd: number };
  rank: number;
  overall: "pass" | "warn" | "fail";
  failedChecks: string[];
  refinements: string[];
}

// ------------------------------------------------------------------ briefs

export interface LaxiiDesignBrief {
  schemaVersion: number;
  request: string;
  profession: string | null;
  targetAudience: string | null;
  portfolio: { permission: string; used: boolean; summary: string[] };
  visualIdentity: { toneWords: string[]; notes: string[] };
  direction: string;
  subject: { description: string; focalPoint: string };
  background: string;
  composition: { hierarchy: string; textPlacement: "left" | "center" | "right"; notes: string[] };
  palette: string[];
  typography: {
    items: { text: string; role: string; font: string; align?: string; color?: string }[];
    notes: string[];
  };
  canvas: { presetSlug: string; width: number; height: number };
  safeArea: { x: number; y: number; width: number; height: number };
  referenceMediaIds: string[];
  preserve: string[];
  avoid: string[];
  export: { format: string; exactDimensions: boolean };
  revisions: { area: string; instruction: string; at: string }[];
  source: string;
  sourceTaskId: string;
  createdAt: string;
}

export interface LaxiiBriefResponse {
  task: {
    id: string;
    status: string;
    kind: string;
    title: string;
    destinationUrl: string;
    destinationLabel: string;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  brief: LaxiiDesignBrief;
  humanBrief: string;
  generation: { conversationId?: string; messageId?: string; mediaId?: string; approved?: boolean; rejected?: boolean };
}

export type LaxiiBriefActionPayload =
  | { action: "revise"; taskId: string; area: string; instruction: string }
  | { action: "cancel"; taskId: string; reason?: string }
  | { action: "approve-result"; taskId: string; messageId: string }
  | { action: "reject-result"; taskId: string; messageId: string; reason?: string };

export interface LaxiiConversationSummary {
  id: string;
  title: string;
  kind: "IMAGE" | "BANNER" | "RESUME" | "AVATAR";
  bannerKind: string | null;
  canvasWidth: number | null;
  canvasHeight: number | null;
  messageCount?: number;
  updatedAt: string;
}

export interface LaxiiConversationDetail {
  conversation: {
    id: string;
    title: string;
    kind: "IMAGE" | "BANNER" | "RESUME" | "AVATAR";
    bannerKind: string | null;
    canvasWidth: number | null;
    canvasHeight: number | null;
    createdAt: string;
    updatedAt: string;
  };
  messages: LaxiiMessage[];
}

export interface LaxiiGalleryImage {
  id: string;
  mediaId: string;
  url: string;
  width: number | null;
  height: number | null;
  isFavourite: boolean;
  operation: string | null;
  prompt: string | null;
  conversationId: string;
  conversationTitle: string;
  conversationKind: "IMAGE" | "BANNER" | "AVATAR";
  bannerKind: string | null;
  canvasWidth: number | null;
  canvasHeight: number | null;
  createdAt: string;
}

// ------------------------------------------------------------------ resume

/** M33.5-A: one proposed field from the structured import (deterministic). */
export interface ImportProposalField {
  value: unknown;
  confidence: "high" | "review" | "low";
  snippet: string;
  warnings: string[];
}

export interface ImportProposalString extends ImportProposalField {
  value: string;
}

export interface ResumeImportProposal {
  schemaVersion: 1;
  source: {
    method: "pdf-text" | "docx-text" | "plain-text" | "user-entered";
    charCount: number;
    truncated: boolean;
    fileName: string;
  };
  basics: {
    name: ImportProposalString | null;
    label: ImportProposalString | null;
    email: ImportProposalString | null;
    phone: ImportProposalString | null;
    website: ImportProposalString | null;
    location: ImportProposalString | null;
    summary: ImportProposalString | null;
  };
  work: (ImportProposalField & { value: ResumeWorkItem })[];
  education: (ImportProposalField & { value: ResumeEducationItem })[];
  skills: (ImportProposalField & { value: string })[];
  projects: (ImportProposalField & { value: ResumeProjectItem })[];
  certificates: (ImportProposalField & { value: ResumeCertificateItem })[];
  awards: (ImportProposalField & { value: ResumeAwardItem })[];
  warnings: string[];
}

/** M33.5-B: versioned Document Readability Report (deterministic). */
export interface ReadabilityCheck {
  id: string;
  category: string;
  status: "pass" | "warning" | "fail" | "not-run";
  severity: "info" | "minor" | "major" | "critical";
  detail: string;
  remediation: string;
}

export interface ReadabilityReport {
  reportVersion: number;
  evaluator: string;
  evaluatedAt: string;
  status: "good" | "review" | "problem" | "not-run";
  checks: ReadabilityCheck[];
  untested: string[];
  fileFacts: {
    documentKind: string;
    template: string;
    sectionCount: number;
    workEntries: number;
    educationEntries: number;
    skills: number;
    extractedChars: number;
    longestParagraphChars: number;
  };
}

export interface JobRequirement {
  kind: string;
  importance: "required" | "preferred";
  text: string;
  sourcePhrase: string;
}

export interface JobEvidenceMap {
  mapVersion: number;
  profile: {
    profileVersion: number;
    roleTitle: string;
    organization: string;
    requirements: JobRequirement[];
    parseWarnings: string[];
  };
  evidence: {
    requirement: JobRequirement;
    verdict: "supported" | "partial" | "missing" | "not_assessable";
    citations: { section: string; fact: string }[];
    followUp: string;
  }[];
  weightedCoverage: {
    formula: string;
    value: number;
    assessedRequirements: number;
    excludedNotAssessable: number;
  };
  matchWarnings: string[];
}

export interface ExportVerification {
  format: "pdf" | "docx";
  byteLength: number;
  decodeOk: boolean;
  extractedChars: number;
  missingFacts: string[];
  checkedFacts: number;
  readingOrderOk: boolean;
}

export interface ResumeWorkItem {
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  current: boolean;
  summary: string;
  highlights: string[];
}

export interface ResumeEducationItem {
  institution: string;
  area: string;
  studyType: string;
  startDate: string;
  endDate: string;
  score: string;
}

export interface ResumeProjectItem {
  name: string;
  description: string;
  highlights: string[];
  url: string;
}

export interface ResumeCertificateItem {
  name: string;
  issuer: string;
  date: string;
}

export interface ResumeAwardItem {
  title: string;
  awarder: string;
  date: string;
  summary: string;
}

export interface ResumeCustomEntry {
  title: string;
  subtitle: string;
  meta: string;
  summary: string;
  highlights: string[];
  url: string;
}

export interface ResumeCustomSection {
  key: string;
  title: string;
  entries: ResumeCustomEntry[];
}

export interface ResumeData {
  basics: {
    name: string;
    label: string;
    email: string;
    phone: string;
    website: string;
    location: string;
    summary: string;
  };
  work: ResumeWorkItem[];
  education: ResumeEducationItem[];
  skills: { name: string; level: string }[];
  projects: { name: string; description: string; highlights: string[]; url: string }[];
  certificates: { name: string; issuer: string; date: string }[];
  awards: { title: string; awarder: string; date: string; summary: string }[];
  /** Profession-specific sections (publications, licences…) — user-owned. */
  custom: ResumeCustomSection[];
  /** Section render order (core keys + "custom:*"). Empty = legacy order. */
  order: string[];
  /** Section heading overrides (rename). */
  titles: Record<string, string>;
}

export type ResumeSectionKey = "basics" | "summary" | "work" | "education" | "skills" | "projects" | "certificates" | "awards";

export interface ResumeFacts {
  basics: { name: string; label: string; email: string; phone: string; website: string; location: string; summary: string };
  work: ResumeWorkItem[];
  education: ResumeEducationItem[];
  skills: ({ name: string; level: string } | string)[];
  projects: { name: string; description: string; highlights: string[]; url: string }[];
  certificates: { name: string; issuer: string; date: string }[];
  awards: { title: string; awarder: string; date: string; summary: string }[];
  custom: ResumeCustomSection[];
}

// ------------------------------------------------------------------ cover letter (M33.5-D)

export interface CoverLetterData {
  schemaVersion: 1;
  basics: { name: string; email: string; phone: string; location: string; website: string };
  label: string;
  targetRole: string;
  companyName: string;
  hiringContactName: string;
  date: string;
  salutation: string;
  opening: string;
  bodyParagraphs: string[];
  closing: string;
  signatureName: string;
  tone: "formal" | "confident" | "warm" | "direct" | "creative" | "academic";
  aiTouched: string[];
  sourceResumeConversationId: string;
  jobDescriptionHash: string;
  wordCount: number;
}

export interface CoverLetterLibraryItem {
  letterId: string;
  label: string;
  targetRole: string;
  companyName: string;
  updatedAt: string;
  hasSourceResume: boolean;
}

export interface CoverLetterDetail {
  letterId: string;
  letter: CoverLetterData;
  updatedAt: string;
  jobDescriptionHash: string;
}

export interface CoverLetterActionResult {
  letterId: string;
  letter: CoverLetterData;
  notes: string[];
}

/** M33.5-C: one bounded revision snapshot (no document body in list responses). */
export interface ResumeRevisionSummary {
  id: string;
  label: string;
  provenance: "user" | "ai";
  operation: string;
  targetTitle: string | null;
  resumeType: string;
  template: string;
  contentHash: string;
  pinned: boolean;
  parentRevisionId: string | null;
  createdAt: string;
}

export interface ResumeDetail {
  conversation: { id: string; title: string; kind: "RESUME"; updatedAt: string };
  resumeType: string;
  variantKind?: "master" | "tailored";
  parentConversationId?: string | null;
  jobDescriptionHash?: string | null;
  template: "classic" | "modern" | "minimal" | "creative";
  targetTitle: string | null;
  jobDescription: string | null;
  profession: string | null;
  aiTouched: ResumeSectionKey[];
  missing: string[];
  data: ResumeData;
}

export interface ResumeSummary {
  conversationId: string;
  title: string;
  resumeType: string;
  variantKind?: "master" | "tailored";
  template: string;
  targetTitle: string | null;
  profession: string | null;
  updatedAt: string;
}

export interface ResumeActionResult {
  conversationId: string;
  resume: ResumeData;
  aiTouched: ResumeSectionKey[];
  notes: string[];
  template: string;
  missing: string[];
  profession: string | null;
}

/**
 * Client mirror of the server prompt budget (src/lib/laxii/service.ts
 * MAX_PROMPT_LENGTH). 16,000 characters — long art-direction briefs fit;
 * the composer shows a live counter and blocks submission beyond the limit.
 */
export const LAXII_PROMPT_MAX = 16000;

export interface GeneratePayload {
  conversationId?: string;
  prompt: string;
  /** "AUTO" lets the server classify the conversational intent (Phase 3). */
  operation:
    | "AUTO"
    | "GENERATE"
    | "EDIT"
    | "VARIATIONS"
    | "UPSCALE"
    | "REMOVE_BACKGROUND"
    | "EXPAND"
    | "BANNER";
  /** Optional in AUTO mode — the server derives it (style default / source ratio). */
  aspect?: string;
  count?: number;
  provider?: "managed" | "gemini" | "openai" | "diffusers";
  quality?: "1K" | "2K" | "4K";
  referenceMediaIds?: string[];
  parentVersionId?: string;
  banner?: { presetSlug: string; customWidth?: number; customHeight?: number };
  avatar?: { presetSlug: string };
  style?: { slug: string };
  /** Phase 3: Riishe→LAXII structured brief handoff (banner pipeline). */
  briefTaskId?: string;
}

export interface GenerateResponse {
  conversationId: string;
  /** The ASSISTANT message carrying the job — poll the conversation for its status. */
  messageId: string;
  status: "RUNNING";
  /** True when the request re-attached to an already-running job (idempotent retry). */
  duplicate?: boolean;
  /** Classified intent (AUTO requests) — surfaced in the UI for transparency. */
  intent?: { kind: string; source: string };
}

export const laxiiApi = {
  capabilities: () => api<LaxiiCapabilities>("/api/laxii/capabilities"),

  conversations: () =>
    api<{ conversations: LaxiiConversationSummary[] }>("/api/laxii/conversations"),

  createConversation: (body: {
    title?: string;
    kind: "IMAGE" | "BANNER";
    bannerKind?: string;
    canvasWidth?: number;
    canvasHeight?: number;
  }) => api<{ conversation: { id: string } }>("/api/laxii/conversations", { method: "POST", json: body }),

  conversation: (id: string) => api<LaxiiConversationDetail>(`/api/laxii/conversations/${id}`),

  renameConversation: (id: string, title: string) =>
    api<{ ok: boolean }>(`/api/laxii/conversations/${id}`, { method: "PATCH", json: { title } }),

  deleteConversation: (id: string) =>
    api<{ ok: boolean }>(`/api/laxii/conversations/${id}`, { method: "DELETE" }),

  generate: (payload: GeneratePayload, signal?: AbortSignal) =>
    api<GenerateResponse>("/api/laxii/generate", { method: "POST", json: payload, signal }),

  // ---------------------------------------------------------- brief API (P3)

  brief: (taskId: string) =>
    api<LaxiiBriefResponse>(`/api/laxii/brief?taskId=${encodeURIComponent(taskId)}`),

  briefAction: (payload: LaxiiBriefActionPayload) =>
    api<LaxiiBriefResponse | { ok: boolean; status?: string }>("/api/laxii/brief", {
      method: "POST",
      json: payload,
    }),

  select: (versionId: string) =>
    api<{ ok: boolean; selectedVersionId: string }>(`/api/laxii/versions/${versionId}/select`, { method: "POST" }),

  favourite: (versionId: string) =>
    api<{ ok: boolean; isFavourite: boolean }>(`/api/laxii/versions/${versionId}/favourite`, { method: "POST" }),

  images: (filter: "all" | "favourites" | "banners" | "avatars") =>
    api<{ images: LaxiiGalleryImage[] }>(`/api/laxii/images?filter=${filter}`),

  exportImage: (versionId: string, format: "png" | "jpeg" | "webp") =>
    api<{
      export: {
        mediaId: string;
        url: string;
        width: number;
        height: number;
        mime: string;
        bytes: number;
        transparent: boolean;
      };
    }>("/api/laxii/images/export", { method: "POST", json: { versionId, format } }),

  // ------------------------------------------------------------ resume API

  resumeList: () => api<{ resumes: ResumeSummary[] }>("/api/laxii/resume"),

  resumeDetail: (conversationId: string) =>
    api<ResumeDetail>(`/api/laxii/resume?conversationId=${encodeURIComponent(conversationId)}`),

  resumeGenerate: (body: {
    conversationId?: string;
    facts: ResumeFacts;
    resumeType: string;
    targetTitle: string;
    jobDescription: string;
    profession?: string;
    sourceText?: string;
  }) => api<ResumeActionResult>("/api/laxii/resume", { method: "POST", json: { action: "generate", ...body } }),

  /** Upload an existing resume (PDF/DOCX/TXT) and extract its text. */
  resumeParse: async (file: File): Promise<{ text: string; truncated: boolean; source: string }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/laxii/resume/parse", { method: "POST", body: form, credentials: "include" });
    const json = (await res.json().catch(() => null)) as { text?: string; truncated?: boolean; source?: string; error?: string } | null;
    if (!res.ok || typeof json?.text !== "string") {
      throw new Error(json?.error ?? "Could not read the resume file.");
    }
    return { text: json.text, truncated: Boolean(json.truncated), source: json.source ?? "" };
  },

  /** M33.5-A: structured import — upload a file and get text + a deterministic
   *  review proposal. Nothing is persisted server-side. */
  resumeImport: async (file: File): Promise<{ text: string; truncated: boolean; source: string; proposal: ResumeImportProposal }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/laxii/resume/import", { method: "POST", body: form, credentials: "include" });
    const json = (await res.json().catch(() => null)) as
      | { text?: string; truncated?: boolean; source?: string; proposal?: ResumeImportProposal; error?: string }
      | null;
    if (!res.ok || typeof json?.text !== "string" || !json?.proposal) {
      throw new Error(json?.error ?? "Could not read the resume file.");
    }
    return { text: json.text, truncated: Boolean(json.truncated), source: json.source ?? "", proposal: json.proposal };
  },

  /** M33.5-B: deterministic readability report (+ optional job evidence map). */
  resumeAnalyze: (conversationId: string, jobDescription?: string) =>
    api<{ readability: ReadabilityReport; evidenceMap?: JobEvidenceMap; profile?: JobEvidenceMap["profile"] }>("/api/laxii/resume/analyze", {
      method: "POST",
      json: { conversationId, ...(jobDescription ? { jobDescription } : {}) },
    }),

  /** M33.5-B: render + decode round-trip verification of the saved resume. */
  resumeExportVerify: (conversationId: string, format: "pdf" | "docx") =>
    api<{ verification: ExportVerification }>("/api/laxii/resume/export/verify", {
      method: "POST",
      json: { conversationId, format },
    }),

  // ------------------------------------------------------- cover letter API
  coverLetterList: () => api<{ letters: CoverLetterLibraryItem[] }>("/api/laxii/cover-letter"),
  coverLetterDetail: (letterId: string) =>
    api<CoverLetterDetail>(`/api/laxii/cover-letter?letterId=${encodeURIComponent(letterId)}`),
  coverLetterGenerate: (body: {
    sourceResumeConversationId: string;
    targetRole: string;
    companyName: string;
    hiringContactName: string;
    salutation: string;
    date: string;
    tone: CoverLetterData["tone"];
    length: "concise" | "standard" | "detailed";
    jobDescription: string;
  }) => api<CoverLetterActionResult>("/api/laxii/cover-letter", { method: "POST", json: { action: "generate", ...body } }),
  coverLetterRephrase: (letterId: string, target: string) =>
    api<CoverLetterActionResult>("/api/laxii/cover-letter", { method: "POST", json: { action: "rephrase", letterId, target } }),
  coverLetterDuplicate: (letterId: string) =>
    api<CoverLetterActionResult>("/api/laxii/cover-letter", { method: "POST", json: { action: "duplicate", letterId } }),
  coverLetterSave: (letterId: string, data: CoverLetterData) =>
    api<{ ok: boolean }>("/api/laxii/cover-letter", { method: "PATCH", json: { letterId, data } }),
  /** Binary download — returns the response for blob handling. */
  coverLetterExport: async (letterId: string, format: "pdf" | "docx"): Promise<Response> =>
    fetch("/api/laxii/cover-letter/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ letterId, format }),
    }),

  /** M33.5-C: create a job-specific tailored COPY (master stays untouched). */
  resumeTailorCopy: (body: {
    conversationId: string;
    jobDescription: string;
    targetTitle?: string;
    saveFullJobDescription?: boolean;
  }) =>
    api<{
      conversationId: string;
      masterConversationId: string;
      resume: ResumeData;
      aiTouched: ResumeSectionKey[];
      notes: string[];
      diff: {
        changedSections: string[];
        removedWork: string[];
        rewordedWork: string[];
        removedEducation: string[];
        removedSkills: string[];
        addedSkills: string[];
        skillsReordered: boolean;
        summary: string[];
      };
      jobDescriptionHash: string;
    }>("/api/laxii/resume", { method: "POST", json: { action: "tailor_copy", ...body } }),

  /** M33.5-C: revision history (bounded; restore never erases the current state). */
  resumeRevisions: (conversationId: string) =>
    api<{ revisions: ResumeRevisionSummary[] }>(`/api/laxii/resume/revisions?conversationId=${encodeURIComponent(conversationId)}`),

  resumeRevisionDetail: (conversationId: string, revisionId: string) =>
    api<{ id: string; data: ResumeData } & Record<string, unknown>>(`/api/laxii/resume/revisions?conversationId=${encodeURIComponent(conversationId)}&revisionId=${encodeURIComponent(revisionId)}`),

  resumeRevisionSave: (conversationId: string, label?: string) =>
    api<{ revision: ResumeRevisionSummary }>("/api/laxii/resume/revisions", {
      method: "POST",
      json: { action: "save", conversationId, ...(label ? { label } : {}) },
    }),

  resumeRevisionPin: (conversationId: string, revisionId: string, pinned: boolean) =>
    api<{ ok: boolean }>("/api/laxii/resume/revisions", {
      method: "POST",
      json: { action: "pin", conversationId, revisionId, pinned },
    }),

  resumeRevisionRestore: (conversationId: string, revisionId: string) =>
    api<{ resume: ResumeData }>("/api/laxii/resume/revisions", {
      method: "POST",
      json: { action: "restore", conversationId, revisionId },
    }),

  resumeTailor: (conversationId: string, jobDescription: string, targetTitle?: string) =>
    api<ResumeActionResult>("/api/laxii/resume", {
      method: "POST",
      json: { action: "tailor", conversationId, jobDescription, targetTitle },
    }),

  resumeRephrase: (conversationId: string, section: ResumeSectionKey) =>
    api<ResumeActionResult>("/api/laxii/resume", {
      method: "POST",
      json: { action: "rephrase", conversationId, section },
    }),

  resumeSave: (body: {
    conversationId: string;
    data: ResumeData;
    template?: "classic" | "modern" | "minimal" | "creative";
    resumeType?: string;
  }) => api<{ ok: boolean }>("/api/laxii/resume", { method: "PATCH", json: body }),

  /** Binary PDF/DOCX download — returns the response for blob handling. */
  resumeExport: async (conversationId: string, format: "pdf" | "docx", template?: string): Promise<Response> =>
    fetch("/api/laxii/resume/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, format, template }),
    }),

  exportBanner: (versionId: string, format: "png" | "jpeg" | "webp") =>
    api<{
      export: {
        mediaId: string;
        url: string;
        width: number;
        height: number;
        mime: string;
        bytes: number;
        transparent: boolean;
      };
    }>("/api/laxii/banner/export", { method: "POST", json: { versionId, format } }),
};
