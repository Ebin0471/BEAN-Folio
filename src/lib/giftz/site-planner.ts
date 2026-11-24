/**
 * BEAN Folio — Universal website planner and capability router (M33.2).
 *
 * Deterministic, registry-backed planning on top of
 * `src/lib/giftz/site-taxonomy.ts`. Given a brief (and optional explicit
 * family/pages/features), it produces:
 *   1. a website-family classification with honest confidence + alternates;
 *   2. a sitemap/page plan whose section choices come from the REAL
 *      `SECTION_TYPES` registry only;
 *   3. a per-feature capability matrix (static-ready / backend-required /
 *      owner-setup-required / unsupported) — never a fabricated
 *      "connected" claim;
 *   4. an explicit content-gap list and assumptions;
 *   5. a generation-mode route: "config" | "files" | "backend-required".
 *
 * Security posture: brief text, requested pages and requested features are
 * UNTRUSTED DATA. They are only matched against registry signals — planner
 * output is plain JSON data (no executable content), prompt-injection phrases
 * gain no privileges, and backend-required routes can never be argued back
 * into config/files mode by prompt text. Machine-pinned by
 * `tests/giftz-site-planner.test.ts`.
 */

import { SECTION_TYPES, type SiteSectionType } from "@/lib/site-config";
import {
  WEBSITE_FAMILIES,
  WEBSITE_FAMILY_IDS,
  getWebsiteFamily,
  type FeatureTier,
  type WebsiteFamily,
} from "@/lib/giftz/site-taxonomy";

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PlannerInput {
  /** Free-text brief (untrusted data — matched against registry signals only). */
  brief: string;
  /** Explicit family id (validated; unknown → rejection). */
  familyId?: string;
  /** Additional page slugs requested by the user (validated as slugs). */
  pages?: string[];
  /** Requested dynamic features (untrusted data — matched against registry features). */
  features?: string[];
}

export interface PlannerRejection {
  ok: false;
  field: string;
  reason: string;
  suggestions: string[];
}

export type PlannerResult =
  | { ok: true; plan: WebsitePlanProposal }
  | PlannerRejection;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface FamilyClassification {
  family: WebsiteFamily;
  confidence: "high" | "medium" | "low";
  score: number;
  alternates: { id: string; label: string; score: number }[];
}

export function classifyWebsiteFamily(brief: string): FamilyClassification {
  const text = brief.toLowerCase();

  const scored = WEBSITE_FAMILIES.map((family) => {
    let score = 0;
    for (const signal of family.signals) {
      if (signal.includes(" ")) {
        // Phrase signals score higher when present.
        if (text.includes(signal)) score += 3;
      } else if (new RegExp(`\\b${signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) {
        score += 2;
      }
    }
    return { family, score };
  }).sort((a, b) => b.score - a.score || a.family.id.localeCompare(b.family.id));

  const top = scored[0];
  const second = scored[1];
  const alternates = scored
    .slice(1)
    .filter((s) => s.score > 0)
    .slice(0, 2)
    .map((s) => ({ id: s.family.id, label: s.family.label, score: s.score }));

  let confidence: FamilyClassification["confidence"] = "low";
  if (top.score >= 4 && top.score - (second?.score ?? 0) >= 3) confidence = "high";
  else if (top.score >= 2) confidence = "medium";

  return {
    family: top.family,
    confidence,
    score: top.score,
    alternates,
  };
}

// ---------------------------------------------------------------------------
// Sitemap + section planning (SECTION_TYPES-registry-backed)
// ---------------------------------------------------------------------------

/** Default section plans per page role — every entry is a real SECTION_TYPES id. */
const PAGE_SECTION_PLAN: Record<string, SiteSectionType[]> = {
  home: ["hero", "featured", "about"],
  about: ["about", "experience", "testimonials"],
  work: ["projects", "gallery"],
  services: ["services", "process", "pricing"],
  contact: ["contact", "faq"],
  faq: ["faq"],
  privacy: ["about"],
  terms: ["about"],
  shop: ["collections", "featured"],
  product: ["featured"],
  articles: ["projects"],
  article: ["about"],
  programs: ["services", "process"],
  listings: ["collections"],
  property: ["featured", "gallery"],
  schedule: ["process"],
  venue: ["gallery"],
  menu: ["collections"],
  pricing: ["pricing", "faq"],
  docs: ["about", "projects"],
  guides: ["projects"],
  reference: ["projects"],
  roles: ["projects"],
  overview: ["stats"],
};

function sectionPlanForPage(page: string, family: WebsiteFamily): SiteSectionType[] {
  const planned = PAGE_SECTION_PLAN[page];
  if (planned) return planned.filter((s) => SECTION_TYPES.includes(s));
  // Registry-safe fallback: every family gets hero+about on unknown pages so
  // the plan never references a section type the schema cannot parse.
  void family;
  return ["hero", "about"];
}

export interface PlannedPage {
  slug: string;
  role: "family-core" | "user-requested";
  intent: string;
  sections: SiteSectionType[];
}

// ---------------------------------------------------------------------------
// Feature matrix
// ---------------------------------------------------------------------------

export interface FeatureRow {
  feature: string;
  matchedFamilyFeature: string | null;
  tier: FeatureTier | "unrecognized";
  note: string | null;
  /** true when the user's brief/explicit list asked for it; false = honest disclosure of the family's capability state. */
  requestedByUser: boolean;
}

function featureNameOverlap(text: string, feature: string): boolean {
  const a = text.toLowerCase().trim();
  const b = feature.toLowerCase();
  if (!a) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aw = new Set(a.split(/[^a-z]+/).filter((w) => w.length > 3));
  const bw = new Set(b.split(/[^a-z]+/).filter((w) => w.length > 3));
  if (aw.size === 0 || bw.size === 0) return false;
  let inter = 0;
  for (const w of aw) if (bw.has(w)) inter++;
  return inter / Math.min(aw.size, bw.size) >= 0.5;
}

function featureRows(family: WebsiteFamily, requestedFeatures: string[], brief: string): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const registry = family.dynamicFeatures;
  const text = brief.toLowerCase();

  for (const f of registry) {
    const requestedByUser =
      requestedFeatures.some((req) => featureNameOverlap(req, f.feature)) ||
      featureNameOverlap(text, f.feature);
    rows.push({
      feature: f.feature,
      matchedFamilyFeature: f.feature,
      tier: f.tier,
      note: f.note ?? null,
      requestedByUser,
    });
  }

  // Explicitly requested features with NO registry match are reported honestly
  // as "unrecognized" — never silently mapped to a tier they didn't earn.
  for (const req of requestedFeatures) {
    const normalized = req.toLowerCase().trim();
    if (!normalized) continue;
    const match = registry.find((f) => featureNameOverlap(req, f.feature));
    if (match) continue; // already covered by the registry row above
    rows.push({
      feature: req,
      matchedFamilyFeature: null,
      tier: "unrecognized",
      note: "Not a registered capability for this website family — treat as static content at most; it must not be presented as a working integration.",
      requestedByUser: true,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Content gaps + mode routing
// ---------------------------------------------------------------------------

interface ContentGap {
  gap: string;
  why: string;
}

function contentGaps(family: WebsiteFamily, brief: string): ContentGap[] {
  const gaps: ContentGap[] = [];
  const text = brief.toLowerCase();

  if (family.corePages.includes("pricing") && !text.includes("price") && !text.includes("pricing")) {
    gaps.push({
      gap: "Pricing facts",
      why: "The plan includes a pricing surface but the brief supplies no prices. Do not invent numbers — leave the section empty or request the facts.",
    });
  }
  if (family.corePages.some((p) => p.startsWith("privacy")) || family.dynamicFeatures.length > 0) {
    if (!text.includes("privacy") && !text.includes("policy")) {
      gaps.push({
        gap: "Privacy/policies copy",
        why: "Public sites need real policy text; generated boilerplate is not legal advice. Ask the owner for approved copy.",
      });
    }
  }
  if (!text.includes("contact") && family.corePages.includes("contact")) {
    gaps.push({
      gap: "Contact details",
      why: "No contact channel was supplied. Static sites fall back to clearly-labelled mailto links; stored inquiries need the backend tier.",
    });
  }
  gaps.push({
    gap: "Imagery rights",
    why: "Only user-owned uploads, LAXII-generated assets or explicitly licensed media may be used — no scraped stock imagery (Guide Stage 8).",
  });
  return gaps;
}

export type GenerationMode = "config" | "files" | "backend-required";

export interface ArchitectureRequest {
  module: string;
  requirement: string;
  tier: FeatureTier;
  note: string;
}

export interface WebsitePlanProposal {
  family: { id: string; label: string; examples: string[]; note?: string };
  classification: { confidence: "high" | "medium" | "low"; score: number; alternates: { id: string; label: string; score: number }[]; explicitFamily: boolean };
  sitemap: PlannedPage[];
  featureMatrix: FeatureRow[];
  contentGaps: ContentGap[];
  assumptions: string[];
  route: {
    mode: GenerationMode;
    reason: string;
    architectureRequest: ArchitectureRequest[] | null;
  };
}

/** User phrases that request custom visual behaviour beyond config mode. */
const FILE_MODE_SIGNALS = [
  "custom layout",
  "custom animation",
  "bespoke",
  "interactive",
  "webgl",
  "3d scene",
  "custom code",
  "specific design",
  "unique layout",
];

export function planWebsiteArchitecture(input: PlannerInput): PlannerResult {
  // Explicit family id is validated strictly (unknown → rejection, never guessed).
  let classification: FamilyClassification;
  let explicitFamily = false;
  if (input.familyId !== undefined) {
    const family = getWebsiteFamily(input.familyId);
    if (!family) {
      return {
        ok: false,
        field: "familyId",
        reason: `Unknown website family id "${input.familyId}".`,
        suggestions: WEBSITE_FAMILY_IDS.slice(0, 8),
      };
    }
    classification = {
      family,
      confidence: "high",
      score: 0,
      alternates: [],
    };
    explicitFamily = true;
  } else {
    classification = classifyWebsiteFamily(input.brief);
  }

  const family = classification.family;

  // Page validation: slugs only; invalid requests are rejected, not sanitized.
  const pages: PlannedPage[] = [];
  for (const core of family.corePages) {
    pages.push({
      slug: core,
      role: "family-core",
      intent: `${core} page for a ${family.label.toLowerCase()}`,
      sections: sectionPlanForPage(core, family),
    });
  }
  const seen = new Set(family.corePages);
  for (const page of input.pages ?? []) {
    const slug = page.toLowerCase().trim();
    if (!SLUG_RE.test(slug)) {
      return {
        ok: false,
        field: "pages",
        reason: `"${page}" is not a valid page slug (lowercase letters, digits, hyphens; no leading hyphen).`,
        suggestions: family.corePages,
      };
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      pages.push({
        slug,
        role: "user-requested",
        intent: `${slug} page requested in the brief`,
        sections: sectionPlanForPage(slug, family),
      });
    }
  }

  const featureMatrix = featureRows(family, input.features ?? [], input.brief);
  const BLOCKING_TIERS = new Set<FeatureTier>(["backend-required", "unsupported", "owner-setup-required"]);
  const blocking = featureMatrix.filter(
    (r): r is FeatureRow & { tier: FeatureTier } =>
      r.requestedByUser && r.tier !== "unrecognized" && BLOCKING_TIERS.has(r.tier),
  );

  const assumptions: string[] = [];
  if (!explicitFamily) {
    assumptions.push(
      `Family "${family.id}" was classified from the brief text (confidence: ${classification.confidence}); pass familyId explicitly to remove classification ambiguity.`,
    );
  }
  if (classification.confidence === "low") {
    assumptions.push(
      "The brief was too vague for confident classification — confirm the website family before treating the sitemap as final.",
    );
  }
  assumptions.push(
    "All section choices come from the live SECTION_TYPES registry; the plan contains no executable code and no fabricated integrations.",
  );

  // Mode routing.
  let mode: GenerationMode;
  let reason: string;
  let architectureRequest: ArchitectureRequest[] | null = null;

  if (blocking.length > 0) {
    mode = "backend-required";
    reason =
      "The requested experience needs server-side capabilities that generated static sites do not have (sandboxed CSP, no database, no credentials). Build the static tier now; the backend tier requires the separately reviewed BEAN Application Runtime (Guide §5).";
    architectureRequest = blocking.map((r) => ({
      module: r.matchedFamilyFeature ?? r.feature,
      requirement: r.feature,
      tier: r.tier,
      note: r.note ?? "Requires an isolated, reviewed server capability.",
    }));
  } else {
    const lowerBrief = input.brief.toLowerCase();
    const wantsFiles = FILE_MODE_SIGNALS.some((s) => lowerBrief.includes(s));
    if (wantsFiles) {
      mode = "files";
      reason =
        "The brief requests custom layout/interaction behaviour that config mode cannot express — route through the sandboxed project-file agent (plan → build → proposal → approval).";
    } else {
      mode = "config";
      reason =
        "The request fits the structured SiteConfig schema (sections, theme, motion presets) — prefer deterministic config mode.";
    }
  }

  return {
    ok: true,
    plan: {
      family: {
        id: family.id,
        label: family.label,
        examples: family.examples,
        ...(family.note ? { note: family.note } : {}),
      },
      classification: {
        confidence: classification.confidence,
        score: classification.score,
        alternates: classification.alternates,
        explicitFamily,
      },
      sitemap: pages,
      featureMatrix,
      contentGaps: contentGaps(family, input.brief),
      assumptions,
      route: { mode, reason, architectureRequest },
    },
  };
}
