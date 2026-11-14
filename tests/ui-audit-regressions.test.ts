/**
 * UI audit regression guards (M20).
 *
 * Each test pins a real bug that was found and fixed during the
 * comprehensive UI audit so it cannot silently return:
 *
 *  1. Conversations/Automations header overlap — the RIISHE sidebar header
 *     must keep its wrap/shrink protections (measured +46px overflow into
 *     the thread panel before the fix).
 *  2. Route SEO titles — laxii/messages were missing from the private
 *     route registry and search/hashtags fell into the "Page not found"
 *     branch (browser tab showed "Page not found" on real pages).
 *  3. Glass surface backdrop blur — pairing `backdrop-filter` with
 *     `-webkit-backdrop-filter` in globals.css made the CSS minifier drop
 *     both declarations; the standard property alone must stay.
 *  4. Upload route presence — the workspace restore has twice dropped
 *     src/app/api/media/upload/route.ts (the historic "Upload failed 405"
 *     incident); its POST export is load-bearing.
 *
 * These are source-level guards by design: the underlying defects are
 * browser-layout/SEO/CSS-pipeline behaviors that only fully reproduce in a
 * rendered document, and the repo's test suite has no DOM-render harness.
 * Every pinned fact was verified live in the browser during the audit
 * (docs/ui-audit-screenshots/).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("M20 UI audit regression guards", () => {
  test("RIISHE sidebar header keeps overlap protections", () => {
    const view = read("src/views/IntelligenceView.tsx");
    // The header row must wrap instead of colliding at the 260px sidebar.
    expect(view).toContain("flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5");
    // The heading yields (min-w-0) and the action group never compresses.
    expect(view).toContain('className="min-w-0 text-sm font-medium text-foreground"');
    expect(view).toContain('className="flex shrink-0 items-center gap-1.5"');
    // Both header buttons opt out of shrinking.
    expect(view).toContain('className="shrink-0"');
  });

  test("route SEO registry covers laxii, messages, search and hashtags", () => {
    const shell = read("src/components/bean/SiteShell.tsx");
    // Private routes must have real labels — no accidental "Page not found".
    expect(shell).toContain('laxii: "LAXII"');
    expect(shell).toContain('messages: "Messages"');
    // Public routes must be handled BEFORE the unknown-route fallback.
    expect(shell).toContain('root === "search"');
    expect(shell).toContain('root === "hashtags"');
  });

  test("glass-surface keeps a minifier-safe backdrop-filter", () => {
    const css = read("src/app/globals.css");
    const block = css.slice(css.indexOf(".glass-surface"), css.indexOf(".hairline"));
    expect(block).toContain("backdrop-filter: blur(14px)");
    // The -webkit- pairing is what made the minifier drop the whole
    // declaration — its presence is the regression itself.
    expect(block).not.toContain("-webkit-backdrop-filter");
  });

  test("POST /api/media/upload route file exists and is load-bearing", () => {
    const route = read("src/app/api/media/upload/route.ts");
    expect(route).toContain("export const POST");
    // The route docblock records why the static segment must never vanish.
    expect(route).toContain("/api/media/upload");
  });

  test("ai-design driver primitives stay exported (production compile guard)", () => {
    const jobs = read("src/lib/ai-design/jobs.ts");
    // driver.ts imports these five — before the M20 fix they existed in no
    // lineage and the production build failed with 5 module errors.
    for (const fn of ["claimJob", "persistJob", "releaseLease", "applyFailure"]) {
      expect(jobs).toContain(`export async function ${fn}`);
    }
    expect(jobs).toContain("export function appendEvent");
    // The runner keeps the driver's bounded-chunk controls.
    const execute = read("src/lib/ai-design/execute.ts");
    expect(execute).toContain('"yielded"');
    expect(execute).toContain("export interface RunOptions");
    expect(execute).toContain("allowedMediaIds?: string[]");
  });
});
