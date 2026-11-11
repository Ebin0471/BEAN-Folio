/**
 * Code Giftz — preservation constraints.
 *
 * When a user says "leave the project grid untouched", the plan captures that
 * as a constraint with concrete targets (section ids / section types / page
 * ids / token groups). This module:
 *  - resolves free-text-ish targets against the real digest,
 *  - CHECKS the working config against the base config for violations,
 *  - RESTORES any protected region byte-identically from the base config.
 *
 * This is what makes "respect explicit constraints" a mechanical guarantee
 * instead of a prompt-time hope.
 *
 * Pure module — safe to import from client and server code.
 */
import type { SiteConfig } from "@/lib/site-config";
import type { DesignPlan } from "@/lib/ai-design/plan";

export type ConstraintTargetKind = "section-id" | "section-type" | "page" | "token-group";

export interface ResolvedConstraintTarget {
  raw: string;
  kind: ConstraintTargetKind;
  value: string;
}

const TOKEN_GROUPS = ["colors", "theme", "fonts", "typography", "motion", "content", "pages", "sections", "name", "tagline"] as const;

/** Singular / loose forms models write, mapped into canonical token groups. */
const TOKEN_GROUP_ALIASES: Record<string, string> = {
  color: "colors",
  font: "fonts",
  section: "sections",
  page: "pages",
  theme: "theme",
};

/** Resolve one constraint target against the digest's real ids/types/pages. */
export function resolveConstraintTarget(
  raw: string,
  digest: { pages: { id: string; name: string; sections: { id: string; type: string }[] }[] }
): ResolvedConstraintTarget | null {
  const t0 = raw.trim().toLowerCase();
  if (!t0) return null;
  const t = TOKEN_GROUP_ALIASES[t0] ?? t0;
  if ((TOKEN_GROUPS as readonly string[]).includes(t)) {
    return { raw, kind: "token-group", value: t === "colors" ? "theme" : t === "fonts" ? "typography" : t };
  }
  for (const page of digest.pages) {
    for (const s of page.sections) {
      if (s.id.toLowerCase() === t) return { raw, kind: "section-id", value: s.id };
      if (s.type.toLowerCase() === t) return { raw, kind: "section-type", value: s.type };
    }
  }
  for (const page of digest.pages) {
    if (page.id.toLowerCase() === t || page.name.toLowerCase() === t) return { raw, kind: "page", value: page.id };
  }
  // common natural phrases → section types
  const phrases: Record<string, string> = {
    "project grid": "projects",
    "projects grid": "projects",
    "portfolio grid": "projects",
    "project grid section": "projects",
    hero: "hero",
    header: "hero",
    "about section": "about",
    "contact section": "contact",
    navigation: "navLayout",
    nav: "navLayout",
    footer: "content",
  };
  const mapped = phrases[t];
  if (mapped) {
    if ((TOKEN_GROUPS as readonly string[]).includes(mapped)) return { raw, kind: "token-group", value: mapped };
    const exists = digest.pages.some((p) => p.sections.some((s) => s.type === mapped));
    if (exists) return { raw, kind: "section-type", value: mapped };
  }
  return null;
}

/** All resolved targets of a plan's constraints (deduped). */
export function resolvedConstraintTargets(plan: DesignPlan, digest: Parameters<typeof resolveConstraintTarget>[1]): ResolvedConstraintTarget[] {
  const out: ResolvedConstraintTarget[] = [];
  const seen = new Set<string>();
  for (const c of plan.constraints) {
    for (const t of c.targets) {
      const r = resolveConstraintTarget(t, digest);
      if (r && !seen.has(`${r.kind}:${r.value}`)) {
        seen.add(`${r.kind}:${r.value}`);
        out.push(r);
      }
    }
  }
  return out;
}

export interface ConstraintViolation {
  kind: ConstraintTargetKind;
  value: string;
  detail: string;
}

function sectionChanged(a: SiteConfig, b: SiteConfig, sectionId: string): boolean {
  const sa = a.pages.flatMap((p) => p.sections).find((s) => s.id === sectionId);
  const sb = b.pages.flatMap((p) => p.sections).find((s) => s.id === sectionId);
  return JSON.stringify(sa) !== JSON.stringify(sb);
}

function pageChanged(a: SiteConfig, b: SiteConfig, pageId: string): boolean {
  const pa = a.pages.find((p) => p.id === pageId);
  const pb = b.pages.find((p) => p.id === pageId);
  return JSON.stringify(pa) !== JSON.stringify(pb);
}

/**
 * Verify the working config still honors every preservation constraint.
 * Only targets that EXIST in the base config are enforced (constraints about
 * things that don't exist are no-ops by definition).
 */
export function checkConstraints(
  base: SiteConfig,
  working: SiteConfig,
  targets: ResolvedConstraintTarget[]
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  for (const t of targets) {
    switch (t.kind) {
      case "section-id": {
        const exists = base.pages.some((p) => p.sections.some((s) => s.id === t.value));
        if (exists && sectionChanged(base, working, t.value)) {
          violations.push({ kind: t.kind, value: t.value, detail: `Protected section “${t.value}” was modified.` });
        }
        break;
      }
      case "section-type": {
        for (const s of base.pages.flatMap((p) => p.sections)) {
          if (s.type === t.value && sectionChanged(base, working, s.id)) {
            violations.push({ kind: t.kind, value: t.value, detail: `Protected ${t.value} section “${s.title}” was modified.` });
          }
        }
        break;
      }
      case "page": {
        if (base.pages.some((p) => p.id === t.value) && pageChanged(base, working, t.value)) {
          violations.push({ kind: t.kind, value: t.value, detail: `Protected page “${t.value}” was modified.` });
        }
        break;
      }
      case "token-group": {
        const changed =
          (t.value === "theme" && JSON.stringify(base.theme) !== JSON.stringify(working.theme)) ||
          (t.value === "motion" && JSON.stringify(base.motion) !== JSON.stringify(working.motion)) ||
          (t.value === "typography" &&
            (base.theme.headingFont !== working.theme.headingFont ||
              base.theme.bodyFont !== working.theme.bodyFont ||
              base.theme.accentFont !== working.theme.accentFont ||
              base.theme.codeFont !== working.theme.codeFont)) ||
          (t.value === "name" && base.name !== working.name) ||
          (t.value === "tagline" && base.tagline !== working.tagline) ||
          (t.value === "content" && JSON.stringify(base.pages) !== JSON.stringify(working.pages)) ||
          (t.value === "pages" && JSON.stringify(base.pages.map((p) => p.id)) !== JSON.stringify(working.pages.map((p) => p.id))) ||
          (t.value === "sections" && base.pages.flatMap((p) => p.sections).length !== working.pages.flatMap((p) => p.sections).length);
        if (changed) {
          violations.push({ kind: t.kind, value: t.value, detail: `Protected ${t.value} were modified.` });
        }
        break;
      }
    }
  }
  return violations;
}

/**
 * Restore every protected region byte-identically from the base config.
 * Returns the repaired working config (and reports what was restored).
 */
export function restorePreserved(
  base: SiteConfig,
  working: SiteConfig,
  targets: ResolvedConstraintTarget[]
): { config: SiteConfig; restored: string[] } {
  let next = working;
  const restored: string[] = [];

  const protectedPageIds = new Set(targets.filter((t) => t.kind === "page").map((t) => t.value));
  const protectedSectionIds = new Set(targets.filter((t) => t.kind === "section-id").map((t) => t.value));
  const protectedTypes = new Set(targets.filter((t) => t.kind === "section-type").map((t) => t.value));
  const tokenGroups = new Set(targets.filter((t) => t.kind === "token-group").map((t) => t.value));

  // Token groups
  if (tokenGroups.has("theme")) {
    next = { ...next, theme: base.theme };
    restored.push("theme tokens");
  }
  if (tokenGroups.has("motion")) {
    next = { ...next, motion: base.motion };
    restored.push("motion settings");
  }
  if (tokenGroups.has("typography")) {
    next = {
      ...next,
      theme: { ...next.theme, headingFont: base.theme.headingFont, bodyFont: base.theme.bodyFont, accentFont: base.theme.accentFont, codeFont: base.theme.codeFont },
    };
    restored.push("typography");
  }
  if (tokenGroups.has("name")) {
    next = { ...next, name: base.name };
    restored.push("website name");
  }
  if (tokenGroups.has("tagline")) {
    next = { ...next, tagline: base.tagline };
    restored.push("tagline");
  }
  if (tokenGroups.has("content") || tokenGroups.has("pages") || tokenGroups.has("sections")) {
    next = { ...next, pages: base.pages };
    restored.push("pages and sections");
  }

  // Pages (whole-page protection) — restore from base by id
  if (protectedPageIds.size > 0) {
    next = {
      ...next,
      pages: next.pages.map((p) => {
        const bp = base.pages.find((b) => b.id === p.id);
        if (bp && protectedPageIds.has(p.id) && JSON.stringify(bp) !== JSON.stringify(p)) {
          restored.push(`page “${p.name}”`);
          return bp;
        }
        return p;
      }),
    };
  }

  // Sections — restore protected sections inside their (unprotected) pages
  if (protectedSectionIds.size > 0 || protectedTypes.size > 0) {
    next = {
      ...next,
      pages: next.pages.map((p) => {
        const bp = base.pages.find((b) => b.id === p.id);
        if (!bp) return p;
        let changed = false;
        const sections = p.sections.map((s) => {
          const bs = bp.sections.find((b) => b.id === s.id);
          if (!bs) return s;
          const isProtected = protectedSectionIds.has(s.id) || protectedTypes.has(s.type);
          if (isProtected && JSON.stringify(bs) !== JSON.stringify(s)) {
            changed = true;
            restored.push(`${s.type} section “${s.title}”`);
            return bs;
          }
          return s;
        });
        return changed ? { ...p, sections } : p;
      }),
    };
  }

  return { config: next, restored: Array.from(new Set(restored)) };
}
