/**
 * Project category slug → human label map, shared by client views and the
 * server-side website exporter (a "use client" module's exports become client
 * references in server bundles, so server code cannot import ProjectCard's
 * map directly — this leaf module is the single source of truth instead).
 *
 * Extended for the Universal Profession Taxonomy: the 18 legacy entries stay
 * EXACTLY as-is and first (UI dropdown ordering depends on it); the full
 * taxonomy from src/lib/professions/taxonomy.ts follows, ordered by family
 * then profession. Legacy slugs are never duplicated or renamed.
 */
import { PROFESSION_FAMILIES, LEGACY_PROFESSIONS } from "@/lib/professions/taxonomy";

const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  "film-video": "Film & Video",
  "motion-design": "Motion Design",
  photography: "Photography",
  "graphic-design": "Graphic Design",
  "ui-ux": "UI/UX Design",
  "product-design": "Product Design",
  illustration: "Illustration",
  art: "Fine Art",
  "software-dev": "Software Development",
  architecture: "Architecture",
  "civil-engineering": "Civil Engineering",
  writing: "Writing & Journalism",
  education: "Education & Research",
  culinary: "Culinary & Hospitality",
  marketing: "Marketing & Business",
  music: "Music & Audio",
  fashion: "Fashion",
  other: "Other",
};

/** Slugs owned by the legacy block — must keep their exact labels + position. */
const LEGACY_SLUGS = new Set(LEGACY_PROFESSIONS.map((l) => l.slug));

/** Remaining taxonomy slugs, family order → profession order. */
const TAXONOMY_CATEGORY_LABELS: Record<string, string> = {};
for (const family of [...PROFESSION_FAMILIES].sort((a, b) => a.order - b.order)) {
  for (const profession of family.professions) {
    if (LEGACY_SLUGS.has(profession.slug)) continue;
    if (!(profession.slug in TAXONOMY_CATEGORY_LABELS)) {
      TAXONOMY_CATEGORY_LABELS[profession.slug] = profession.label;
    }
  }
}

export const CATEGORY_LABELS: Record<string, string> = {
  ...LEGACY_CATEGORY_LABELS,
  ...TAXONOMY_CATEGORY_LABELS,
};

export function categoryLabel(slug?: string | null): string {
  if (!slug) return "Uncategorized";
  return CATEGORY_LABELS[slug] ?? slug;
}
