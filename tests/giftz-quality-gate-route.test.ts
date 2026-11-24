/// <reference types="bun-types" />
/**
 * GIFTZ quality gate ROUTE — regression tests for the HTTP boundary
 * (src/app/api/giftz/quality-gate/route.ts, M33.3):
 *
 *   POST { siteId }:
 *   - no session                     → 401
 *   - another user's site id         → 404 (existence not leaked)
 *   - own site without HTML pages    → 400 (honest "generate first")
 *   - own site with a compiled tree  → 200 + consolidated report over the
 *     REAL files (a11y/SEO/links/responsive/perf findings + untested list)
 *
 * Tests create a dedicated QA account + its OWN GIFTZ site rows and clean
 * up everything in afterAll. Run against the isolated QA database only.
 *
 * Run: bun test tests/giftz-quality-gate-route.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { POST as qualityGateRoute } from "@/app/api/giftz/quality-gate/route";

const QA_EMAIL = "qa-quality-gate-route@beanfolio.test";
const OTHER_EMAIL = "qa-quality-gate-other@beanfolio.test";

const GOOD_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clean Page</title><meta name="description" content="A clean page."></head>
<body><h1>Clean</h1></body></html>`;

const FLAWED_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Flawed</title></head>
<body>
<h1>Flawed</h1><h3>Skipped level</h3>
<img src="assets/missing.jpg">
<a href="nowhere.html">Gone</a>
<a href="javascript:void(0)">Run</a>
</body></html>`;

let qaUserId = "";
let otherUserId = "";
let siteId = "";
let emptySiteId = "";

beforeAll(async () => {
  const qa = await db.user.create({
    data: {
      email: QA_EMAIL,
      name: "QA Quality Gate",
      passwordHash: await hashPassword("qa-only-password-123"),
    },
  });
  qaUserId = qa.id;
  const other = await db.user.create({
    data: {
      email: OTHER_EMAIL,
      name: "QA Quality Gate Other",
      passwordHash: await hashPassword("qa-only-password-456"),
    },
  });
  otherUserId = other.id;

  const site = await db.giftzSite.create({
    data: {
      userId: qaUserId,
      title: "QA Gate Site",
      config: JSON.stringify({ palette: "dark-luxury" }),
    },
  });
  siteId = site.id;
  await db.giftzProjectFile.createMany({
    data: [
      { siteId, path: "index.html", content: GOOD_PAGE, encoding: "utf8", source: "generated", sizeBytes: Buffer.byteLength(GOOD_PAGE) },
      { siteId, path: "flawed.html", content: FLAWED_PAGE, encoding: "utf8", source: "generated", sizeBytes: Buffer.byteLength(FLAWED_PAGE) },
      { siteId, path: "styles.css", content: "@media (max-width: 768px){body{font-size:15px}}", encoding: "utf8", source: "generated", sizeBytes: 48 },
    ],
  });

  const empty = await db.giftzSite.create({ data: { userId: qaUserId, title: "QA Empty Site" } });
  emptySiteId = empty.id;
});

afterAll(async () => {
  for (const uid of [qaUserId, otherUserId]) {
    if (!uid) continue;
    await db.giftzProjectFile.deleteMany({ where: { site: { userId: uid } } }).catch(() => {});
    await db.giftzSite.deleteMany({ where: { userId: uid } }).catch(() => {});
    await db.session.deleteMany({ where: { userId: uid } }).catch(() => {});
    await db.user.delete({ where: { id: uid } }).catch(() => {});
  }
  cookieToken = undefined;
});

function request(siteIdValue: string | null): NextRequest {
  return new NextRequest("http://localhost:3000/api/giftz/quality-gate", {
    method: "POST",
    body: JSON.stringify(siteIdValue === null ? {} : { siteId: siteIdValue }),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/giftz/quality-gate — route contract", () => {
  test("401 without a session (owner-scoped)", async () => {
    cookieToken = undefined;
    const res = await qualityGateRoute(request(siteId));
    expect(res.status).toBe(401);
  });

  test("404 for a foreign site — existence never leaked", async () => {
    cookieToken = await createSession(qaUserId);
    const foreign = await db.giftzSite.create({
      data: { userId: otherUserId, title: "Not yours" },
    });
    try {
      const res = await qualityGateRoute(request(foreign.id));
      expect(res.status).toBe(404);
    } finally {
      await db.giftzSite.delete({ where: { id: foreign.id } }).catch(() => {});
    }
  });

  test("400 with missing siteId / invalid body", async () => {
    cookieToken = await createSession(qaUserId);
    const missing = await qualityGateRoute(request(null));
    expect(missing.status).toBe(400);
  });

  test("400 honestly refuses a site with no compiled HTML pages", async () => {
    cookieToken = await createSession(qaUserId);
    const res = await qualityGateRoute(request(emptySiteId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe("quality-gate-no-pages");
    expect(body.error).toMatch(/no compiled HTML pages/);
  });

  test("200 happy path: consolidated report over the REAL project files", async () => {
    cookieToken = await createSession(qaUserId);
    const res = await qualityGateRoute(request(siteId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report?: {
        overall: string;
        summary: string;
        pagesChecked: number;
        checks: { id: string; status: string; evidence: { page: string; sample: string }[] }[];
        untested: string[];
      };
    };
    const report = body.report!;
    expect(report.pagesChecked).toBe(2);
    expect(report.overall).toBe("needs-work");

    const byId = new Map(report.checks.map((c) => [c.id, c]));
    // Real findings from the flawed page:
    expect(byId.get("a11y-img-alt")!.status).toBe("fail");
    expect(byId.get("a11y-html-lang")!.status).toBe("warn"); // flawed.html has no lang
    expect(byId.get("links-internal")!.status).toBe("fail"); // nowhere.html
    expect(byId.get("links-safety")!.status).toBe("fail"); // javascript:
    expect(byId.get("links-local-assets")!.status).toBe("fail"); // assets/missing.jpg
    expect(byId.get("resp-viewport-meta")!.status).toBe("fail"); // flawed.html has no viewport
    // The clean page passes its share; media queries found in styles.css:
    expect(byId.get("resp-media-queries")!.status).toBe("pass");
    // The site config names a real palette → contrast RAN (not not-run).
    expect(byId.get("a11y-contrast")!.status).not.toBe("not-run");
    // Evidence is page-attributed:
    expect(byId.get("a11y-img-alt")!.evidence.some((e) => e.page === "flawed.html")).toBe(true);
    // The honest untested list is always present:
    expect(report.untested.length).toBeGreaterThanOrEqual(5);
  });
});
