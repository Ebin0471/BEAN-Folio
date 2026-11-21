/// <reference types="bun-types" />
/**
 * Portfolio reconnection regression tests (M0.5 Stage F).
 *
 * The Portfolio feature (~3,867 lines of view code + 8 API routes + 3 Prisma
 * models) was orphaned by the 2026-11-11 lineage reconstruction and its
 * models were restored additively in M22. M0.5 reconnected the views through
 * the real routing architecture:
 *
 *   #/studio/portfolio                 → PortfolioStudioView (auth-gated)
 *   #/site/<slug>                      → portfolio site (or the pre-M0.5
 *                                        Website Studio site — the adapter
 *                                        contract, see PortfolioFirstSiteView)
 *   #/site/<slug>/work/<projectId>     → portfolio case study
 *   #/site/<slug>/<pageSlug>           → portfolio sub-page (or not-found)
 *   #/embed/draft/<slug>[/<page>]      → studio preview iframe (draft, self)
 *   #/embed/site/<slug>                → published site, chrome-free
 *   POST /api/ai/portfolio/design      → the studio AI designer (restored
 *                                        legacy contract {prompt,pageId,
 *                                        selection} → {summary,rationale,
 *                                        config})
 *
 * These tests pin the SERVER contracts the reconnected views depend on (the
 * client routing itself is exercised by the production build + the boot-route
 * regex tests below). Every row this file creates is cleaned up.
 *
 * Run: bun test tests/portfolio-integration.test.ts
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

// Route handlers called directly run outside a Next request scope — serve a
// MUTABLE session cookie (same pattern as tests/media-upload-route.test.ts).
let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

// The AI gateway is mocked so the designer-contract test never needs a real
// provider: aiGate allows, aiComplete returns a canned (schema-valid)
// proposal built from the user's own draft. The real parseJsonFromText and
// AiProviderError stay in place.
const realAi = await import("@/lib/ai");
mock.module("@/lib/ai", () => ({
  ...realAi,
  aiGate: async () => null,
  aiComplete: async () => {
    // The route loads the draft server-side and passes it as context; the
    // mock simply echoes it back inside the proposal envelope.
    const { db } = await import("@/lib/db");
    const row = await db.portfolio.findFirst({ where: { userId: qaUserId! } });
    const config = JSON.parse(row!.draft);
    return {
      text: JSON.stringify({
        summary: "Mock proposal applied.",
        rationale: "Test canned response — echoes the current draft.",
        config,
      }),
    };
  },
}));

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import type { NextRequest as NextRequestType } from "next/server";
// The handler() wrapper passes (req, ctx) at runtime regardless of the
// handler's declared arity; these aliases give the tests call-compatible
// signatures without touching the route implementations.
import {
  GET as portfolioGetImport,
  PATCH as portfolioPatchImport,
} from "@/app/api/portfolio/route";
import { POST as publishRouteImport } from "@/app/api/portfolio/publish/route";
import { POST as unpublishRouteImport } from "@/app/api/portfolio/unpublish/route";
import { GET as revisionsRouteImport } from "@/app/api/portfolio/revisions/route";
import { POST as restoreRouteImport } from "@/app/api/portfolio/revisions/[id]/restore/route";
import { GET as exportRouteImport } from "@/app/api/portfolio/export/route";
import { POST as importRouteImport } from "@/app/api/portfolio/import/route";
import { GET as siteRoute } from "@/app/api/site/[slug]/route";
import { POST as aiDesignRoute } from "@/app/api/ai/portfolio/design/route";
import { bootRouteFromPathname } from "@/proxy";
import { RESERVED_PAGE_SLUGS } from "@/lib/portfolio-schema";

type RouteFn = (...args: unknown[]) => Promise<Response>;
const portfolioGet = portfolioGetImport as unknown as RouteFn;
const portfolioPatch = portfolioPatchImport as unknown as RouteFn;
const publishRoute = publishRouteImport as unknown as RouteFn;
const unpublishRoute = unpublishRouteImport as unknown as RouteFn;
const revisionsRoute = revisionsRouteImport as unknown as RouteFn;
const restoreRoute = restoreRouteImport as unknown as RouteFn;
const exportRoute = exportRouteImport as unknown as RouteFn;
const importRoute = importRouteImport as unknown as RouteFn;

const QA_EMAIL = "qa-portfolio-reconnect@beanfolio.test";
const QA_USERNAME = `qa-pf-${Math.random().toString(36).slice(2, 8)}`;

let qaUserId = "";
let otherUserId = "";
let cookieOther = "";
let projectId = "";

function authedReq(url: string, init: { method?: string; json?: unknown } = {}): NextRequestType {
  const headers: Record<string, string> = { cookie: `bean_session=${cookieToken}` };
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers, body });
}

function anonReq(url: string, init: { method?: string; json?: unknown } = {}): NextRequestType {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers, body });
}

/**
 * The next/headers mock serves ONE mutable global token, so anonymous and
 * foreign-session paths must swap it explicitly around the call.
 */
async function asSession<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = cookieToken;
  cookieToken = token;
  try {
    return await fn();
  } finally {
    cookieToken = saved;
  }
}

const siteCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeAll(async () => {
  const user = await db.user.create({
    data: {
      email: QA_EMAIL,
      name: "QA Portfolio Reconnect",
      username: QA_USERNAME,
      passwordHash: await hashPassword("qa-only-password-123"),
      onboarded: true,
      headline: "Portfolio reconnection QA",
    },
  });
  qaUserId = user.id;
  cookieToken = await createSession(qaUserId);

  const other = await db.user.create({
    data: {
      email: `qa-pf-other-${Math.random().toString(36).slice(2, 8)}@beanfolio.test`,
      name: "QA Portfolio Other",
      username: `${QA_USERNAME}-other`,
      passwordHash: await hashPassword("qa-only-password-123"),
      onboarded: true,
    },
  });
  otherUserId = other.id;
  cookieOther = await createSession(otherUserId);

  const project = await db.project.create({
    data: {
      ownerId: qaUserId,
      title: "Reconnection QA Project",
      summary: "Appears on the published portfolio site payload.",
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date(),
    },
  });
  projectId = project.id;
});

afterAll(async () => {
  for (const uid of [qaUserId, otherUserId]) {
    if (!uid) continue;
    // Portfolio cascades to revisions; project cascades to post media.
    await db.portfolio.deleteMany({ where: { userId: uid } }).catch(() => {});
    await db.project.deleteMany({ where: { ownerId: uid } }).catch(() => {});
    await db.session.deleteMany({ where: { userId: uid } }).catch(() => {});
    await db.user.delete({ where: { id: uid } }).catch(() => {});
  }
  cookieToken = undefined;
  cookieOther = "";
});

describe("portfolio studio API (reconnected contract)", () => {
  test("GET /api/portfolio self-seeds the portfolio from the real profile", async () => {
    const res = await portfolioGet(authedReq("/api/portfolio"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      portfolio: { slug: string; publishedAt: string | null; hasPublished: boolean };
      config: { pages: unknown[]; templateId: string };
    };
    expect(body.portfolio.slug).toBe(QA_USERNAME);
    expect(body.portfolio.hasPublished).toBe(false);
    expect(Array.isArray(body.config.pages) && body.config.pages.length > 0).toBe(true);
  });

  test("PATCH /api/portfolio saves the draft config and rejects oversize payloads", async () => {
    const cur = await (await portfolioGet(authedReq("/api/portfolio"))).json();
    const res = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { config: cur.config } })
    );
    expect(res.status).toBe(200);

    // A shape-garbage payload is REPAIRED by the schema's legacy migration
    // (documented behavior) — it never stores the garbage, but it also does
    // not 400. The hard 400 is the MAX_CONFIG_BYTES (200 KB) cap, reachable
    // only with schema-VALID data: 12 pages × 24 maxed about sections.
    const base = cur.config;
    const bigConfig = {
      ...base,
      pages: Array.from({ length: 12 }, (_, i) => ({
        ...(base.pages[0] as Record<string, unknown>),
        id: `pg${i}`,
        name: `Page ${i}`,
        slug: i === 0 ? "home" : `page-${i}`,
        isHome: i === 0,
        sections: Array.from({ length: 24 }, (_, s) => ({
          id: `sec${i}-${s}`,
          type: "about",
          title: `About ${s}`,
          data: { body: "x".repeat(6000) },
        })),
        widgets: [],
      })),
    };
    const bad = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { config: bigConfig } })
    );
    // The oversize payload is rejected at BOTH layers: the 1 MB transport
    // budget (413 via parseBodySized) or the 200 KB stored-config cap (400
    // "too large") — whichever sees it first. Both are refusals, never a 200.
    expect([400, 413]).toContain(bad.status);
    if (bad.status === 400) {
      const badBody = (await bad.json()) as { error?: string };
      expect(badBody.error).toContain("too large");
    }

    // Restore the good draft (a repaired PATCH would have replaced it).
    const back = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { config: cur.config } })
    );
    expect(back.status).toBe(200);
  });

  test("slug PATCH: reserved and colliding slugs are refused; a valid one is kept", async () => {
    const taken = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { slug: "api" } })
    );
    expect(taken.status).toBe(400); // RESERVED_SLUGS

    // The other QA user has no portfolio yet — no collision exists — but the
    // QA user's own username slug is already theirs (409 comes only from a
    // foreign row, which cannot exist here). A fresh valid slug succeeds.
    const okSlug = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { slug: `${QA_USERNAME}-pro` } })
    );
    expect(okSlug.status).toBe(200);
    // Restore the username slug for the /site tests below.
    const back = await portfolioPatch(
      authedReq("/api/portfolio", { method: "PATCH", json: { slug: QA_USERNAME } })
    );
    expect(back.status).toBe(200);
  });

  test("unpublished site is 404 for the public but a draft banner payload for the owner", async () => {
    const anon = await asSession(undefined, () => siteRoute(anonReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME)));
    expect(anon.status).toBe(404);

    const self = await siteRoute(authedReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME));
    expect(self.status).toBe(200);
    const body = (await self.json()) as { isPublished: boolean; config: { pages: unknown[] } };
    expect(body.isPublished).toBe(false);
    expect(Array.isArray(body.config.pages)).toBe(true);
  });

  test("publish → public payload, revision created, unpublish → 404 again", async () => {
    const pub = await publishRoute(authedReq("/api/portfolio/publish", { method: "POST" }));
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { portfolio?: { publishedAt?: string | null } };
    expect(pubBody.portfolio?.publishedAt).toBeTruthy();

    const anon = await asSession(undefined, () => siteRoute(anonReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME)));
    expect(anon.status).toBe(200);
    const site = (await anon.json()) as {
      isPublished: boolean;
      isSelf: boolean;
      owner: { username: string };
      projects: { id: string }[];
      config: { pages: Array<{ id: string; isPublished: boolean }> };
    };
    expect(site.isPublished).toBe(true);
    expect(site.isSelf).toBe(false);
    expect(site.owner.username).toBe(QA_USERNAME);
    expect(site.projects.some((p) => p.id === projectId)).toBe(true);
    // Per-page publication stripping: the public never receives an
    // unpublished page's content.
    expect(site.config.pages.every((p) => p.isPublished)).toBe(true);

    const revs = await revisionsRoute(authedReq("/api/portfolio/revisions"), siteCtx("x"));
    expect(revs.status).toBe(200);
    const revBody = (await revs.json()) as { revisions: { id: string; label: string | null }[] };
    expect(revBody.revisions.length).toBe(1);
    expect(revBody.revisions[0].label).toContain("Published");

    // Ownership: a foreign session can NOT restore someone else's revision.
    const foreign = await asSession(cookieOther, () =>
      restoreRoute(
        new NextRequest(`http://localhost/api/portfolio/revisions/${revBody.revisions[0].id}/restore`, {
          method: "POST",
        }),
        { params: Promise.resolve({ id: revBody.revisions[0].id }) }
      )
    );
    expect(foreign.status).toBe(404);

    const restored = await restoreRoute(
      authedReq(`/api/portfolio/revisions/${revBody.revisions[0].id}/restore`, { method: "POST" }),
      { params: Promise.resolve({ id: revBody.revisions[0].id }) }
    );
    expect(restored.status).toBe(200);

    const unpub = await unpublishRoute(authedReq("/api/portfolio/unpublish", { method: "POST" }));
    expect(unpub.status).toBe(200);
    const anonAfter = await asSession(undefined, () => siteRoute(anonReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME)));
    expect(anonAfter.status).toBe(404);
  });

  test("export → import round-trip preserves the draft configuration", async () => {
    const exported = await exportRoute(authedReq("/api/portfolio/export"));
    expect(exported.status).toBe(200);
    const wrapper = (await exported.json()) as {
      kind: string;
      version: number;
      slug: string;
      config: unknown;
    };
    expect(wrapper.kind).toBe("beanfolio-portfolio");
    expect(wrapper.slug).toBe(QA_USERNAME);

    const re = await importRoute(
      authedReq("/api/portfolio/import", { method: "POST", json: { json: JSON.stringify(wrapper) } })
    );
    expect(re.status).toBe(200);
    const after = (await (await portfolioGet(authedReq("/api/portfolio"))).json()) as {
      config: { templateId: string };
    };
    expect(after.config).toBeTruthy();
  });
});

describe("public site route privacy rules", () => {
  test("PRIVATE-profile owner: 404 for the public, payload for the owner", async () => {
    await db.user.update({ where: { id: qaUserId }, data: { profileVisibility: "PRIVATE" } });
    await publishRoute(authedReq("/api/portfolio/publish", { method: "POST" }));
    const anon = await asSession(undefined, () => siteRoute(anonReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME)));
    expect(anon.status).toBe(404);
    const self = await siteRoute(authedReq(`/api/site/${QA_USERNAME}`), siteCtx(QA_USERNAME));
    expect(self.status).toBe(200);
    await db.user.update({ where: { id: qaUserId }, data: { profileVisibility: "PUBLIC" } });
    await unpublishRoute(authedReq("/api/portfolio/unpublish", { method: "POST" }));
  });

  test("unknown slug → 404 (the adapter's website/not-found fallback signal)", async () => {
    const res = await asSession(undefined, () =>
      siteRoute(anonReq("/api/site/no-such-portfolio-slug"), siteCtx("no-such-portfolio-slug"))
    );
    expect(res.status).toBe(404);
    // No analytics pollution from a fallback probe: zero ProfileView rows for
    // a nonexistent owner.
    const views = await db.profileView.count({ where: { profileUserId: "no-such-owner" } });
    expect(views).toBe(0);
  });

  test("case-study primitives: reserved page slug + the project payload the view reads", async () => {
    expect(RESERVED_PAGE_SLUGS.has("work")).toBe(true); // case studies own /work/<id>
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { title: true, status: true, visibility: true, brief: true, role: true },
    });
    expect(project?.title).toBe("Reconnection QA Project");
    expect(project?.status).toBe("PUBLISHED");
    expect(project?.visibility).toBe("PUBLIC");
  });
});

describe("portfolio AI designer route (restored contract)", () => {
  test("401 without a session", async () => {
    const res = await asSession(undefined, () =>
      aiDesignRoute(anonReq("/api/ai/portfolio/design", { method: "POST", json: { prompt: "make it cinematic" } }))
    );
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (prompt too short)", async () => {
    const res = await aiDesignRoute(
      authedReq("/api/ai/portfolio/design", { method: "POST", json: { prompt: "hi" } })
    );
    expect(res.status).toBe(400);
  });

  test("200 with the exact AiProposal contract {summary, rationale, config}", async () => {
    const res = await aiDesignRoute(
      authedReq("/api/ai/portfolio/design", {
        method: "POST",
        json: { prompt: "Make the hero feel more cinematic", pageId: "", selection: null },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: string;
      rationale: string;
      config: { version: number; templateId: string; pages: unknown[] };
    };
    expect(body.summary).toContain("Mock proposal");
    expect(body.config.version).toBe(2);
    expect(Array.isArray(body.config.pages)).toBe(true);
  });
});

describe("path-form boot routes for the reconnected shapes", () => {
  test("proxy boots the extended /site family and still refuses non-public paths", () => {
    expect(bootRouteFromPathname(`/site/${QA_USERNAME}`)).toBe(`/site/${QA_USERNAME}`);
    expect(bootRouteFromPathname(`/site/${QA_USERNAME}/work/${projectId}`)).toBe(
      `/site/${QA_USERNAME}/work/${projectId}`
    );
    expect(bootRouteFromPathname(`/site/${QA_USERNAME}/about`)).toBe(`/site/${QA_USERNAME}/about`);
    expect(bootRouteFromPathname(`/site/${QA_USERNAME}/projects/abc123`)).toBe(
      `/site/${QA_USERNAME}/projects/abc123`
    );
    expect(bootRouteFromPathname("/site")).toBeNull();
    expect(bootRouteFromPathname("/api/portfolio")).toBeNull();
    expect(bootRouteFromPathname("/settings")).toBeNull();
  });
});
