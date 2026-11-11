import type { SiteConfig } from "@/lib/site-config";
import type { StudioCustomFields } from "@/lib/studio-schema";

/**
 * BEAN Folio — shared DTO types used by both API routes and the SPA.
 * These mirror the API contract in worklog.md. Pure types only — no server imports.
 */

export interface PublicMe {
  id: string;
  email: string;
  name: string;
  username: string | null;
  headline: string | null;
  bio: string | null;
  location: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  coverPositionY: number;
  avatarFit: string;
  avatarZoom: number;
  avatarPosX: number;
  avatarPosY: number;
  availability: string | null;
  experienceLevel: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  professions: string[];
  skills: string[];
  aiConsent: boolean;
  onboarded: boolean;
  profileVisibility: string;
  isDemo: boolean;
  /** USER | ADMIN — the SPA uses this only to show/hide admin surfaces;
   *  the server re-checks the role on every admin API call. */
  role: string;
  createdAt: string;
}

export interface PublicPerson {
  username: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  location: string | null;
  availability?: string | null;
  professions: string[];
  skills: string[];
  stats: { followers: number; projects: number };
}

/** The parsed customFields envelope (see lib/studio-schema). Shared DTO shape. */
export type ProjectCustomFields = StudioCustomFields;

export interface ProjectCardDTO {
  id: string;
  title: string;
  summary: string | null;
  category: string | null;
  /** Profession-aware work type (parsed from the customFields envelope). */
  kind: string | null;
  /** Dedicated cover asset — may live outside the project media gallery. */
  coverMediaId: string | null;
  coverUrl: string | null;
  coverKind: string | null;
  visibility: string;
  status: string;
  publishedAt: string | null;
  /** Universal Studio archive state — set when the owner archived the project (owner-private, restorable). */
  archivedAt: string | null;
  /** Creator-curated featured mark (Studio portfolio curation). */
  featured: boolean;
  updatedAt: string;
  createdAt: string;
  owner: { username: string; name: string; avatarUrl: string | null };
  counts: { views: number; saves: number };
  skills: string[];
}

export interface ProjectMediaDTO {
  id: string;
  mediaId: string;
  url: string;
  kind: string;
  caption: string | null;
  order: number;
}

export interface FullProject extends ProjectCardDTO {
  description: string | null;
  /** Full parsed envelope — kind, templateId, structured fields, custom fields. */
  customFields: ProjectCustomFields | null;
  brief: string | null;
  process: string | null;
  challenges: string | null;
  outcome: string | null;
  role: string | null;
  externalUrl: string | null;
  repoUrl: string | null;
  tools: string[];
  media: ProjectMediaDTO[];
  contributors: { id: string; name: string; role: string | null; contribution: string | null }[];
}

export interface DiscoverItem {
  project: ProjectCardDTO;
  reason?: string;
}

export interface ProjectDetailResponse {
  project: FullProject;
  owner: PublicPerson;
  isOwner: boolean;
  isSaved: boolean;
  canEdit: boolean;
}

export interface PublicProfileResponse {
  profile: Omit<PublicPerson, "stats"> & {
    bio: string | null;
    websiteUrl: string | null;
    contactEmail: string | null;
    experienceLevel: string | null;
    coverUrl: string | null;
    coverPositionY: number;
    avatarFit: string;
    avatarZoom: number;
    avatarPosX: number;
    avatarPosY: number;
    createdAt: string;
    stats: { followers: number; following: number; projects: number; profileViews: number };
  };
  isFollowing: boolean;
  isSelf: boolean;
  projects: ProjectCardDTO[];
  collections: { id: string; name: string; description: string | null; items: ProjectCardDTO[] }[];
  /** Published custom website for this profile (visitors + owner alike). */
  site: {
    status: "PUBLISHED" | "NONE";
    config: SiteConfig | null;
    /**
     * Platform-level setting: renders the small "Made with BEAN Folio ·
     * GIFTZ" attribution in the site footer. Applied by the renderer at view
     * time — never part of the site snapshot — so it can never be duplicated
     * by republishing or corrupted by content edits.
     */
    watermark: boolean;
  };
  /** Owner-only: the current draft so the builder can restore it. */
  siteDraft?: SiteConfig | null;
  sitePublishedAt?: string | null;
}

export interface InquiryDTO {
  id: string;
  type: string;
  subject: string;
  message: string;
  status: string;
  createdAt: string;
  project?: { id: string; title: string } | null;
  counterparty: PublicPerson;
}

export interface NotificationDTO {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface ProfessionDTO {
  slug: string;
  label: string;
  group: string;
}

export interface SkillDTO {
  slug: string;
  label: string;
}

export interface MediaDTO {
  id: string;
  kind: string;
  mime: string;
  size: number;
  url: string;
}

export interface AiCapabilitiesDTO {
  available: boolean;
  provider: string;
  features: { id: string; label: string; description: string }[];
  dailyLimit: number;
  usedToday: number;
  consentRequired: boolean;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface AiMessageDTO {
  role: string;
  content: string;
  createdAt: string;
}

export interface SiteDesignDTO {
  status: "DRAFT" | "PUBLISHED";
  draft: SiteConfig | null;
  published: SiteConfig | null;
  publishedAt: string | null;
  /** Footer attribution setting — live (applies without republishing). */
  watermark: boolean;
  /** Canonical public ROUTE of this website, e.g. "/site/ada" (no leading "#"). See lib/site-url — /u/<name> is the public PROFILE, /site/<name> is this standalone WEBSITE. */
  publicUrl: string | null;
  /**
   * Fully-qualified canonical share URL, e.g. "https://beanfolio.com/site/ada".
   * Built ONLY from a verified source (see lib/site-url +
   * lib/workspace-origin): deployment configuration (NEXT_PUBLIC_APP_URL /
   * VERCEL_URL), or the current environment's edge host AFTER it passed the
   * active origin-proof round trip. Never from an unverified request host.
   * Null when no verified public origin exists.
   */
  canonicalUrl: string | null;
  /** Which verified source produced canonicalUrl (null when canonicalUrl is null). */
  canonicalKind: "production" | "workspace" | null;
  /**
   * Why canonicalUrl is unavailable (with the actionable fix). Null when
   * canonicalUrl exists. "unverified-host" = the current environment's host
   * could not be proven publicly routed.
   */
  canonicalUrlUnavailable: {
    reason: "not-configured" | "invalid-config" | "unverified-host";
    message: string;
  } | null;
}

export interface AiDesignProposal {
  /** Fully validated, renderable config the proposal would produce. */
  config: SiteConfig;
  /** Human-readable summary of the individual changes. */
  changes: string[];
  reply: string;
}

/** One server-side draft snapshot (site revisions — "Restore previous version"). */
export interface SiteRevisionDTO {
  id: string;
  label: string;
  createdAt: string;
  summary: string;
  restorable: boolean;
}

/** One uploaded source material for Code Giftz's "create my own website" workflow. */
export interface SiteMaterialDTO {
  id: string;
  mediaId: string;
  label: string;
  kind: string;
  mime: string;
  size: number;
  extractStatus: "READY" | "EMPTY" | "FAILED";
  note: string | null;
  chars: number;
  meta: {
    pages?: number;
    chars?: number;
    width?: number | null;
    height?: number | null;
    description?: string;
    truncated?: boolean;
  };
  createdAt: string;
}

export interface InsightsOverview {
  totals: { profileViews: number; projectViews: number; saves: number; followers: number };
  series14d: { day: string; views: number }[];
  topProjects: { id: string; title: string; views: number; saves: number }[];
}

export interface InsightsProjects {
  projects: { id: string; title: string; views: number; saves: number; views14d: number }[];
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------- Profile image adjustments ----------
// Shared by profile-image.tsx and the avatar/cover adjust dialogs. The
// original upload is never modified — only this presentation metadata is
// persisted on the User record (avatarFit / avatarZoom / avatarPosX /
// avatarPosY / coverPositionY).

export interface AvatarAdjust {
  fit: "cover" | "contain";
  /** 0.5–3 zoom factor (1 = natural). */
  zoom: number;
  /** Focal point X in % (0–100). */
  posX: number;
  /** Focal point Y in % (0–100). */
  posY: number;
  /** Rotation in degrees — restricted to quarter turns. */
  rotate: 0 | 90 | 180 | 270;
  /** Contain-mode backdrop color (#rrggbb) or "" for none. */
  bg: string;
}

export interface CoverAdjust {
  /** 1–3 focal-anchored zoom factor (1 = natural). */
  zoom: number;
  /** Focal point X in % (0–100). */
  posX: number;
  /** Focal point Y in % (0–100). */
  posY: number;
}

export const DEFAULT_AVATAR_ADJUST: AvatarAdjust = {
  fit: "cover",
  zoom: 1,
  posX: 50,
  posY: 50,
  rotate: 0,
  bg: "",
};

export const DEFAULT_COVER_ADJUST: CoverAdjust = {
  zoom: 1,
  posX: 50,
  posY: 50,
};
