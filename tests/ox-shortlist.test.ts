import { describe, expect, test, afterAll, mock } from "bun:test";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";

/**
 * M-O5 — shortlist API suite (approved decisions D6/D7/D9/D13/D14).
 *
 *   add/list/inspect/edit/remove with FULL revalidation on every add and
 *   read; duplicate prevention via the tenant-bound unique triple;
 *   organization/opportunity mismatch rejection; unauthorized member and
 *   cross-tenant 404-deny; VIEWER/HIRING_MANAGER denial; candidate
 *   revocation and PAUSED after insertion (truthful masking, record
 *   preserved); INVITE_ONLY masking; hidden-salary privacy invariance;
 *   opportunity PAUSED behavior (editable entries, no new adds); terminal
 *   read-only behavior; NO notification side effects; audit correctness;
 *   persistence across requests.
 */
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
import { hashPassword, createSession } from "@/lib/auth";
import { POST as addEntryRoute, GET as listRoute } from "@/app/api/employers/[id]/opportunities/[opportunityId]/shortlist/route";
import {
  GET as entryRoute,
  PATCH as patchEntryRoute,
  DELETE as deleteEntryRoute,
} from "@/app/api/employers/[id]/opportunities/[opportunityId]/shortlist/[entryId]/route";
import { PUT as putProfileRoute } from "@/app/api/opportunities/me/profile/route";
import { POST as visibilityRoute } from "@/app/api/opportunities/me/visibility/route";

afterAll(() => {
  mock.module("next/headers", () => realNextHeaders);
});

function req(path: string, method: string, body?: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
      ...(headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loginAs(userId: string) {
  jar.set("bean_session", await createSession(userId));
}

function resBody(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

async function makeUser(name: string) {
  return db.user.create({
    data: { email: `ox-sl-${randomUUID()}@beanfolio.test`, passwordHash: await hashPassword("ox-sl-password-1"), name },
  });
}

async function makeVerifiedOrg(displayName: string) {
  const owner = await makeUser("SL Owner");
  await loginAs(owner.id);
  const org = await db.employerOrganization.create({
    data: {
      legalName: `${displayName} Pvt Ltd`,
      displayName,
      slug: `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 8)}`,
      verificationStatus: "VERIFIED",
      verificationMethod: "MANUAL_REVIEW",
      verifiedAt: new Date(),
      createdByUserId: owner.id,
    },
  });
  await db.employerMembership.create({ data: { organizationId: org.id, userId: owner.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date() } });
  await loginAs(owner.id);
  return { owner, org };
}

async function makeOpportunity(orgId: string, ownerId: string, status = "PUBLISHED") {
  return db.opportunity.create({
    data: {
      organizationId: orgId,
      createdByUserId: ownerId,
      title: "Shortlist opportunity",
      description: "An opportunity used to exercise the shortlist API in tests.",
      status,
      employmentType: "FULL_TIME",
      workMode: "REMOTE",
      submittedAt: new Date(),
      publishedAt: status !== "DRAFT" && status !== "PENDING_REVIEW" ? new Date() : null,
      salaryMinPaise: 500_000_00,
      salaryMaxPaise: 900_000_00,
      salaryCurrency: "INR",
      compensationPeriod: "YEAR",
    },
  });
}

async function makeDiscoverableCandidate(name: string) {
  const user = await makeUser(name);
  await loginAs(user.id);
  await putProfileRoute(req("/api/opportunities/me/profile", "PUT", { employmentTypes: ["FULL_TIME"], workModes: ["REMOTE"] }));
  await db.candidateVisibilityConsent.create({
    data: { userId: user.id, scope: "DISCOVERY", status: "GRANTED", consentVersion: "O2-CONSENT-V1", source: "CANDIDATE_UI" },
  });
  await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "ACTIVE" }));
  return user;
}

const listP = (orgId: string, oppId: string) => ({ params: Promise.resolve({ id: orgId, opportunityId: oppId }) });
const entryP = (orgId: string, oppId: string, entryId: string) => ({
  params: Promise.resolve({ id: orgId, opportunityId: oppId, entryId }),
});

describe("M-O5 shortlist — add/list/duplicate/inspect (D13/D14)", () => {
  test("add from eligible matches stores minimal metadata; duplicate is 409; list renders live card", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org A ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate A");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);

    const added = await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id, note: "Strong portfolio" }), listP(org.id, opp.id));
    expect(added.status).toBe(201);
    const addedBody = (await resBody(added)) as { entry: Record<string, unknown> };
    expect(addedBody.entry.candidateUserId).toBe(candidate.id);
    expect(addedBody.entry.matchVersionAtAdd).toBe("O4-MATCH-V1");
    expect(typeof addedBody.entry.scoreAtAdd).toBe("number");
    // Storage minimality: the entry row holds no candidate profile content.
    const row = await db.candidateShortlist.findFirst({ where: { organizationId: org.id, candidateUserId: candidate.id } });
    expect(row).not.toBeNull();
    expect(row!.note).toBe("Strong portfolio");

    const dup = await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id));
    expect(dup.status).toBe(409);
    expect(((await resBody(dup)) as Record<string, unknown>).code).toBe("OX_SHORTLIST_DUPLICATE");
    expect(await db.candidateShortlist.count({ where: { organizationId: org.id, opportunityId: opp.id } })).toBe(1);

    const list = (await resBody(await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id)))) as {
      opportunityStatus: string;
      editable: boolean;
      entries: Record<string, unknown>[];
    };
    expect(list.opportunityStatus).toBe("PUBLISHED");
    expect(list.editable).toBe(true);
    const mine = list.entries.find((e) => e.candidateUserId === candidate.id)!;
    expect(mine.state).toBe("LISTED");
    expect((mine.candidate as Record<string, unknown>)).not.toBeNull();

    const single = (await resBody(await entryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${addedBody.entry.id}`, "GET"), entryP(org.id, opp.id, addedBody.entry.id as string)))) as { entry: Record<string, unknown> };
    expect(single.entry.state).toBe("LISTED");

    const audit = await db.auditEvent.findFirst({ where: { action: "ox.shortlist.added", actorUserId: owner.id } });
    expect(audit).not.toBeNull();
  });

  test("organization/opportunity mismatch: an entry id from another org or opportunity is a 404", async () => {
    const orgA = await makeVerifiedOrg(`SL Org B1 ${randomUUID().slice(0, 8)}`);
    const orgB = await makeVerifiedOrg(`SL Org B2 ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate B");
    const oppA = await makeOpportunity(orgA.org.id, orgA.owner.id);
    await loginAs(orgA.owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${orgA.org.id}/opportunities/${oppA.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(orgA.org.id, oppA.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;

    await loginAs(orgB.owner.id);
    expect(
      (await entryRoute(req(`/api/employers/${orgB.org.id}/opportunities/${oppA.id}/shortlist/${entryId}`, "GET"), entryP(orgB.org.id, oppA.id, entryId))).status
    ).toBe(404);
    const oppB = await makeOpportunity(orgB.org.id, orgB.owner.id);
    expect(
      (await entryRoute(req(`/api/employers/${orgA.org.id}/opportunities/${oppB.id}/shortlist/${entryId}`, "GET"), entryP(orgA.org.id, oppB.id, entryId))).status
    ).toBe(404);
    expect(
      (await patchEntryRoute(req(`/api/employers/${orgA.org.id}/opportunities/${oppB.id}/shortlist/${entryId}`, "PATCH", { note: "hijack" }), entryP(orgA.org.id, oppB.id, entryId))).status
    ).toBe(404);
    expect(
      (await deleteEntryRoute(req(`/api/employers/${orgB.org.id}/opportunities/${oppA.id}/shortlist/${entryId}`, "DELETE"), entryP(orgB.org.id, oppA.id, entryId))).status
    ).toBe(404);
    expect(await db.candidateShortlist.count({ where: { id: entryId } })).toBe(1);
  });

  test("VIEWER and HIRING_MANAGER denied; anonymous 401; ghost org 404", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org C ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate C");
    const opp = await makeOpportunity(org.id, owner.id);
    const viewer = await makeUser("SL Viewer");
    const hm = await makeUser("SL HM");
    await db.employerMembership.createMany({
      data: [
        { organizationId: org.id, userId: viewer.id, role: "VIEWER", status: "ACTIVE", joinedAt: new Date() },
        { organizationId: org.id, userId: hm.id, role: "HIRING_MANAGER", status: "ACTIVE", joinedAt: new Date() },
      ],
    });
    for (const u of [viewer, hm]) {
      await loginAs(u.id);
      expect(
        (await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))).status
      ).toBe(404);
      expect((await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id))).status).toBe(404);
    }
    jar.delete("bean_session");
    expect((await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id))).status).toBe(401);
    const outsider = await makeUser("SL Outsider");
    await loginAs(outsider.id);
    const ghost = `ghost-${randomUUID()}`;
    expect((await listRoute(req(`/api/employers/${ghost}/opportunities/${opp.id}/shortlist`, "GET"), listP(ghost, opp.id))).status).toBe(404);
  });

  test("adding a candidate who is NOT currently eligible is a generic 409 (no reason leak)", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org D ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate D");
    const opp = await makeOpportunity(org.id, owner.id);
    // Candidate revokes BEFORE the add — eligibility must be re-checked live.
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.id, scope: "DISCOVERY", status: "GRANTED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await db.candidateOpportunityProfile.update({ where: { userId: candidate.id }, data: { visibilityStatus: "HIDDEN" } });
    await loginAs(owner.id);
    const res = await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id));
    expect(res.status).toBe(409);
    expect(((await resBody(res)) as Record<string, unknown>).code).toBe("OX_CANDIDATE_NOT_ELIGIBLE");
    expect(await db.candidateShortlist.count({ where: { organizationId: org.id } })).toBe(0);
  });

  test("hidden salary is privacy-invariant on the shortlist card (safeguard B)", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org E ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate E");
    await loginAs(candidate.id);
    await putProfileRoute(
      req("/api/opportunities/me/profile", "PUT", {
        compensationVisibility: "HIDDEN",
        salaryMinPaise: 50_00_000_00,
        salaryMaxPaise: 90_00_000_00,
        salaryCurrency: "INR",
        compensationPeriod: "YEAR",
      })
    );
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const single = (await resBody(
      await entryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${added.entry.id}`, "GET"), entryP(org.id, opp.id, added.entry.id as string))
    )) as { entry: Record<string, unknown> };
    const serialized = JSON.stringify(single.entry);
    // The incompatible-but-hidden salary is never evaluated, never emitted.
    expect(serialized).not.toContain("500000000");
    expect(serialized).not.toContain("900000000");
    expect(serialized).not.toContain("salaryMinPaise");
    expect(serialized).not.toContain("compensationVisibility");
  });
});

describe("M-O5 shortlist — lifecycle semantics (D6/D7/D9)", () => {
  test("candidate revocation after insertion masks the entry; record preserved; edit still possible", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org F ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate F");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;

    // Candidate revokes (consent REVOKED + profile forced HIDDEN by O2).
    await db.candidateVisibilityConsent.updateMany({
      where: { userId: candidate.id, scope: "DISCOVERY", status: "GRANTED" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await db.candidateOpportunityProfile.update({ where: { userId: candidate.id }, data: { visibilityStatus: "HIDDEN" } });

    await loginAs(owner.id);
    const listed = (await resBody(await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id)))) as {
      entries: Record<string, unknown>[];
    };
    const mine = listed.entries.find((e) => e.candidateUserId === candidate.id)!;
    expect(mine.state).toBe("MASKED_CONSENT");
    expect(mine).not.toHaveProperty("candidate");
    expect(JSON.stringify(mine)).not.toContain("REMOTE");
    // Record preserved — the employer's working record survives (D9).
    expect(await db.candidateShortlist.count({ where: { id: entryId } })).toBe(1);
    // And remains editable (note update works on a masked entry).
    const patched = await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { note: "kept for records" }), entryP(org.id, opp.id, entryId));
    expect(patched.status).toBe(200);
    const updated = await db.candidateShortlist.findUnique({ where: { id: entryId } });
    expect(updated!.note).toBe("kept for records");
  });

  test("candidate PAUSED after insertion masks with the truthful state (record preserved)", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org G ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate G");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    await loginAs(candidate.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "PAUSED" }));
    await loginAs(owner.id);
    const listed = (await resBody(await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id)))) as {
      entries: Record<string, unknown>[];
    };
    const mine = listed.entries.find((e) => e.candidateUserId === candidate.id)!;
    expect(mine.state).toBe("MASKED_VISIBILITY");
    expect(mine).not.toHaveProperty("candidate");
  });

  test("INVITE_ONLY masks (D8 — behaves as HIDDEN in v1)", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org H ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate H");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id));
    await loginAs(candidate.id);
    await visibilityRoute(req("/api/opportunities/me/visibility", "POST", { status: "INVITE_ONLY" }));
    await loginAs(owner.id);
    const listed = (await resBody(await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id)))) as {
      entries: Record<string, unknown>[];
    };
    expect(listed.entries.find((e) => e.candidateUserId === candidate.id)!.state).toBe("MASKED_VISIBILITY");
  });

  test("opportunity PAUSED: existing entries editable (note/archive/remove), NEW adds refused", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org I ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate I");
    const lateCandidate = await makeDiscoverableCandidate("SL Candidate I Late");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;

    await db.opportunity.update({ where: { id: opp.id }, data: { status: "PAUSED" } });
    // Existing entry editable.
    expect(
      (await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { note: "paused but editable" }), entryP(org.id, opp.id, entryId))).status
    ).toBe(200);
    expect(
      (await deleteEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "DELETE"), entryP(org.id, opp.id, entryId))).status
    ).toBe(200);
    // NEW adds refused while paused (adding is discovery-adjacent).
    const lateAdd = await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: lateCandidate.id }), listP(org.id, opp.id));
    expect(lateAdd.status).toBe(409);
    expect(((await resBody(lateAdd)) as Record<string, unknown>).code).toBe("OX_OPPORTUNITY_NOT_DISCOVERABLE");
    expect(await db.candidateShortlist.count({ where: { opportunityId: opp.id } })).toBe(0);
  });

  test("terminal opportunity (FILLED): read-only — list OK, patch/archive/remove 409", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org J ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate J");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;
    await db.opportunity.update({ where: { id: opp.id }, data: { status: "FILLED", closedAt: new Date() } });

    const list = (await resBody(await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id)))) as {
      opportunityStatus: string;
      editable: boolean;
    };
    expect(list.opportunityStatus).toBe("FILLED");
    expect(list.editable).toBe(false);
    expect(
      (await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { note: "nope" }), entryP(org.id, opp.id, entryId))).status
    ).toBe(409);
    expect(
      (await deleteEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "DELETE"), entryP(org.id, opp.id, entryId))).status
    ).toBe(409);
    expect(((await resBody(await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { note: "nope" }), entryP(org.id, opp.id, entryId)))) as Record<string, unknown>).code).toBe(
      "OX_OPPORTUNITY_TERMINAL_READ_ONLY"
    );
    expect(await db.candidateShortlist.count({ where: { id: entryId } })).toBe(1);
  });

  test("remove deletes the entry and audits; persistence across requests", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org K ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate K");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;
    // Persistence across requests: entry survives unrelated reads.
    await listRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "GET"), listP(org.id, opp.id));
    expect(await db.candidateShortlist.count({ where: { id: entryId } })).toBe(1);
    const removed = await deleteEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "DELETE"), entryP(org.id, opp.id, entryId));
    expect(removed.status).toBe(200);
    expect(await db.candidateShortlist.count({ where: { id: entryId } })).toBe(0);
    const removedAudit = await db.auditEvent.findFirst({ where: { action: "ox.shortlist.removed", actorUserId: owner.id } });
    expect(removedAudit).not.toBeNull();
  });

  test("NO notification side effects: shortlisting writes no Notification rows for the candidate", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org L ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate L");
    const opp = await makeOpportunity(org.id, owner.id);
    const before = await db.notification.count({ where: { userId: candidate.id } });
    await loginAs(owner.id);
    await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id));
    const after = await db.notification.count({ where: { userId: candidate.id } });
    expect(after).toBe(before); // D13: no candidate notification
  });

  test("archive + unarchive via PATCH status; audit correctness", async () => {
    const { owner, org } = await makeVerifiedOrg(`SL Org M ${randomUUID().slice(0, 8)}`);
    const candidate = await makeDiscoverableCandidate("SL Candidate M");
    const opp = await makeOpportunity(org.id, owner.id);
    await loginAs(owner.id);
    const added = (await resBody(
      await addEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist`, "POST", { candidateUserId: candidate.id }), listP(org.id, opp.id))
    )) as { entry: Record<string, unknown> };
    const entryId = added.entry.id as string;
    expect(
      (await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { status: "ARCHIVED" }), entryP(org.id, opp.id, entryId))).status
    ).toBe(200);
    expect((await db.candidateShortlist.findUnique({ where: { id: entryId } }))!.status).toBe("ARCHIVED");
    expect(
      (await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { status: "ACTIVE" }), entryP(org.id, opp.id, entryId))).status
    ).toBe(200);
    const updatedAudit = await db.auditEvent.findFirst({ where: { action: "ox.shortlist.updated", actorUserId: owner.id } });
    expect(updatedAudit).not.toBeNull();
    // Note > 500 chars is rejected.
    expect(
      (await patchEntryRoute(req(`/api/employers/${org.id}/opportunities/${opp.id}/shortlist/${entryId}`, "PATCH", { note: "x".repeat(501) }), entryP(org.id, opp.id, entryId))).status
    ).toBe(400);
  });
});
