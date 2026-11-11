/**
 * Code Giftz — change summarization.
 *
 * Deterministic before/after diff between two configs, used for:
 *  - the fallback change list when the model omits one,
 *  - the aggregated change summary after a multi-step execution,
 *  - the builder's unsaved-changes summary (same semantics).
 *
 * Pure module — safe to import from client and server code.
 */
import type { SiteConfig } from "@/lib/site-config";

/** Human-readable list of what changed between two configs. */
export function summarizeChanges(before: SiteConfig, after: SiteConfig): string[] {
  const out: string[] = [];
  if (before.template !== after.template) out.push(`Switched template to ${after.template}.`);
  if (before.name !== after.name) out.push(`Renamed the website to “${after.name}”.`);
  if (before.tagline !== after.tagline) out.push("Updated the tagline.");
  for (const key of Object.keys(before.theme) as (keyof SiteConfig["theme"])[]) {
    if (JSON.stringify(before.theme[key]) !== JSON.stringify(after.theme[key])) out.push(`Updated ${key === "glass" ? "the glass system" : String(key)} in the design tokens.`);
  }
  for (const key of Object.keys(before.motion) as (keyof SiteConfig["motion"])[]) {
    if (before.motion[key] !== after.motion[key]) out.push(`Updated motion setting “${String(key)}”.`);
  }
  const beforePages = new Map(before.pages.map((p) => [p.id, p]));
  for (const page of after.pages) {
    const bp = beforePages.get(page.id);
    if (!bp) {
      out.push(`Added the page “${page.name}”.`);
      continue;
    }
    if (bp.name !== page.name) out.push(`Renamed the page to “${page.name}”.`);
    if (bp.visible !== page.visible) out.push(`${page.visible ? "Unhid" : "Hid"} the page “${page.name}”.`);
    const beforeIds = new Map(bp.sections.map((s) => [s.id, s]));
    for (const s of page.sections) {
      const b = beforeIds.get(s.id);
      if (!b) out.push(`Added a ${s.type} section (“${s.title}”) on “${page.name}”.`);
      else if (JSON.stringify(b) !== JSON.stringify(s)) out.push(`Updated the ${s.type} section (“${s.title}”).`);
    }
    for (const s of bp.sections) if (!page.sections.some((x) => x.id === s.id)) out.push(`Removed the ${s.type} section (“${s.title}”).`);
  }
  for (const p of before.pages) if (!after.pages.some((ap) => ap.id === p.id)) out.push(`Removed the page “${p.name}”.`);
  return out.length > 0 ? out : ["Adjusted the website configuration."];
}

/** Aggregate per-step change lists into a deduped summary (order preserved). */
export function aggregateStepChanges(stepChanges: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of stepChanges) {
    for (const c of list) {
      const key = c.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out.slice(0, 16);
}
