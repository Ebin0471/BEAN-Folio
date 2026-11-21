/**
 * BEAN Folio — Phase 4 canonical QA journey fixtures.
 *
 * Rebuilds the minimum complete deterministic dataset the eleven launch-audit
 * journeys need, EXCLUSIVELY through the product's own live HTTP APIs
 * (register → login → profile → consent → visibility → org → verification →
 * admin review → opportunity → submit → admin approval → invitations).
 * No fixture row is fabricated directly: every state the journeys audit is a
 * state the application itself wrote.
 *
 * Deliberately leaves audit work for the journeys (they are audits, not
 * replays): the shortlist is empty, both journey invitations are SENT but
 * unanswered, one opportunity stays DRAFT, no hiring room exists yet.
 *
 * Idempotent: deterministic emails; existing accounts are logged into, not
 * recreated; already-current consent grants are accepted (200/201 both OK).
 * Re-running converges on the same fixture set.
 *
 * Prerequisites (in order):
 *   1. `DATABASE_URL` pinned to the isolated QA database and validated:
 *        DATABASE_URL='file:/home/z/bean-folio/db/custom.db' \
 *          scripts/ops/qa-db-env.sh assert --must-exist
 *   2. Dev server on :3000 serving THIS workspace (`./ensure-dev.sh`).
 *   3. Base taxonomy + demo/QA accounts seeded:
 *        bun scripts/seed-professions.ts
 *        bun scripts/seed.ts
 *        bun scripts/restore-qa-fixtures.ts
 *        bun scripts/seed-social-e2e.ts
 *   4. Admin fixture promoted (documented tool, no admin API by design):
 *        DATABASE_URL=<pinned QA URL> bun scripts/set-admin.ts admin@beanfolio.test
 *
 * Run:
 *   DATABASE_URL=<pinned QA URL> bun scripts/seed-ox-journeys.ts
 *
 * Output: a step-by-step log plus a final JSON manifest (all created ids)
 * on stdout — paste the manifest into docs/ops/PHASE4_FIXTURE_MANIFEST.md.
 */

import { PrismaClient } from "@prisma/client";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "qa-journey-password-1";
/** Canonical QA accounts (scripts/restore-qa-fixtures.ts) use their own documented password. */
const CANONICAL_PASSWORD = "qa-fixture-password";
const CANONICAL_EMAILS = new Set([
  "trace-tester@beanfolio.test",
  "navfree@beanfolio.test",
  "admin@beanfolio.test",
  "journey@beanfolio.test",
  "nova.testwright@example.com",
  "milo.testwright@example.com",
  "qa-live-1026@example.com",
  "qa-live2-1026@example.com",
  "bean-e2e@beanfolio.app",
  "pub-e2e-1027@beanfolio.test",
]);

/** Fail closed when pointed at anything but the isolated QA SQLite file. */
const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("file:") || url.includes("?") || !url.endsWith("/db/custom.db")) {
  console.error(
    "REFUSED: DATABASE_URL must be the workspace-isolated QA file (file:<repo>/db/custom.db), pinned inline."
  );
  process.exit(2);
}

/** Direct client ONLY for the admin-role fixture (no admin API by design). */
const db = new PrismaClient();

type Jar = { cookie: string | undefined };
type Resp = { status: number; json: any };

async function api(jar: Jar, method: string, path: string, body?: unknown): Promise<Resp> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const pair = c.split(";")[0];
    if (pair.startsWith("bean_session=")) jar.cookie = pair;
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

function must(step: string, r: Resp, expect: number | number[] = 200): any {
  const allowed = Array.isArray(expect) ? expect : [expect];
  if (!allowed.includes(r.status)) {
    console.error(`STEP FAILED: ${step} → HTTP ${r.status}`, JSON.stringify(r.json)?.slice(0, 400));
    process.exit(1);
  }
  console.log(`  ok ${step} (${r.status})`);
  return r.json;
}

async function registerOrLogin(email: string, name: string): Promise<Jar> {
  const jar: Jar = { cookie: undefined };
  const password = CANONICAL_EMAILS.has(email) ? CANONICAL_PASSWORD : PASSWORD;
  let reg = await api(jar, "POST", "/api/auth/register", { email, password, name });
  // Shared-IP burst limiter (register is 10/min per client key): wait and retry.
  for (let attempt = 0; reg.status === 429 && attempt < 12; attempt++) {
    console.log(`  … register rate-limited, waiting 10s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 10_000));
    reg = await api(jar, "POST", "/api/auth/register", { email, password, name });
  }
  if (reg.status === 201 || reg.status === 200) {
    console.log(`  + registered ${email}`);
    return jar;
  }
  const login = await api(jar, "POST", "/api/auth/login", { email, password });
  if (login.status !== 200) {
    console.error(
      `STEP FAILED: register=${reg.status} then login ${email} → ${login.status}`,
      JSON.stringify(login.json),
      JSON.stringify(reg.json)?.slice(0, 200)
    );
    process.exit(1);
  }
  console.log(`  = ${email} (existing, logged in)`);
  return jar;
}

async function main() {
  console.log(`[seed-ox-journeys] base=${BASE}`);
  const manifest: Record<string, unknown> = {};

  // Taxonomy lookup: the OX surface references Profession rows by DB id
  // (slugs are the human-facing form elsewhere). Fixture lookup only.
  const professionIdOf = async (slug: string): Promise<string> => {
    const row = await db.profession.findUnique({ where: { slug }, select: { id: true } });
    if (!row) {
      console.error(`REFUSED: profession slug "${slug}" not found — run scripts/seed-professions.ts first.`);
      process.exit(2);
    }
    return row.id;
  };
  const FILM_VIDEO_ID = await professionIdOf("film-video");
  const SOFTWARE_DEV_ID = await professionIdOf("software-dev");


  // ---------- 0. Admin fixture (DB-level role only; every other state via API) ----------
  console.log("[0] admin fixture");
  const adminEmail = "admin@beanfolio.test";
  const adminRow = await db.user.findUnique({ where: { email: adminEmail }, select: { id: true, role: true } });
  if (!adminRow) {
    console.error("REFUSED: admin@beanfolio.test missing — run scripts/restore-qa-fixtures.ts first.");
    process.exit(2);
  }
  if (adminRow.role !== "ADMIN") {
    await db.user.update({ where: { id: adminRow.id }, data: { role: "ADMIN" } });
    console.log("  + role=ADMIN (equivalent to scripts/set-admin.ts admin@beanfolio.test)");
  } else {
    console.log("  = already ADMIN");
  }
  const admin = await registerOrLogin(adminEmail, "Admin Fixture");
  must("admin verification queue readable", await api(admin, "GET", "/api/admin/ox/verifications?status=PENDING"));

  // ---------- 1. Candidate identities ----------
  console.log("[1] candidates");
  const j1 = await registerOrLogin("j1-candidate@qa.beanfolio.test", "Journey One Candidate");
  // J1 leaves portfolio creation/publishing to the audit; only the account
  // plus a base profile (which upserts the shared Skill taxonomy rows the
  // opportunities below reference) is fixture state.
  must(
    "j1 base profile",
    await api(j1, "PATCH", "/api/me/profile", {
      headline: "Motion designer — journey-audit fixture",
      location: "Bengaluru, India",
      skills: ["editing", "after-effects", "color-grading"],
      professions: ["film-video"],
    })
  );

  async function makeOxCandidate(email: string, name: string, headline: string): Promise<{ jar: Jar; id: string }> {
    const jar = await registerOrLogin(email, name);
    must(
      `${email} base profile (skill taxonomy rows)`,
      await api(jar, "PATCH", "/api/me/profile", {
        headline,
        location: "Bengaluru, India",
        skills: ["editing", "after-effects"],
        professions: ["film-video"],
      })
    );
    const prof = must(
      `${email} ox profile`,
      await api(jar, "PUT", "/api/opportunities/me/profile", {
        employmentTypes: ["FULL_TIME"],
        workModes: ["REMOTE", "HYBRID"],
        preferredLocations: ["Bengaluru, India"],
        preferredProfessionIds: [FILM_VIDEO_ID],
        experienceMinYears: 3,
        experienceMaxYears: 7,
        availableFrom: new Date(Date.now() + 14 * 24 * 3600_000).toISOString(),
        noticePeriodDays: 30,
        compensationVisibility: "RANGE_ONLY",
        salaryMinPaise: 500_000_00,
        salaryMaxPaise: 900_000_00,
        salaryCurrency: "INR",
        compensationPeriod: "YEAR",
      }),
      [200, 201]
    );
    const consent = must(
      `${email} DISCOVERY consent`,
      await api(jar, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" }),
      [200, 201]
    );
    must(
      `${email} visibility ACTIVE`,
      await api(jar, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" }),
      [200, 201]
    );
    return { jar, id: consent.consent?.userId ?? prof.profile?.userId };
  }

  const j4Visible = await makeOxCandidate("j4-visible@qa.beanfolio.test", "Journey Visible", "Senior motion designer (discoverable fixture)");
  // Widen the visible candidate's skill set so the taxonomy rows the
  // Backend fixture opportunity references (typescript) exist — skills
  // materialize exclusively through real profile writes.
  must(
    "j4-visible widened skills (taxonomy rows)",
    await api(j4Visible.jar, "PATCH", "/api/me/profile", {
      skills: ["editing", "after-effects", "color-grading", "typescript"],
    })
  );
  const j4Hidden = await makeOxCandidate("j4-hidden@qa.beanfolio.test", "Journey Hidden", "Motion designer (hidden fixture)");
  must("j4-hidden visibility HIDDEN", await api(j4Hidden.jar, "POST", "/api/opportunities/me/visibility", { status: "HIDDEN" }), [200, 201]);
  const j4Revoked = await makeOxCandidate("j4-revoked@qa.beanfolio.test", "Journey Revoked", "Motion designer (revoked-consent fixture)");
  must(
    "j4-revoked DISCOVERY consent revoked",
    await api(j4Revoked.jar, "POST", "/api/opportunities/me/consents/DISCOVERY/revoke", {}),
    [200, 201]
  );
  const j7 = await makeOxCandidate("j7-candidate@qa.beanfolio.test", "Journey Seven", "Senior motion designer (negotiation fixture)");
  const j8 = await makeOxCandidate("j8-candidate@qa.beanfolio.test", "Journey Eight", "Senior motion designer (hiring-room fixture)");

  // Candidate ids come from the owner-serialized profiles.
  const idOf = async (jar: Jar): Promise<string> => {
    const me = await api(jar, "GET", "/api/auth/me");
    if (me.status !== 200 || !me.json?.user?.id) {
      console.error("STEP FAILED: GET /api/auth/me", JSON.stringify(me.json));
      process.exit(1);
    }
    return me.json.user.id as string;
  };
  const j4VisibleId = await idOf(j4Visible.jar);
  const j7Id = await idOf(j7.jar);
  const j8Id = await idOf(j8.jar);

  // ---------- 2. Employer organizations ----------
  console.log("[2] employer organizations");
  async function makeOrg(
    ownerEmail: string,
    ownerName: string,
    displayName: string,
    slug: string,
    legalName: string
  ): Promise<{ jar: Jar; orgId: string; verificationId?: string }> {
    const jar = await registerOrLogin(ownerEmail, ownerName);
    let created = await api(jar, "POST", "/api/employers", {
      legalName,
      displayName,
      slug,
      website: "https://journey-qa.example.com",
      industry: "Software development",
      companySize: "MID_51_200",
      headquarters: "Bengaluru, India",
      description: "Phase 4 journey-audit fixture organization (QA only).",
    });
    let orgId: string | undefined = created.json?.organization?.id;
    if (created.status === 409) {
      // Re-run against an existing fixture: resolve the org from memberships.
      console.log(`  = org ${slug} (existing slug, resolving via memberships)`);
      const me = await api(jar, "GET", "/api/employers/me");
      const membership = (me.json?.memberships ?? []).find((m: any) => m.organization?.slug === slug);
      orgId = membership?.organization?.id;
      if (!orgId) {
        console.error(`STEP FAILED: org ${slug} exists but no membership found`, JSON.stringify(me.json)?.slice(0, 300));
        process.exit(1);
      }
    } else if (created.status !== 200 && created.status !== 201) {
      console.error(`STEP FAILED: org ${slug} → HTTP ${created.status}`, JSON.stringify(created.json)?.slice(0, 300));
      process.exit(1);
    } else {
      console.log(`  ok org ${slug} (${created.status})`);
    }
    const ver = await api(jar, "POST", `/api/employers/${orgId}/verification`, {
      evidenceReference: `QA-J3-${slug.toUpperCase()}`,
    });
    let verificationId: string | undefined;
    if (ver.status === 201 || ver.status === 200) {
      verificationId = ver.json?.verification?.id;
      console.log(`  ok verification submitted (${ver.status})`);
    } else if (ver.status === 409) {
      console.log("  = verification already under review (existing fixture)");
      const list = await api(jar, "GET", `/api/employers/${orgId}`);
      verificationId = list.json?.organization?.verification?.id;
    } else {
      console.error(`STEP FAILED: verification submit → ${ver.status}`, JSON.stringify(ver.json));
      process.exit(1);
    }
    return { jar, orgId: orgId!, verificationId };
  }

  const j3 = await makeOrg("j3-owner@qa.beanfolio.test", "Journey Labs Owner", "Journey Labs", "journey-labs-qa", "Journey Labs Pvt Ltd");
  const j5 = await makeOrg("j5-owner@qa.beanfolio.test", "Journey Studios Owner", "Journey Studios", "journey-studios-qa", "Journey Studios Pvt Ltd");
  const j6 = await makeOrg("j6-owner@qa.beanfolio.test", "Journey Talent Owner", "Journey Talent", "journey-talent-qa", "Journey Talent Pvt Ltd");
  const j3Unverified = await makeOrg(
    "j3-unverified@qa.beanfolio.test",
    "Boundary Works Owner",
    "Boundary Works",
    "boundary-works-qa",
    "Boundary Works Pvt Ltd"
  );

  // Admin approves J3/J5/J6 (idempotent: skip orgs already VERIFIED);
  // Boundary Works stays PENDING (J3 boundary audit).
  async function orgStatus(orgId: string, jar: Jar): Promise<string> {
    const me = await api(jar, "GET", "/api/employers/me");
    const membership = (me.json?.memberships ?? []).find((m: any) => m.organization?.id === orgId);
    return membership?.organization?.verificationStatus ?? "UNKNOWN";
  }
  const pending = must("admin pending queue", await api(admin, "GET", "/api/admin/ox/verifications?status=PENDING"));
  const queue: any[] = pending.verifications ?? [];
  for (const org of [j3, j5, j6]) {
    const status = await orgStatus(org.orgId, org.jar);
    if (status === "VERIFIED") {
      console.log("  = verification already VERIFIED (existing fixture)");
      continue;
    }
    const row = queue.find((v) => v.organization?.id === org.orgId);
    if (!row) {
      console.error(`STEP FAILED: pending verification not found for org ${org.orgId} (status ${status})`);
      process.exit(1);
    }
    must(
      `admin approve ${row.organization.displayName}`,
      await api(admin, "PATCH", `/api/admin/ox/verifications/${row.id}`, { decision: "APPROVE" }),
      [200, 201]
    );
  }

  // ---------- 3. Opportunities ----------
  console.log("[3] opportunities");
  async function makeOpportunity(
    org: { jar: Jar; orgId: string },
    input: Record<string, unknown>,
    publish: boolean
  ): Promise<{ id: string; status: string }> {
    // Idempotency: reuse an existing fixture opportunity with the same title.
    // (No status param — the list route rejects unknown filters; omitting it
    // returns every status.)
    const existing = await api(org.jar, "GET", `/api/employers/${org.orgId}/opportunities`);
    const prior = (existing.json?.opportunities ?? []).find((o: any) => o.title === input.title);
    if (prior) {
      console.log(`  = opportunity "${input.title}" (existing, status ${prior.status})`);
      return { id: prior.id, status: prior.status };
    }
    const created = must(
      `opportunity ${input.title}`,
      await api(org.jar, "POST", `/api/employers/${org.orgId}/opportunities`, input),
      [200, 201]
    );
    const id = created.opportunity?.id as string;
    let status = created.opportunity?.status as string;
    if (publish) {
      must(`submit ${input.title}`, await api(org.jar, "POST", `/api/employers/${org.orgId}/opportunities/${id}/submit`, {}), [200, 201]);
      const pendingOpps = must(
        "admin pending opportunity queue",
        await api(admin, "GET", "/api/admin/ox/opportunities?status=PENDING_REVIEW")
      );
      const row = (pendingOpps.opportunities ?? []).find((o: any) => o.id === id);
      if (!row) {
        console.error(`STEP FAILED: pending opportunity ${id} not in admin queue`);
        process.exit(1);
      }
      const approved = must(
        `admin approve ${input.title}`,
        await api(admin, "PATCH", `/api/admin/ox/opportunities/${id}`, { decision: "APPROVE" }),
        [200, 201]
      );
      status = approved.opportunity?.status ?? "PUBLISHED";
    }
    return { id, status };
  }

  const motionInput = {
    title: "Senior Motion Designer",
    description:
      "Journey-audit fixture role: lead motion design for product launches. QA dataset only — not a real requisition.",
    professionId: FILM_VIDEO_ID,
    location: "Remote — India",
    employmentType: "FULL_TIME",
    workMode: "REMOTE",
    positions: 1,
    salaryMinPaise: 600_000_00,
    salaryMaxPaise: 900_000_00,
    salaryCurrency: "INR",
    compensationPeriod: "YEAR",
    skills: [
      { skill: "editing", kind: "REQUIRED" },
      { skill: "after-effects", kind: "REQUIRED" },
      { skill: "color-grading", kind: "PREFERRED" },
    ],
  };
  const motionOpp = await makeOpportunity(j6, motionInput, true);

  const backendInput = {
    title: "Backend Engineer (Payments)",
    description:
      "Journey-audit fixture role: payments backend engineering. QA dataset only — not a real requisition.",
    professionId: SOFTWARE_DEV_ID,
    location: "Bengaluru, India",
    employmentType: "FULL_TIME",
    workMode: "HYBRID",
    positions: 2,
    salaryMinPaise: 450_000_00,
    salaryMaxPaise: 800_000_00,
    salaryCurrency: "INR",
    compensationPeriod: "YEAR",
    skills: [{ skill: "typescript", kind: "REQUIRED" }],
  };
  const backendOpp = await makeOpportunity(j5, backendInput, true);

  // Left DRAFT deliberately: the J5 audit drives edit → submit → lifecycle.
  const draftInput = {
    title: "Platform Engineer (Draft Fixture)",
    description:
      "Journey-audit fixture role kept in DRAFT so the lifecycle audit drives its submission and transitions.",
    professionId: SOFTWARE_DEV_ID,
    location: "Bengaluru, India",
    employmentType: "CONTRACT",
    workMode: "REMOTE",
  };
  const draftOpp = await makeOpportunity(j5, draftInput, false);

  // ---------- 4. Shortlist + invitations ----------
  console.log("[4] shortlist + invitations");
  // One shortlist entry as deterministic fixture state; J6 audit verifies,
  // adds and removes further entries through the real flow.
  const sl = await api(j6.jar, "POST", `/api/employers/${j6.orgId}/opportunities/${motionOpp.id}/shortlist`, {
    candidateUserId: j4VisibleId,
    note: "Journey fixture: strong motion portfolio.",
  });
  if (sl.status === 409) console.log("  = shortlist j4-visible (already shortlisted)");
  else if (sl.status === 200 || sl.status === 201) console.log(`  ok shortlist j4-visible (${sl.status})`);
  else {
    console.error(`STEP FAILED: shortlist → ${sl.status}`, JSON.stringify(sl.json)?.slice(0, 300));
    process.exit(1);
  }
  // RD-2 source-pointer gate: every invitation needs an ACTIVE shortlist
  // entry (or current eligible match) for that (opportunity, candidate).
  // j7/j8 are shortlisted through the real API so their invitations pass.
  for (const candidate of [
    { id: j7Id, label: "j7-candidate" },
    { id: j8Id, label: "j8-candidate" },
  ]) {
    const r = await api(j6.jar, "POST", `/api/employers/${j6.orgId}/opportunities/${motionOpp.id}/shortlist`, {
      candidateUserId: candidate.id,
      note: `Journey fixture: ${candidate.label}.`,
    });
    if (r.status === 409) console.log(`  = shortlist ${candidate.label} (already shortlisted)`);
    else if (r.status === 200 || r.status === 201) console.log(`  ok shortlist ${candidate.label} (${r.status})`);
    else {
      console.error(`STEP FAILED: shortlist ${candidate.label} → ${r.status}`, JSON.stringify(r.json)?.slice(0, 300));
      process.exit(1);
    }
  }

  async function sendInvitation(candidateUserId: string, label: string): Promise<string> {
    const created = await api(j6.jar, "POST", "/api/opportunities/invitations", {
      organizationId: j6.orgId,
      opportunityId: motionOpp.id,
      candidateUserId,
      send: true,
      sourceHint: "MATCH",
      offer: {
        offerSalaryMinPaise: 600_000_00,
        offerSalaryMaxPaise: 800_000_00,
        offerCurrency: "INR",
        offerPeriod: "YEAR",
      },
    });
    if (created.status === 200 || created.status === 201) {
      console.log(`  ok invitation → ${label} (${created.status})`);
      return created.json.invitation?.id as string;
    }
    // Re-run against an existing fixture: resolve the active invitation.
    const list = await api(
      j6.jar,
      "GET",
      `/api/opportunities/invitations?organizationId=${j6.orgId}&opportunityId=${motionOpp.id}`
    );
    const row = (list.json?.invitations ?? []).find((i: any) => i.candidateUserId === candidateUserId);
    if (row) {
      console.log(`  = invitation → ${label} (existing, status ${row.status})`);
      return row.id as string;
    }
    console.error(`STEP FAILED: invitation → ${label} → ${created.status}`, JSON.stringify(created.json)?.slice(0, 300));
    process.exit(1);
  }
  const invJ7 = await sendInvitation(j7Id, "j7-candidate");
  const invJ8 = await sendInvitation(j8Id, "j8-candidate");

  // ---------- 5. Manifest ----------
  console.log("[5] manifest");
  manifest.admin = { email: adminEmail, role: "ADMIN" };
  manifest.password = "(journey accounts) qa-journey-password-1";
  manifest.candidates = {
    j1: { email: "j1-candidate@qa.beanfolio.test", id: await idOf(j1) },
    j4Visible: { email: "j4-visible@qa.beanfolio.test", id: j4VisibleId, state: "ACTIVE + DISCOVERY consent" },
    j4Hidden: { email: "j4-hidden@qa.beanfolio.test", state: "HIDDEN, no consent" },
    j4Revoked: { email: "j4-revoked@qa.beanfolio.test", state: "profile exists, consent revoked" },
    j7: { email: "j7-candidate@qa.beanfolio.test", id: j7Id, state: "ACTIVE + consent, invitation SENT" },
    j8: { email: "j8-candidate@qa.beanfolio.test", id: j8Id, state: "ACTIVE + consent, invitation SENT" },
  };
  manifest.organizations = {
    j3: { displayName: "Journey Labs", id: j3.orgId, state: "VERIFIED" },
    j5: { displayName: "Journey Studios", id: j5.orgId, state: "VERIFIED" },
    j6: { displayName: "Journey Talent", id: j6.orgId, state: "VERIFIED" },
    j3Unverified: { displayName: "Boundary Works", id: j3Unverified.orgId, state: "PENDING (deliberate)" },
  };
  manifest.opportunities = {
    motion: { title: "Senior Motion Designer", id: motionOpp.id, org: j6.orgId, state: motionOpp.status },
    backend: { title: "Backend Engineer (Payments)", id: backendOpp.id, org: j5.orgId, state: backendOpp.status },
    draft: { title: "Platform Engineer (Draft Fixture)", id: draftOpp.id, org: j5.orgId, state: draftOpp.status },
  };
  manifest.shortlist = { org: j6.orgId, opportunity: motionOpp.id, candidate: j4VisibleId };
  manifest.invitations = {
    j7: { id: invJ7, candidate: j7Id, opportunity: motionOpp.id, state: "SENT (deliberate)" },
    j8: { id: invJ8, candidate: j8Id, opportunity: motionOpp.id, state: "SENT (deliberate)" },
  };
  manifest.deliberatelyLeftForAudit = [
    "J1 portfolio creation/publish/persistence",
    "J2 privacy flips + unauthorized access attempts",
    "J3 Boundary Works verification decision + suspended-state behavior",
    "J4 discovery matrix incl. consent revalidation + blocks",
    "J5 draft opportunity lifecycle + invalid transitions",
    "J6 matches transparency + shortlist add/remove + eligibility",
    "J7 negotiation request/counter/accept on invitation " + invJ7,
    "J8 invitation " + invJ8 + " accept → room creation (RD-1) → stages → interviews",
    "J9 messaging + notifications",
    "J10 account deletion on a fresh disposable identity",
    "J11 responsive desktop/mobile",
  ];

  console.log("=== FIXTURE MANIFEST (JSON) ===");
  console.log(JSON.stringify(manifest, null, 2));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
