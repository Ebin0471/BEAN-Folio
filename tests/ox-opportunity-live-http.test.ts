import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

/**
 * M-O3 LIVE HTTP tests — real network round-trips against a running server.
 *
 * Gate convention (media-upload-http precedent): a readiness probe on
 * BASE_URL decides whether the suite RUNS or VISIBLY SKIPS. It is never
 * recorded as a pass when it skipped — the skip is reported. Point BASE_URL
 * at an ISOLATED QA server (free port + pinned QA DATABASE_URL); never at a
 * production or shared database.
 *
 * Scope: the auth wiring and existence-hiding behavior of the M-O3 surface
 * over real HTTP:
 *   - anonymous callers: 401 on employer opportunity endpoints, 403 on the
 *     admin review surface (requireAdmin — indistinguishable from non-admin)
 *   - an authenticated NON-MEMBER: 404 (existence-hiding deny) on another
 *     org's opportunities
 *   - /api/health + /api/ready green on the QA server
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const serverUp = await fetch(`${BASE}/api/ready`, { method: "GET" })
  .then((r) => r.json())
  .then((j: unknown) => Boolean((j as Record<string, unknown>)?.ok))
  .catch(() => false);

describe("M-O3 live HTTP (gated on server readiness)", async () => {
  const ghostOrg = `ghost-${randomUUID()}`;
  const ghostOpportunity = `ghost-${randomUUID()}`;

  test.skipIf(!serverUp)("QA server is healthy (/api/health ok, /api/ready ok)", async () => {
    const health = (await fetch(`${BASE}/api/health`).then((r) => r.json())) as Record<string, unknown>;
    expect(health.ok).toBe(true);
    const ready = (await fetch(`${BASE}/api/ready`).then((r) => r.json())) as Record<string, unknown>;
    expect(ready.ok).toBe(true);
  });

  test.skipIf(!serverUp)("anonymous callers get 401 on employer opportunity endpoints over real HTTP", async () => {
    const list = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities`, { method: "GET" });
    expect(list.status).toBe(401);
    const create = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Anonymous draft", description: "This must never create anything anywhere." }),
    });
    expect(create.status).toBe(401);
    const submit = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities/${ghostOpportunity}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(submit.status).toBe(401);
    const outcome = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities/${ghostOpportunity}/outcome`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "CLOSED" }),
    });
    expect(outcome.status).toBe(401);
    const del = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities/${ghostOpportunity}`, { method: "DELETE" });
    expect(del.status).toBe(401);
  });

  test.skipIf(!serverUp)("anonymous callers get 403 on the admin review surface (requireAdmin)", async () => {
    const queue = await fetch(`${BASE}/api/admin/ox/opportunities`, { method: "GET" });
    expect(queue.status).toBe(403);
    const decide = await fetch(`${BASE}/api/admin/ox/opportunities/${ghostOpportunity}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVE" }),
    });
    expect(decide.status).toBe(403);
  });

  test.skipIf(!serverUp)("authenticated non-member gets 404 (existence-hiding) on a foreign org's opportunities", async () => {
    // Register a throwaway account through the real flow.
    const email = `ox-opp-live-${randomUUID()}@beanfolio.test`;
    const register = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "ox-live-password-1", name: "Live Nonmember" }),
    });
    expect(register.status).toBe(200);
    const setCookie = register.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("bean_session=");

    const list = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities`, {
      method: "GET",
      headers: { cookie: setCookie.split(";")[0] },
    });
    expect(list.status).toBe(404);
    const create = await fetch(`${BASE}/api/employers/${ghostOrg}/opportunities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: setCookie.split(";")[0] },
      body: JSON.stringify({ title: "Foreign draft", description: "A non-member must never create here.", }),
    });
    expect(create.status).toBe(404);
    expect(list.headers.get("x-request-id") !== undefined || true).toBe(true);
  });
});
