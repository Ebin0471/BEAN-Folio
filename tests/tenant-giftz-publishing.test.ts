import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

// M2 QA — GIFTZ tenant publishing + public-surface privacy/isolation
// (isolated QA database via the qa-db-env.sh guard). Covers the spec's
// Part F corrections and Part D integration:
//   - publish responses carry the config-derived tenant address (local
//     preview labelled; honest null without configuration),
//   - the JSON public endpoint enforces the profile-visibility ladder
//     SERVER-SIDE (the pre-existing client-trust gap is closed),
//   - the artifact route enforces owner-active + site-PUBLISHED + visibility
//     + LIVE deployment before serving a byte (defense-in-depth),
//   - self is exempt for PRIVATE owners (no-store — a shared cache can never
//     leak private bytes to the next visitor),
//   - unpublish/rollback semantics revoke serving,
//   - the Portfolio public endpoint enforces the demo ladder member.

const jar = new Map<string, string>();
const realNextHeaders = await import("next/headers");
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
}));

import { db } from "@/lib/db";
import { POST as registerRoute } from "@/app/api/auth/register/route";
import { POST as createSiteRoute } from "@/app/api/giftz/sites/route";
import { PUT as putFileRoute } from "@/app/api/giftz/sites/[id]/files/content/route";
import { POST as buildRoute } from "@/app/api/giftz/sites/[id]/builds/route";
import { POST as publishRoute } from "@/app/api/giftz/sites/[id]/publish/route";
import { POST as unpublishRoute } from "@/app/api/giftz/sites/[id]/unpublish/route";
import { GET as publicSiteRoute } from "@/app/api/giftz/sites/[id]/public/route";
import { GET as publicArtifactRoute } from "@/app/api/giftz/sites/[id]/public/[...path]/route";
import { GET as portfolioGetRoute } from "@/app/api/portfolio/route";
import { GET as siteSlugRoute } from "@/app/api/site/[slug]/route";
import { GET as siteDetailRoute } from "@/app/api/giftz/sites/[id]/route";
import { createSession, hashPassword } from "@/lib/auth";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, opts: { method?: string; json?: unknown } = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
    },
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  });
}

type Json = Record<string, unknown>;
const body = (res: Response): Promise<Json> => res.json() as Promise<Json>;

/** Dynamic-route invocation contexts (the second handler argument). */
const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });
const ctxPath = (id: string, path: string) => ({
  params: Promise.resolve({ id, path: path.split("/").filter(Boolean) }),
});
const ctxSlug = (slug: string) => ({ params: Promise.resolve({ slug }) });

const MINIMAL_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tenant QA Site</title></head>
<body><main><h1 id="hero">Tenant QA</h1><p>Generated for the multi-tenant publishing verification.</p></main></body>
</html>`;

interface TenantFixture {
  userId: string;
  username: string;
  email: string;
}

/** Register (identity-aware contract), claim a username, set visibility — no onboarding needed. */
async function makeTenant(tag: string, opts: { visibility?: string; isDemo?: boolean } = {}): Promise<TenantFixture> {
  const email = `m2-tenant-${tag}-${randomUUID()}@beanfolio.test`;
  const reg = await registerRoute(req("/api/auth/register", { method: "POST", json: { email, password: "m2-tenant-pass-1", name: `Tenant ${tag}`, identity: "CAREER_PROFESSIONAL" } }));
  expect(reg.status).toBe(200);
  const { user } = (await reg.json()) as { user: { id: string } };
  const username = `m2${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await db.user.update({
    where: { id: user.id },
    data: {
      username,
      onboarded: true,
      emailVerifiedAt: new Date(), // automation/gate independence
      profileVisibility: opts.visibility ?? "PUBLIC",
      isDemo: opts.isDemo ?? false,
    },
  });
  return { userId: user.id, username, email };
}

/** Create a GIFTZ site with one valid file, build it, publish it through the REAL route. */
async function publishSite(fx: TenantFixture): Promise<{ siteId: string; publish: Json }> {
  const { defaultConfig } = await import("@/lib/site-config");
  const created = await createSiteRoute(req("/api/giftz/sites", { method: "POST", json: { title: `Tenant QA ${fx.username}` } }));
  expect(created.status).toBe(200);
  const siteId = ((await created.json()) as { site?: { id?: string }; id?: string }).site?.id ?? ((await created.json()) as Json).id as string;
  expect(typeof siteId).toBe("string");
  // Real GIFTZ sites always carry a working config (generation writes it; the
  // compiler syncs it) — publish snapshots publishedConfig from it. A
  // config-less site keeps the legacy JSON route 404 (documented semantics).
  await db.giftzSite.update({
    where: { id: siteId },
    data: { config: JSON.stringify(defaultConfig()) },
  });

  const put = await putFileRoute(req(`/api/giftz/sites/${siteId}/files/content`, {
    method: "PUT",
    json: { path: "index.html", content: MINIMAL_PAGE, encoding: "utf8" },
  }), ctxId(siteId));
  expect(put.status).toBe(200);

  const buildRes = await buildRoute(req(`/api/giftz/sites/${siteId}/builds`, { method: "POST", json: { trigger: "manual" } }), ctxId(siteId));
  expect(buildRes.status).toBe(200);
  const buildBody = await body(buildRes);
  expect(buildBody.build && (buildBody.build as Json).status).toBe("SUCCEEDED");

  const publish = await publishRoute(req(`/api/giftz/sites/${siteId}/publish`, { method: "POST", json: {} }), ctxId(siteId));
  expect(publish.status).toBe(200);
  return { siteId, publish: await body(publish) };
}

async function cleanupTenant(fx: TenantFixture) {
  await db.user.delete({ where: { id: fx.userId } }).catch(() => undefined);
}

// ------------------------------------------------------------------ publish responses

describe("M2 publish responses carry the config-derived tenant address", () => {
  test("local-dev: tenantUrl is the labelled local preview (username.localhost:3000/g/<siteId>)", async () => {
    const fx = await makeTenant("pub");
    const { siteId, publish } = await publishSite(fx);
    expect(publish.publicPath).toBe(`/site/${fx.username}/g/${siteId}`);
    expect(publish.tenantUrl).toBe(`http://${fx.username}.localhost:3000/g/${siteId}`);
    expect(publish.tenantUrlKind).toBe("local-preview");
    expect(publish.tenantUrlUnavailable).toBeNull();
    // The deployment is genuinely LIVE and the artifact is the successful build.
    expect((publish.deployment as Json).status).toBe("LIVE");
    const live = await db.giftzDeployment.findFirst({ where: { siteId, status: "LIVE" } });
    expect(live?.url).toBe(`/site/${fx.username}/g/${siteId}`);
    // The legacy path-form URL keeps working (constructable from the response).
    expect(typeof publish.canonicalUrl === "string" || publish.canonicalUrl === null).toBe(true);
    await cleanupTenant(fx);
  });

  test("production without a configured root: tenantUrl is honest null + explanation (never a fabricated domain)", async () => {
    const original = process.env.NODE_ENV;
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    try {
      delete process.env.BEANFOLIO_ROOT_DOMAIN;
      const fx = await makeTenant("pubnc");
      const { publish } = await publishSite(fx);
      expect(publish.tenantUrl).toBeNull();
      expect(publish.tenantUrlKind).toBeNull();
      const un = publish.tenantUrlUnavailable as Json;
      expect(un.reason).toBe("not-configured");
      expect(String(un.message)).toContain("BEANFOLIO_ROOT_DOMAIN");
      await cleanupTenant(fx);
    } finally {
      (process.env as { NODE_ENV?: string }).NODE_ENV = original;
    }
  });
});

// ------------------------------------------------------------------ privacy ladder (spec Part F fix)

describe("M2 public GIFTZ endpoints enforce the privacy ladder server-side", () => {
  test("PUBLIC owner: anonymous visitors receive the published site JSON + LIVE artifact", async () => {
    const fx = await makeTenant("pubserve");
    const { siteId } = await publishSite(fx);
    jar.delete("bean_session"); // anonymous
    const json = await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId));
    expect(json.status).toBe(200);
    const jsonBody = await body(json);
    expect((jsonBody.owner as Json).username).toBe(fx.username);
    expect((jsonBody.deployment as Json)?.id).toBeTruthy();
    const artifact = await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"));
    expect(artifact.status).toBe(200);
    const text = await artifact.text();
    expect(text).toContain("Tenant QA Site");
    expect(artifact.headers.get("cache-control")).toBe("public, max-age=60");
    expect(artifact.headers.get("x-content-type-options")).toBe("nosniff");
    expect(artifact.headers.get("content-security-policy")).toContain("connect-src 'none'");
    await cleanupTenant(fx);
  });

  test("PRIVATE owner: anonymous callers get a non-revealing 404 on BOTH endpoints (regression for the pre-existing client-trust gap)", async () => {
    const fx = await makeTenant("priv", { visibility: "PRIVATE" });
    const { siteId } = await publishSite(fx);
    jar.delete("bean_session"); // anonymous
    const json = await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId));
    expect(json.status).toBe(404);
    const jsonBody = await body(json);
    // Non-revealing: the miss is indistinguishable from any other 404.
    expect(JSON.stringify(jsonBody).toLowerCase().includes("private")).toBe(false);
    const artifact = await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"));
    expect(artifact.status).toBe(404);
    const artifactBody = await artifact.text();
    expect(artifactBody.toLowerCase().includes("private")).toBe(false);
    await cleanupTenant(fx);
  });

  test("PRIVATE owner's OWN session still serves (self exception) — with private,no-store so a shared cache can never leak", async () => {
    const fx = await makeTenant("privself", { visibility: "PRIVATE" });
    const { siteId } = await publishSite(fx);
    // The publish route left the owner's cookie in the jar.
    const json = await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId));
    expect(json.status).toBe(200);
    expect(json.headers.get("cache-control")).toBe("private, no-store");
    const artifact = await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"));
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("cache-control")).toBe("private, no-store");
    await cleanupTenant(fx);
  });

  test("DEMO owner: anonymous callers are 404 on both endpoints (ladder parity)", async () => {
    const fx = await makeTenant("demo", { isDemo: true });
    const { siteId } = await publishSite(fx);
    jar.delete("bean_session");
    expect((await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId))).status).toBe(404);
    expect((await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"))).status).toBe(404);
    await cleanupTenant(fx);
  });

  test("a site that is NOT PUBLISHED anymore never serves, even with a lingering LIVE deployment (defense-in-depth)", async () => {
    const fx = await makeTenant("unpub");
    const { siteId } = await publishSite(fx);
    // Simulate a legacy inconsistency: status flipped back while the LIVE row remains.
    await db.giftzSite.update({ where: { id: siteId }, data: { status: "DRAFT" } });
    const liveCount = await db.giftzDeployment.count({ where: { siteId, status: "LIVE" } });
    expect(liveCount).toBeGreaterThan(0); // the defense-in-depth precondition
    jar.delete("bean_session");
    const json = await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId));
    expect(json.status).toBe(404);
    const artifact = await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"));
    expect(artifact.status).toBe(404);
    await cleanupTenant(fx);
  });

  test("soft-DELETED owners never serve (rows are kept, access is not)", async () => {
    const fx = await makeTenant("deleted");
    const { siteId } = await publishSite(fx);
    await db.user.update({ where: { id: fx.userId }, data: { deletedAt: new Date() } });
    jar.delete("bean_session");
    expect((await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId))).status).toBe(404);
    expect((await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"))).status).toBe(404);
    await db.user.delete({ where: { id: fx.userId } }).catch(() => undefined);
  });

  test("UNPUBLISH revokes serving for anonymous visitors (and keeps the draft)", async () => {
    const fx = await makeTenant("unpubflow");
    const { siteId } = await publishSite(fx);
    const un = await unpublishRoute(req(`/api/giftz/sites/${siteId}/unpublish`, { method: "POST", json: {} }), ctxId(siteId));
    expect(un.status).toBe(200);
    jar.delete("bean_session");
    expect((await publicSiteRoute(req(`/api/giftz/sites/${siteId}/public`), ctxId(siteId))).status).toBe(404);
    expect((await publicArtifactRoute(req(`/api/giftz/sites/${siteId}/public/index.html`), ctxPath(siteId, "index.html"))).status).toBe(404);
    // Draft is kept (existing unpublish contract preserved).
    const site = await db.giftzSite.findUnique({ where: { id: siteId } });
    expect(site?.status).toBe("DRAFT");
    expect(site?.deployStatus).toBe("DRAFT");
    const files = await db.giftzProjectFile.count({ where: { siteId } });
    expect(files).toBeGreaterThan(0);
    await cleanupTenant(fx);
  });
});

// ------------------------------------------------------------------ tenant isolation

describe("M2 tenant isolation — site ownership is server-enforced", () => {
  test("tenant A cannot publish/unpublish/serve-manage tenant B's site; changing the site id never bypasses ownership", async () => {
    const a = await makeTenant("iso-a");
    const b = await makeTenant("iso-b");
    const { siteId } = await publishSite(b);

    // B's cookie is in the jar — swap to A.
    const loginA = await registerRoute(req("/api/auth/register", { method: "POST", json: { email: `m2-iso-a2-${randomUUID()}@beanfolio.test`, password: "m2-tenant-pass-1", name: "Iso A2", identity: "CAREER_PROFESSIONAL" } }));
    const { user: aUser } = (await loginA.json()) as { user: { id: string } };
    const sessionA = await createSession(aUser.id);
    jar.set("bean_session", sessionA);

    // A reads B's site detail → 404; publishes/unpublishes it → 404.
    expect((await siteDetailRoute(req(`/api/giftz/sites/${siteId}`), ctxId(siteId))).status).toBe(404);
    expect((await publishRoute(req(`/api/giftz/sites/${siteId}/publish`, { method: "POST", json: {} }), ctxId(siteId))).status).toBe(404);
    expect((await unpublishRoute(req(`/api/giftz/sites/${siteId}/unpublish`, { method: "POST", json: {} }), ctxId(siteId))).status).toBe(404);
    // A cannot write B's project files.
    const put = await putFileRoute(req(`/api/giftz/sites/${siteId}/files/content`, {
      method: "PUT",
      json: { path: "index.html", content: "<html lang='en'><body>hacked</body></html>", encoding: "utf8" },
    }), ctxId(siteId));
    expect(put.status).toBe(404);
    // B's artifact is untouched.
    const file = await db.giftzProjectFile.findFirst({ where: { siteId, path: "index.html" } });
    expect(file?.content).toContain("Tenant QA");

    await db.user.delete({ where: { id: aUser.id } }).catch(() => undefined);
    await cleanupTenant(a);
    await cleanupTenant(b);
  });
});

// ------------------------------------------------------------------ Portfolio ladder parity

describe("M2 Portfolio public endpoint enforces the demo ladder member", () => {
  test("demo owner's published portfolio is 404 for anonymous visitors; non-demo serves", async () => {
    // Non-demo first (control).
    const fx = await makeTenant("pfctl");
    const seeded = await portfolioGetRoute();
    expect(seeded.status).toBe(200);
    const { portfolio, config } = (await seeded.json()) as { portfolio: Json; config: Json };
    await db.portfolio.update({
      where: { id: String(portfolio.id) },
      data: { published: JSON.stringify(config), publishedAt: new Date() },
    });
    jar.delete("bean_session");
    const control = await siteSlugRoute(req(`/api/site/${fx.username}`), ctxSlug(fx.username));
    expect(control.status).toBe(200);
    await cleanupTenant(fx);

    // Demo owner: same state, anonymous visitor → 404 (self still sees it).
    const demo = await makeTenant("pdemo", { isDemo: true });
    const seededDemo = await portfolioGetRoute();
    expect(seededDemo.status).toBe(200);
    const { portfolio: p2, config: c2 } = (await seededDemo.json()) as { portfolio: Json; config: Json };
    await db.portfolio.update({
      where: { id: String(p2.id) },
      data: { published: JSON.stringify(c2), publishedAt: new Date() },
    });
    jar.delete("bean_session");
    expect((await siteSlugRoute(req(`/api/site/${demo.username}`), ctxSlug(demo.username))).status).toBe(404);
    // Self keeps access (isSelf bypasses the demo member).
    jar.set("bean_session", await createSession(demo.userId));
    const selfRes = await siteSlugRoute(req(`/api/site/${demo.username}`), ctxSlug(demo.username));
    expect(selfRes.status).toBe(200);
    const selfBody = await body(selfRes);
    expect(selfBody.isSelf).toBe(true);
    await cleanupTenant(demo);
  });
});
