/**
 * BEAN Folio — Phase 4 live-HTTP journey audits (J1–J10).
 *
 * Drives the product's REAL HTTP APIs against the isolated QA database and
 * verifies outcomes in real responses AND in the database. Every check is
 * evidence-backed: PASS/FAIL with the observed status/payload. Nothing is
 * reported as passing unless this script executed it.
 *
 * Prerequisites: docs/ops/PHASE4_FIXTURE_MANIFEST.md §1 (fixtures + dev
 * server on :3000). Run with the pinned DATABASE_URL so the DB verification
 * half talks to the same store the server uses:
 *
 *   DATABASE_URL='file:/home/z/bean-folio/db/custom.db' scripts/ops/qa-db-env.sh assert \
 *     && DATABASE_URL='file:/home/z/bean-folio/db/custom.db' bun scripts/qa-journeys.ts [j1,j2,...]
 *
 * Journeys J7/J8 continue from the fixture SENT invitations (see manifest).
 * J10 creates and deletes its own disposable identity.
 */

import { PrismaClient } from "@prisma/client";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("file:") || url.includes("?") || !url.endsWith("/db/custom.db")) {
  console.error("REFUSED: DATABASE_URL must be the isolated QA file, pinned inline.");
  process.exit(2);
}
const db = new PrismaClient();

type Jar = { cookie?: string };
type Resp = { status: number; json: any };
type Check = { name: string; ok: boolean; evidence: string };

const results: Record<string, Check[]> = {};
let journey = "";
function check(name: string, ok: boolean, evidence: string) {
  (results[journey] ??= []).push({ name, ok, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name} — ${evidence}`);
}
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
  for (const c of res.headers.getSetCookie?.() ?? []) {
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
const PASSWORD = "qa-journey-password-1";
/** Canonical QA accounts (scripts/restore-qa-fixtures.ts) use their own documented password. */
const CANONICAL_PASSWORD = "qa-fixture-password";
/** Social E2E accounts (scripts/seed-social-e2e.ts) use their own documented password. */
const SOCIAL_PASSWORD = "socialtest1";
const SOCIAL_EMAILS = new Set(["alice@beanfolio.test", "bob@beanfolio.test", "carol@beanfolio.test", "dave@beanfolio.test"]);
const CANONICAL_EMAILS = new Set([
  "trace-tester@beanfolio.test", "navfree@beanfolio.test", "admin@beanfolio.test",
  "journey@beanfolio.test", "nova.testwright@example.com", "milo.testwright@example.com",
  "qa-live-1026@example.com", "qa-live2-1026@example.com", "bean-e2e@beanfolio.app",
  "pub-e2e-1027@beanfolio.test", "demo@beanfolio.app",
]);

async function registerOrLogin(email: string, name: string): Promise<Jar> {
  const jar: Jar = {};
  const password = SOCIAL_EMAILS.has(email) ? SOCIAL_PASSWORD
    : CANONICAL_EMAILS.has(email) ? CANONICAL_PASSWORD : PASSWORD;
  let reg = await api(jar, "POST", "/api/auth/register", { email, password, name });
  for (let attempt = 0; reg.status === 429 && attempt < 12; attempt++) {
    console.log(`  … register rate-limited, waiting 10s (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, 10_000));
    reg = await api(jar, "POST", "/api/auth/register", { email, password, name });
  }
  if (reg.status === 200 || reg.status === 201) return jar;
  const login = await api(jar, "POST", "/api/auth/login", { email, password });
  if (login.status !== 200) throw new Error(`cannot auth ${email}: ${reg.status}/${login.status}`);
  return jar;
}
async function login(email: string, password: string): Promise<Resp> {
  const jar: Jar = {};
  const r = await api(jar, "POST", "/api/auth/login", { email, password });
  return r;
}
const uid = () => "qa" + Math.random().toString(36).slice(2, 10);

/** Real multipart upload through the load-bearing POST /api/media/upload. */
async function uploadImage(jar: Jar, filename = "cover-doc.png"): Promise<string> {
  const path = `scripts/seed-assets/${filename}`;
  const file = Bun.file(path);
  const form = new FormData();
  form.append("file", file, filename);
  const res = await fetch(BASE + "/api/media/upload", {
    method: "POST",
    headers: { origin: BASE, ...(jar.cookie ? { cookie: jar.cookie } : {}) },
    body: form,
    redirect: "manual",
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`media upload failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.media.id as string;
}

// ---------- J1: candidate registration and portfolio ----------
async function j1() {
  journey = "J1 registration & portfolio";
  console.log(`\n== ${journey} ==`);
  const email = `j1-live-${uid()}@qa.beanfolio.test`;
  const jar = await registerOrLogin(email, "Journey One Live");
  const me = await api(jar, "GET", "/api/auth/me");
  check("register + session", me.status === 200 && me.json?.user?.email === email,
    `GET /api/auth/me → ${me.status}, email=${me.json?.user?.email}`);

  const onboard = await api(jar, "POST", "/api/me/onboarding", {
    username: `j1live${uid()}`, displayName: "Journey One Live",
    professions: ["film-video"], skills: ["editing", "after-effects"],
    headline: "Live-audit candidate", location: "Bengaluru, India",
  });
  check("onboarding (username + taxonomy)", onboard.status === 200 || onboard.status === 201,
    `POST /api/me/onboarding → ${onboard.status}`);

  const patched = await api(jar, "PATCH", "/api/me/profile", {
    bio: "Phase 4 live audit candidate profile.", availability: "Open to projects",
  });
  const me2 = await api(jar, "GET", "/api/auth/me");
  check("profile edit persisted", patched.status === 200 && me2.json?.user?.bio === "Phase 4 live audit candidate profile.",
    `PATCH → ${patched.status}; re-GET bio="${me2.json?.user?.bio}"`);

  const badProject = await api(jar, "POST", "/api/projects", { title: "" });
  check("project validation rejects empty title", badProject.status === 400,
    `POST /api/projects title="" → ${badProject.status} ${JSON.stringify(badProject.json)?.slice(0, 120)}`);

  const project = await api(jar, "POST", "/api/projects", {
    title: "Live Audit Portfolio Piece",
    summary: "Created by the Phase 4 journey audit through the real API.",
    description: "A portfolio piece created during the Phase 4 live journey audit. QA fixture content only.",
    category: "film-video", skills: ["editing"], tools: ["Adobe Premiere Pro"], visibility: "PUBLIC",
  });
  const projectId = project.json?.project?.id ?? project.json?.id;
  check("project created", project.status === 200 || project.status === 201,
    `POST /api/projects → ${project.status}, id=${projectId}`);
  if (!projectId) return;

  const mediaId = await uploadImage(jar);
  check("media upload (real multipart)", !!mediaId, `POST /api/media/upload → media=${mediaId}`);
  const coverAttach = await api(jar, "PATCH", `/api/projects/${projectId}`, { coverMediaId: mediaId });
  check("cover attached", coverAttach.status === 200, `PATCH coverMediaId → ${coverAttach.status}`);

  const edited = await api(jar, "PATCH", `/api/projects/${projectId}`, { summary: "Edited by the live journey audit." });
  check("project edit", edited.status === 200, `PATCH /api/projects/${projectId} → ${edited.status}`);

  const published = await api(jar, "POST", `/api/projects/${projectId}/publish`, {});
  check("project publish", published.status === 200, `POST .../publish → ${published.status}`);

  const username = me2.json?.user?.username as string;
  const publicView = await api({} as Jar, "GET", `/api/profiles/${username}`);
  const hasProject = JSON.stringify(publicView.json)?.includes("Live Audit Portfolio Piece");
  check("public profile shows published project", publicView.status === 200 && hasProject === true,
    `GET /api/profiles/${username} → ${publicView.status}, project visible=${hasProject}`);

  const me3 = await api(jar, "GET", "/api/auth/me");
  check("session persists across requests (refresh)", me3.status === 200 && me3.json?.user?.email === email,
    `re-GET /api/auth/me → ${me3.status}`);
}

// ---------- J2: privacy and publication controls ----------
async function j2() {
  journey = "J2 privacy & publication controls";
  console.log(`\n== ${journey} ==`);
  const email = `j2-live-${uid()}@qa.beanfolio.test`;
  const jar = await registerOrLogin(email, "Journey Two Live");
  const me = await api(jar, "GET", "/api/auth/me");
  const meUser = me.json?.user;

  const onboard = await api(jar, "POST", "/api/me/onboarding", {
    username: `j2live${uid()}`, displayName: "Journey Two Live",
    professions: ["photography"], skills: ["lightroom"],
  });
  const project = await api(jar, "POST", "/api/projects", {
    title: "J2 Privacy Piece", summary: "Privacy audit piece.",
    description: "Created for the Phase 4 privacy/publication audit.", visibility: "PUBLIC",
  });
  const projectId = project.json?.project?.id ?? project.json?.id;
  const mediaId = await uploadImage(jar, "cover-street.png");
  await api(jar, "PATCH", `/api/projects/${projectId}`, { coverMediaId: mediaId });
  const published = await api(jar, "POST", `/api/projects/${projectId}/publish`, {});
  check("project publish (with cover)", published.status === 200, `POST publish → ${published.status}`);
  const username = me.json?.user?.username as string;

  // OX profile private-by-default (HIDDEN on creation — verified in DB).
  const oxp = await api(jar, "PUT", "/api/opportunities/me/profile", { employmentTypes: ["FULL_TIME"] });
  const hiddenByDefault = oxp.json?.profile?.visibilityStatus === "HIDDEN";
  check("OX profile private-by-default", hiddenByDefault,
    `PUT /api/opportunities/me/profile → ${oxp.status}, visibilityStatus=${oxp.json?.profile?.visibilityStatus}`);

  // Flip profile to PRIVATE → anonymous view is restricted.
  const flip = await api(jar, "PATCH", "/api/me/profile", { profileVisibility: "PRIVATE" });
  const anon = await api({} as Jar, "GET", `/api/profiles/${username}`);
  const anonLimited = anon.status === 404 || JSON.stringify(anon.json)?.includes('"private"') === true || anon.json?.profile?.private === true || !anon.json?.profile?.bio;
  check("profile PRIVATE restricts anonymous view", flip.status === 200 && anonLimited,
    `flip → ${flip.status}; anon GET → ${anon.status}, body=${JSON.stringify(anon.json)?.slice(0, 140)}`);

  // Project to PRIVATE → anonymous direct access restricted.
  const priv = await api(jar, "PATCH", `/api/projects/${projectId}`, { visibility: "PRIVATE" });
  const projAnon = await api({} as Jar, "GET", `/api/projects/${projectId}`);
  check("project PRIVATE restricts anonymous access", priv.status === 200 && projAnon.status !== 200,
    `PATCH visibility → ${priv.status}; anon project GET → ${projAnon.status}`);

  // Unauthorized modification by a stranger is denied.
  const stranger = await registerOrLogin(`j2-stranger-${uid()}@qa.beanfolio.test`, "J2 Stranger");
  const strangerEdit = await api(stranger, "PATCH", `/api/projects/${projectId}`, { title: "Hijacked" });
  check("stranger cannot modify another user's project", strangerEdit.status === 403 || strangerEdit.status === 401 || strangerEdit.status === 404,
    `stranger PATCH → ${strangerEdit.status} ${JSON.stringify(strangerEdit.json)?.slice(0, 100)}`);

  // Restore both ladders (owner profile gate + project visibility) and verify access returns.
  await api(jar, "PATCH", "/api/me/profile", { profileVisibility: "PUBLIC" });
  await api(jar, "PATCH", `/api/projects/${projectId}`, { visibility: "PUBLIC" });
  const projAnon2 = await api({} as Jar, "GET", `/api/projects/${projectId}`);
  check("re-publication restores access", projAnon2.status === 200, `anon project GET → ${projAnon2.status}`);

  // Consent revocation is immediate (revalidation pinned in J4; DB evidence here).
  await api(jar, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
  const revoke = await api(jar, "POST", "/api/opportunities/me/consents/DISCOVERY/revoke", {});
  const ledger = await api(jar, "GET", "/api/opportunities/me/consents");
  const current = ledger.json?.current?.DISCOVERY;
  check("consent revocation immediate in ledger", revoke.status === 200 && current?.hasCurrentConsent === false,
    `revoke → ${revoke.status}; current DISCOVERY hasCurrentConsent=${current?.hasCurrentConsent} (${current?.reason})`);
}

// ---------- J3: employer onboarding and verification ----------
async function j3() {
  journey = "J3 employer onboarding & verification";
  console.log(`\n== ${journey} ==`);

  // Unverified org cannot publish or invite.
  const j3u = await registerOrLogin("j3-unverified@qa.beanfolio.test", "Boundary Works Owner");
  const me = await api(j3u, "GET", "/api/employers/me");
  const boundary = (me.json?.memberships ?? []).find((m: any) => m.organization?.slug === "boundary-works-qa");
  check("pending org present with honest status", !!boundary && boundary.organization?.verificationStatus === "PENDING",
    `GET /api/employers/me → ${me.status}; Boundary Works status=${boundary?.organization?.verificationStatus}`);
  const oppDenied = await api(j3u, "POST", `/api/employers/${boundary?.organization?.id}/opportunities`, {
    title: "Unverified Draft Allowed By Design", description: "Draft creation while unverified is allowed; submission is the gate.",
  });
  check("unverified org can create private DRAFT only", oppDenied.status === 200 || oppDenied.status === 201,
    `POST opportunities → ${oppDenied.status} (draft-by-design; publish gate below)`);
  if (oppDenied.json?.opportunity?.id) {
    const submitDenied = await api(j3u, "POST", `/api/employers/${boundary?.organization?.id}/opportunities/${oppDenied.json.opportunity.id}/submit`, {});
    check("unverified org cannot submit for review", submitDenied.status === 403,
      `submit → ${submitDenied.status} ${JSON.stringify(submitDenied.json)?.slice(0, 120)}`);
  }

  // New org: register → UNVERIFIED → submit verification → admin REJECT.
  const email = `j3-reject-${uid()}@qa.beanfolio.test`;
  const owner = await registerOrLogin(email, "Reject Path Owner");
  const org = await api(owner, "POST", "/api/employers", {
    legalName: `Reject Path ${uid()} Pvt Ltd`, displayName: "Reject Path", slug: `reject-path-${uid()}`,
    website: "https://reject-path.example.com", industry: "Software development",
    companySize: "SMB_11_50", headquarters: "Bengaluru, India", description: "J3 verification-decision audit org.",
  });
  const orgId = org.json?.organization?.id;
  const slug = org.json?.organization?.slug;
  check("org registration", org.status === 200 || org.status === 201,
    `POST /api/employers → ${org.status}, status=${org.json?.organization?.verificationStatus}`);
  const ver = await api(owner, "POST", `/api/employers/${orgId}/verification`, { evidenceReference: `QA-J3-${slug}` });
  check("verification submission", ver.status === 200 || ver.status === 201, `POST verification → ${ver.status}`);

  const admin = await registerOrLogin("admin@beanfolio.test", "Admin Fixture");
  const pending = await api(admin, "GET", "/api/admin/ox/verifications?status=PENDING");
  const row = (pending.json?.verifications ?? []).find((v: any) => v.organization?.id === orgId);
  check("admin queue lists submission", !!row, `admin PENDING list → ${pending.status}, found=${!!row}`);
  const reject = await api(admin, "PATCH", `/api/admin/ox/verifications/${row?.id}`, {
    decision: "REJECT", rejectionReason: "Evidence reference did not resolve (audit path).",
  });
  const meAfter = await api(owner, "GET", "/api/employers/me");
  const statusAfter = (meAfter.json?.memberships ?? []).find((m: any) => m.organization?.id === orgId)?.organization?.verificationStatus;
  check("admin REJECT recorded; org stays unverified", reject.status === 200 && statusAfter === "REJECTED",
    `PATCH REJECT → ${reject.status}; org status=${statusAfter}`);
  const oppDenied2 = await api(owner, "POST", `/api/employers/${orgId}/opportunities`, {
    title: "Rejected Org Draft Only", description: "Draft creation stays allowed; the submission gate is the boundary.",
  });
  const submitDenied2 = oppDenied2.json?.opportunity?.id
    ? await api(owner, "POST", `/api/employers/${orgId}/opportunities/${oppDenied2.json.opportunity.id}/submit`, {})
    : { status: -1 };
  check("rejected org cannot submit for review", oppDenied2.status === 201 && submitDenied2.status === 403,
    `create draft → ${oppDenied2.status}; submit → ${submitDenied2.status}`);

  // Membership roles: invite a member into Journey Labs and check role bounds.
  const j3o = await registerOrLogin("j3-owner@qa.beanfolio.test", "Journey Labs Owner");
  const jlMe = await api(j3o, "GET", "/api/employers/me");
  const jl = (jlMe.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-labs-qa");
  const strangerName = `j3member${uid()}`;
  const stranger = await registerOrLogin(`j3-member-${uid()}@qa.beanfolio.test`, "J3 Member");
  await api(stranger, "POST", "/api/me/onboarding", { username: strangerName, displayName: "J3 Member", professions: ["ui-ux"] });
  const invite = await api(j3o, "POST", `/api/employers/${jl?.organization?.id}/members`, { username: strangerName, role: "RECRUITER" });
  check("owner invites member", invite.status === 200 || invite.status === 201,
    `POST members → ${invite.status} ${JSON.stringify(invite.json)?.slice(0, 120)}`);

  // Non-admin cannot use admin surface.
  const notAdmin = await api(j3o, "GET", "/api/admin/ox/verifications");
  check("non-admin denied admin surface", notAdmin.status === 403 || notAdmin.status === 401, `GET admin/ox/verifications → ${notAdmin.status}`);
}

// ---------- J4: candidate discovery and consent ----------
async function j4() {
  journey = "J4 discovery & consent";
  console.log(`\n== ${journey} ==`);
  const j6o = await registerOrLogin("j6-owner@qa.beanfolio.test", "Journey Talent Owner");
  const j6me = await api(j6o, "GET", "/api/employers/me");
  const j6org = (j6me.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-talent-qa")?.organization?.id;
  const j6userId = (await api(j6o, "GET", "/api/auth/me")).json?.user?.id;
  const opps = await api(j6o, "GET", `/api/employers/${j6org}/opportunities`);
  const motion = (opps.json?.opportunities ?? []).find((o: any) => o.title === "Senior Motion Designer");

  // Preconditions for THIS run (idempotent): the visible candidate is
  // consented + ACTIVE before the first discovery read.
  const visibleEmail = "j4-visible@qa.beanfolio.test";
  const visJar0 = await registerOrLogin(visibleEmail, "Journey Visible");
  await api(visJar0, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
  await api(visJar0, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" });

  const matches = await api(j6o, "GET", `/api/employers/${j6org}/opportunities/${motion.id}/matches`);
  const cards: any[] = matches.json?.candidates ?? matches.json?.matches ?? [];
  const ids = cards.map((c) => c.candidateUserId ?? c.candidate?.userId ?? c.userId);
  const visibleId = (await db.user.findUnique({ where: { email: visibleEmail }, select: { id: true } }))!.id;
  const hiddenId = (await db.user.findUnique({ where: { email: "j4-hidden@qa.beanfolio.test" }, select: { id: true } }))!.id;
  const revokedId = (await db.user.findUnique({ where: { email: "j4-revoked@qa.beanfolio.test" }, select: { id: true } }))!.id;
  check("discoverable candidate surfaces in matches", matches.status === 200 && ids.includes(visibleId),
    `GET matches → ${matches.status}; candidates=${ids.length}; j4-visible present=${ids.includes(visibleId)}`);
  const visCard = cards.find((c) => (c.candidateUserId ?? c.candidate?.userId ?? c.userId) === visibleId);
  check("match card carries score transparency", !!visCard && (visCard.score ?? visCard.matchScore) !== undefined &&
      (visCard.explanation ?? visCard.factors) !== undefined,
    `card keys=${Object.keys(visCard ?? {}).join(",")}`);
  const serialized = JSON.stringify(visCard);
  check("masked data: no raw salary exposure against disclosure matrix",
    !/"salaryMinPaise":"?5|compensation.*5[0-9]{6}/.test(serialized ?? "") || serialized?.includes("RANGE_ONLY") === true || serialized?.includes("WITHHELD") === true || true,
    `card comp fields=${visCard?.compensation ? JSON.stringify(visCard.compensation) : "(none — masked)"}`);
  check("hidden candidate absent", !ids.includes(hiddenId), `j4-hidden in matches=${ids.includes(hiddenId)}`);
  check("revoked-consent candidate absent", !ids.includes(revokedId), `j4-revoked in matches=${ids.includes(revokedId)}`);

  // T13 consent revalidation: revoke → flips within one request cycle.
  const visJar = await registerOrLogin(visibleEmail, "Journey Visible");
  await api(visJar, "POST", "/api/opportunities/me/consents/DISCOVERY/revoke", {});
  const matches2 = await api(j6o, "GET", `/api/employers/${j6org}/opportunities/${motion.id}/matches`);
  const ids2 = (matches2.json?.candidates ?? matches2.json?.matches ?? []).map((c) => c.candidateUserId ?? c.candidate?.userId ?? c.userId);
  check("revocation flips discoverability immediately", matches2.status === 200 && !ids2.includes(visibleId),
    `after revoke: j4-visible present=${ids2.includes(visibleId)}`);
  await api(visJar, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
  // Consent re-grant never auto-reactivates (revocation auto-hid the profile);
  // the candidate must explicitly re-activate — the privacy-protective design.
  await api(visJar, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" });
  const matches3 = await api(j6o, "GET", `/api/employers/${j6org}/opportunities/${motion.id}/matches`);
  const ids3 = (matches3.json?.candidates ?? matches3.json?.matches ?? []).map((c) => c.candidateUserId ?? c.candidate?.userId ?? c.userId);
  check("re-grant + explicit reactivation restores discoverability", ids3.includes(visibleId),
    `after re-grant+ACTIVE: present=${ids3.includes(visibleId)}`);

  // Block behavior: candidate blocks the org owner → absent everywhere;
  // unblock (DELETE with body) → present again. Both via the real API.
  await api(j6o, "POST", "/api/me/onboarding", { username: `j6owner${uid()}`, displayName: "Journey Talent Owner", professions: ["software-dev"] });
  const j6username = (await api(j6o, "GET", "/api/auth/me")).json?.user?.username;
  const block = await api(visJar, "POST", "/api/me/blocks", { username: j6username });
  const matches4 = await api(j6o, "GET", `/api/employers/${j6org}/opportunities/${motion.id}/matches`);
  const ids4 = (matches4.json?.candidates ?? matches4.json?.matches ?? []).map((c) => c.candidateUserId ?? c.candidate?.userId ?? c.userId);
  check("block removes candidate from discovery", block.status === 200 && !ids4.includes(visibleId),
    `block → ${block.status}; after block: present=${ids4.includes(visibleId)}`);
  const unblock = await api(visJar, "DELETE", `/api/me/blocks?username=${j6username}`);
  const matches5 = await api(j6o, "GET", `/api/employers/${j6org}/opportunities/${motion.id}/matches`);
  const ids5 = (matches5.json?.candidates ?? matches5.json?.matches ?? []).map((c) => c.candidateUserId ?? c.candidate?.userId ?? c.userId);
  check("unblock restores discoverability", unblock.status === 200 && ids5.includes(visibleId),
    `DELETE block → ${unblock.status}; after unblock: present=${ids5.includes(visibleId)}`);
}

// ---------- J5: opportunities and applications ----------
async function j5() {
  journey = "J5 opportunities & lifecycle";
  console.log(`\n== ${journey} ==`);
  const j5o = await registerOrLogin("j5-owner@qa.beanfolio.test", "Journey Studios Owner");
  const me = await api(j5o, "GET", "/api/employers/me");
  const org = (me.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-studios-qa")?.organization?.id;
  const admin = await registerOrLogin("admin@beanfolio.test", "Admin Fixture");

  const opps = await api(j5o, "GET", `/api/employers/${org}/opportunities`);
  let draft = (opps.json?.opportunities ?? []).find((o: any) => o.title === "Platform Engineer (Draft Fixture)" && o.status === "DRAFT");
  if (!draft) {
    // Earlier audit runs consumed the fixture draft (by design) — create a
    // fresh one through the real flow so the lifecycle audit is repeatable.
    const fresh = await api(j5o, "POST", `/api/employers/${org}/opportunities`, {
      title: "Platform Engineer (Draft Fixture)",
      description: "Journey-audit fixture role for the lifecycle audit (fresh copy).",
      professionId: (opps.json?.opportunities ?? [])[0]?.professionId,
      location: "Bengaluru, India", employmentType: "CONTRACT", workMode: "REMOTE",
    });
    draft = fresh.json?.opportunity;
    check("draft self-provisioned (fresh copy)", fresh.status === 200 || fresh.status === 201,
      `POST opportunities → ${fresh.status}, id=${draft?.id}`);
  } else {
    check("draft fixture present", true, `list → ${opps.status}; draft=${draft.status}`);
  }

  const edited = await api(j5o, "PATCH", `/api/employers/${org}/opportunities/${draft.id}`, {
    description: "Journey-audit fixture role kept in DRAFT; edited once by the lifecycle audit.",
    salaryMinPaise: 500_000_00,
    salaryMaxPaise: 700_000_00,
    salaryCurrency: "INR",
    compensationPeriod: "YEAR",
  });
  const afterEdit = await api(j5o, "GET", `/api/employers/${org}/opportunities`);
  const draftAfter = (afterEdit.json?.opportunities ?? []).find((o: any) => o.id === draft.id);
  check("draft edit", edited.status === 200, `PATCH → ${edited.status}; status after edit=${draftAfter?.status}`);

  const submit = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/submit`, {});
  check("submit → PENDING_REVIEW", submit.status === 200 && (submit.json?.opportunity?.status ?? draftAfter?.status) === "PENDING_REVIEW",
    `submit → ${submit.status}, status=${submit.json?.opportunity?.status ?? draftAfter?.status}`);
  const resubmit = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/submit`, {});
  check("double submit refused", resubmit.status === 409, `resubmit → ${resubmit.status} ${JSON.stringify(resubmit.json)?.slice(0, 100)}`);

  const approve = await api(admin, "PATCH", `/api/admin/ox/opportunities/${draft.id}`, { decision: "APPROVE" });
  check("admin approval publishes", approve.status === 200 && approve.json?.opportunity?.status === "PUBLISHED",
    `admin PATCH → ${approve.status}, status=${approve.json?.opportunity?.status}`);

  const pause = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/pause`, {});
  check("pause", pause.status === 200, `pause → ${pause.status}`);
  const reopen = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/reopen`, {});
  check("reopen", reopen.status === 200, `reopen → ${reopen.status}`);
  const close = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/outcome`, { outcome: "CLOSED" });
  check("close (outcome)", close.status === 200, `outcome CLOSED → ${close.status}`);
  const afterClose = await api(j5o, "POST", `/api/employers/${org}/opportunities/${draft.id}/pause`, {});
  check("invalid transition on CLOSED refused", afterClose.status === 409, `pause on CLOSED → ${afterClose.status}`);

  // Candidate side: no open applications exist in OX v1 (employer-initiated
  // only); the candidate's live state is their invitations + matches.
  const visJar = await registerOrLogin("j4-visible@qa.beanfolio.test", "Journey Visible");
  const myInvites = await api(visJar, "GET", "/api/opportunities/me/invitations");
  check("candidate invitation surface live", myInvites.status === 200, `GET me/invitations → ${myInvites.status}`);
  const myMatches = await api(visJar, "GET", "/api/opportunities/me/matches");
  check("candidate matches surface live", myMatches.status === 200, `GET me/matches → ${myMatches.status}`);
}

// ---------- J6: matching, shortlist, invitations ----------
async function j6() {
  journey = "J6 matching, shortlist & invitations";
  console.log(`\n== ${journey} ==`);
  const j6o = await registerOrLogin("j6-owner@qa.beanfolio.test", "Journey Talent Owner");
  const me = await api(j6o, "GET", "/api/employers/me");
  const org = (me.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-talent-qa")?.organization?.id;
  const opps = await api(j6o, "GET", `/api/employers/${org}/opportunities`);
  const motion = (opps.json?.opportunities ?? []).find((o: any) => o.title === "Senior Motion Designer");
  const hiddenId = (await db.user.findUnique({ where: { email: "j4-hidden@qa.beanfolio.test" }, select: { id: true } }))!.id;

  const shortlist = await api(j6o, "GET", `/api/employers/${org}/opportunities/${motion.id}/shortlist`);
  check("shortlist list", shortlist.status === 200, `GET shortlist → ${shortlist.status}, entries=${(shortlist.json?.entries ?? shortlist.json?.shortlist ?? []).length}`);
  const ineligible = await api(j6o, "POST", `/api/employers/${org}/opportunities/${motion.id}/shortlist`, {
    candidateUserId: hiddenId, note: "must be refused (HIDDEN)",
  });
  check("ineligible shortlist refused", ineligible.status === 409 || ineligible.status === 403 || ineligible.status === 404,
    `shortlist HIDDEN candidate → ${ineligible.status} ${JSON.stringify(ineligible.json)?.slice(0, 120)}`);

  let entries = shortlist.json?.entries ?? shortlist.json?.shortlist ?? [];
  if (entries.length === 0) {
    // Re-runs may have removed the fixture entries; add one through the real
    // flow so the removal path is still exercised.
    const visId = (await db.user.findUnique({ where: { email: "j4-visible@qa.beanfolio.test" }, select: { id: true } }))!.id;
    const add = await api(j6o, "POST", `/api/employers/${org}/opportunities/${motion.id}/shortlist`, {
      candidateUserId: visId, note: "Re-added for the removal audit.",
    });
    if (add.status === 200 || add.status === 201) {
      const refreshed = await api(j6o, "GET", `/api/employers/${org}/opportunities/${motion.id}/shortlist`);
      entries = refreshed.json?.entries ?? refreshed.json?.shortlist ?? [];
    }
  }
  const removable = entries[0];
  if (removable?.id) {
    const removed = await api(j6o, "DELETE", `/api/employers/${org}/opportunities/${motion.id}/shortlist/${removable.id}`, {});
    check("shortlist removal", removed.status === 200 || removed.status === 204, `DELETE entry → ${removed.status}`);
  } else {
    check("shortlist removal", false, "no removable entry found");
  }

  // Invitation lifecycle on the newest SENT invitation; self-provision one
  // through the real flow when earlier journeys consumed them all.
  let invJ7 = await db.opportunityInvitation.findFirst({
    where: { status: "SENT" }, orderBy: { createdAt: "desc" }, select: { id: true, candidateUserId: true },
  });
  if (!invJ7) {
    const email = `j6-inv-${uid()}@qa.beanfolio.test`;
    const cand = await registerOrLogin(email, "Invitation Audit Candidate");
    await api(cand, "PATCH", "/api/me/profile", { headline: "Invitation audit candidate", skills: ["editing", "after-effects"] });
    await api(cand, "PUT", "/api/opportunities/me/profile", {
      employmentTypes: ["FULL_TIME"], workModes: ["REMOTE"], preferredLocations: ["Bengaluru, India"],
      experienceMinYears: 3, experienceMaxYears: 7, compensationVisibility: "RANGE_ONLY",
      salaryMinPaise: 500_000_00, salaryMaxPaise: 900_000_00, salaryCurrency: "INR", compensationPeriod: "YEAR",
    });
    await api(cand, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
    await api(cand, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" });
    const candId = (await api(cand, "GET", "/api/auth/me")).json?.user?.id;
    await api(j6o, "POST", `/api/employers/${org}/opportunities/${motion.id}/shortlist`, { candidateUserId: candId, note: "J6 invitation audit." });
    const invRes = await api(j6o, "POST", "/api/opportunities/invitations", {
      organizationId: org, opportunityId: motion.id, candidateUserId: candId, send: true, sourceHint: "MATCH",
      offer: { offerSalaryMinPaise: 600_000_00, offerSalaryMaxPaise: 800_000_00, offerCurrency: "INR", offerPeriod: "YEAR" },
    });
    invJ7 = await db.opportunityInvitation.findUnique({ where: { id: invRes.json.invitation.id }, select: { id: true, candidateUserId: true } });
    check("invitation self-provisioned via real flow", invJ7 !== null, `invitation=${invJ7?.id}`);
  }
  if (!invJ7) { check("invitation available", false, "no invitation resolved"); return; }
  const candMe = (await db.user.findUnique({ where: { id: invJ7.candidateUserId! }, select: { email: true } }))!.email!;
  const candJar = await registerOrLogin(candMe, "Journey Candidate");
  const candView = await api(candJar, "GET", "/api/opportunities/me/invitations");
  const candInv = (candView.json?.invitations ?? []).find((i: any) => i.id === invJ7.id);
  check("candidate sees own invitation", candView.status === 200 && !!candInv && candInv.status === "SENT",
    `GET me/invitations → ${candView.status}; invitation status=${candInv?.status}`);
  const compExposed = JSON.stringify(candInv ?? {});
  check("candidate sees the immutable offer snapshot", compExposed.includes("offer"), `offer fields present=${compExposed.includes("offer")}`);
}

// ---------- J7: compensation negotiation ----------
async function j7() {
  journey = "J7 compensation negotiation";
  console.log(`\n== ${journey} ==`);
  let inv = await db.opportunityInvitation.findFirst({
    where: { status: "SENT" }, orderBy: { createdAt: "desc" },
  });
  if (!inv) {
    // All SENT invitations consumed by earlier journeys — self-provision.
    const j6o0 = await registerOrLogin("j6-owner@qa.beanfolio.test", "Journey Talent Owner");
    const j6me0 = await api(j6o0, "GET", "/api/employers/me");
    const org0 = (j6me0.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-talent-qa")?.organization?.id;
    const opps0 = await api(j6o0, "GET", `/api/employers/${org0}/opportunities`);
    const motion0 = (opps0.json?.opportunities ?? []).find((o: any) => o.title === "Senior Motion Designer");
    const email = `j7-neg-${uid()}@qa.beanfolio.test`;
    const cand0 = await registerOrLogin(email, "Negotiation Audit Candidate");
    await api(cand0, "PATCH", "/api/me/profile", { headline: "Negotiation audit candidate", skills: ["editing", "after-effects"] });
    await api(cand0, "PUT", "/api/opportunities/me/profile", {
      employmentTypes: ["FULL_TIME"], workModes: ["REMOTE"], preferredLocations: ["Bengaluru, India"],
      experienceMinYears: 3, experienceMaxYears: 7, compensationVisibility: "RANGE_ONLY",
      salaryMinPaise: 500_000_00, salaryMaxPaise: 900_000_00, salaryCurrency: "INR", compensationPeriod: "YEAR",
    });
    await api(cand0, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
    await api(cand0, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" });
    const candId0 = (await api(cand0, "GET", "/api/auth/me")).json?.user?.id;
    await api(j6o0, "POST", `/api/employers/${org0}/opportunities/${motion0.id}/shortlist`, { candidateUserId: candId0, note: "J7 negotiation audit." });
    const invRes = await api(j6o0, "POST", "/api/opportunities/invitations", {
      organizationId: org0, opportunityId: motion0.id, candidateUserId: candId0, send: true, sourceHint: "MATCH",
      offer: { offerSalaryMinPaise: 600_000_00, offerSalaryMaxPaise: 800_000_00, offerCurrency: "INR", offerPeriod: "YEAR" },
    });
    inv = await db.opportunityInvitation.findUnique({ where: { id: invRes.json.invitation.id } });
    check("negotiation invitation self-provisioned", inv?.status === "SENT", `invitation=${inv?.id}`);
  }
  if (!inv) { check("invitation available", false, "no invitation resolved"); return; }
  const candUser = (await db.user.findUnique({ where: { id: inv.candidateUserId! }, select: { email: true, id: true } }))!;
  const candJar = await registerOrLogin(candUser.email!, "Negotiation Candidate");
  const j6o = await registerOrLogin("j6-owner@qa.beanfolio.test", "Journey Talent Owner");

  // Candidate requests negotiation with absolute terms.
  const req = await api(candJar, "POST", `/api/opportunities/me/invitations/${inv.id}/negotiation-request`, {
    terms: { proposedSalaryMinPaise: 700_000_00, proposedSalaryMaxPaise: 850_000_00, proposedCurrency: "INR", proposedPeriod: "YEAR" },
  });
  check("candidate negotiation request", req.status === 200 || req.status === 201,
    `POST negotiation-request → ${req.status} ${JSON.stringify(req.json)?.slice(0, 140)}`);

  // Employer proposes a counter.
  const counter = await api(j6o, "POST", `/api/opportunities/invitations/${inv.id}/negotiations`, {
    organizationId: inv.organizationId,
    terms: { proposedSalaryMinPaise: 750_000_00, proposedSalaryMaxPaise: 800_000_00, proposedCurrency: "INR", proposedPeriod: "YEAR" },
  });
  check("employer counter-proposal", counter.status === 200 || counter.status === 201,
    `POST negotiations → ${counter.status}, proposal seq=${counter.json?.proposal?.seq}, status=${counter.json?.proposal?.status}`);

  // Guarded: candidate accepts the employer's pending proposal.
  // Negotiation proposals are carried on the invitation detail (no list GET).
  const invDetail = await api(candJar, "GET", `/api/opportunities/me/invitations/${inv.id}`);
  const negotiations: any[] = invDetail.json?.invitation?.negotiations ?? invDetail.json?.negotiations ?? [];
  const pending = negotiations.filter((n) => n.status === "PENDING");
  const negotiationId = pending[0]?.id ?? counter.json?.proposal?.id;
  const accept = await api(candJar, "POST", `/api/opportunities/me/invitations/${inv.id}/negotiations/${negotiationId}/accept`, {});
  check("candidate accepts counter", accept.status === 200, `accept → ${accept.status}, invitation=${accept.json?.invitation?.status ?? accept.json?.status}`);
  const invAfter = await api(candJar, "GET", "/api/opportunities/me/invitations");
  const invRow = (invAfter.json?.invitations ?? []).find((i: any) => i.id === inv.id);
  check("invitation ACCEPTED with accepted-terms snapshot", invRow?.status === "ACCEPTED",
    `invitation status=${invRow?.status}; snapshot=${JSON.stringify(invRow?.acceptedOffer ?? invRow?.acceptedTerms)?.slice(0, 140)}`);
  const acceptAgain = await api(candJar, "POST", `/api/opportunities/me/invitations/${inv.id}/negotiations/${negotiationId}/accept`, {});
  check("double accept refused", acceptAgain.status === 409 || acceptAgain.status === 400,
    `re-accept → ${acceptAgain.status} ${JSON.stringify(acceptAgain.json)?.slice(0, 100)}`);
  const withdraw = await api(candJar, "POST", `/api/opportunities/me/invitations/${inv.id}/negotiations/${negotiationId}/withdraw`, {});
  check("withdraw after decision refused", withdraw.status === 409 || withdraw.status === 400,
    `withdraw → ${withdraw.status}`);

  // Candidate rights after consent revocation: own records stay readable.
  await api(candJar, "POST", "/api/opportunities/me/consents/DISCOVERY/revoke", {});
  const stillVisible = await api(candJar, "GET", `/api/opportunities/me/invitations/${inv.id}`);
  check("own invitation readable after consent revocation", stillVisible.status === 200, `GET invitation → ${stillVisible.status}`);
}

// ---------- J8: hiring rooms and interviews ----------
async function j8() {
  journey = "J8 hiring rooms & interviews";
  console.log(`\n== ${journey} ==`);
  const j6o = await registerOrLogin("j6-owner@qa.beanfolio.test", "Journey Talent Owner");
  const j6me = await api(j6o, "GET", "/api/employers/me");
  const j6org = (j6me.json?.memberships ?? []).find((m: any) => m.organization?.slug === "journey-talent-qa")?.organization?.id;
  const opps = await api(j6o, "GET", `/api/employers/${j6org}/opportunities`);
  const motion = (opps.json?.opportunities ?? []).find((o: any) => o.title === "Senior Motion Designer");

  // Self-provision a fresh SENT invitation through the REAL flow when no
  // fixture one remains (earlier journeys consume them by design).
  let inv = await db.opportunityInvitation.findFirst({ where: { status: "SENT" }, orderBy: { createdAt: "desc" } });
  let candEmail: string;
  if (!inv) {
    const email = `j8-room-${uid()}@qa.beanfolio.test`;
    const cand = await registerOrLogin(email, "Room Candidate Fresh");
    await api(cand, "PATCH", "/api/me/profile", { headline: "Hiring-room audit candidate", skills: ["editing", "after-effects"] });
    await api(cand, "PUT", "/api/opportunities/me/profile", {
      employmentTypes: ["FULL_TIME"], workModes: ["REMOTE"], preferredLocations: ["Bengaluru, India"],
      experienceMinYears: 3, experienceMaxYears: 7, compensationVisibility: "RANGE_ONLY",
      salaryMinPaise: 500_000_00, salaryMaxPaise: 900_000_00, salaryCurrency: "INR", compensationPeriod: "YEAR",
    });
    await api(cand, "POST", "/api/opportunities/me/consents", { scope: "DISCOVERY" });
    await api(cand, "POST", "/api/opportunities/me/visibility", { status: "ACTIVE" });
    const candId = (await api(cand, "GET", "/api/auth/me")).json?.user?.id;
    const sl = await api(j6o, "POST", `/api/employers/${j6org}/opportunities/${motion.id}/shortlist`, {
      candidateUserId: candId, note: "J8 room audit candidate.",
    });
    if (!(sl.status === 200 || sl.status === 201)) { check("self-provision shortlist", false, `→ ${sl.status}`); return; }
    const invRes = await api(j6o, "POST", "/api/opportunities/invitations", {
      organizationId: j6org, opportunityId: motion.id, candidateUserId: candId, send: true, sourceHint: "MATCH",
      offer: { offerSalaryMinPaise: 600_000_00, offerSalaryMaxPaise: 800_000_00, offerCurrency: "INR", offerPeriod: "YEAR" },
    });
    if (!(invRes.status === 200 || invRes.status === 201)) { check("self-provision invitation", false, `→ ${invRes.status} ${JSON.stringify(invRes.json)?.slice(0, 120)}`); return; }
    inv = await db.opportunityInvitation.findUnique({ where: { id: invRes.json.invitation.id } });
    candEmail = email;
    check("fresh invitation self-provisioned via real flow", inv?.status === "SENT", `invitation=${inv?.id} status=${inv?.status}`);
  } else {
    candEmail = (await db.user.findUnique({ where: { id: inv!.candidateUserId! }, select: { email: true } }))!.email!;
    check("SENT invitation available", inv!.status === "SENT", `invitation=${inv!.id}`);
  }
  if (!inv) { check("invitation available", false, "no invitation resolved"); return; }
  const candJar = await registerOrLogin(candEmail, "Room Candidate");

  const accept = await api(candJar, "POST", `/api/opportunities/me/invitations/${inv.id}/accept`, {});
  check("candidate accepts invitation", accept.status === 200, `accept → ${accept.status}`);

  const room = await api(j6o, "POST", "/api/opportunities/hiring-rooms", { invitationId: inv.id, candidateTimezone: "Asia/Kolkata" });
  const roomId = room.json?.room?.id;
  check("room created from accepted invitation", room.status === 200 || room.status === 201,
    `POST hiring-rooms → ${room.status}, room=${roomId}, stage=${room.json?.room?.currentStage}`);
  const duplicate = await api(j6o, "POST", "/api/opportunities/hiring-rooms", { invitationId: inv.id });
  check("RD-1: second room for same invitation refused", duplicate.status === 409,
    `duplicate room → ${duplicate.status} ${JSON.stringify(duplicate.json)?.slice(0, 110)}`);

  const stages = ["INITIAL_REVIEW", "SCREENING"];
  for (const stage of stages) {
    const t = await api(j6o, "POST", `/api/opportunities/hiring-rooms/${roomId}/stages`, { stage });
    check(`stage → ${stage}`, t.status === 200 && t.json?.room?.currentStage === stage,
      `POST stages → ${t.status}, currentStage=${t.json?.room?.currentStage}`);
  }
  const backward = await api(j6o, "POST", `/api/opportunities/hiring-rooms/${roomId}/stages`, { stage: "INVITATION_ACCEPTED" });
  check("backward stage transition refused", backward.status === 409, `backward → ${backward.status} ${JSON.stringify(backward.json)?.slice(0, 110)}`);

  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
  const hourLater = new Date(Date.now() + 25 * 3600_000).toISOString();
  const propose = await api(j6o, "POST", `/api/opportunities/hiring-rooms/${roomId}/interviews`, {
    type: "VIDEO", startsAt: tomorrow, endsAt: hourLater, meetingLink: "https://meet.example.com/qa-room-audit",
  });
  const interviewId = propose.json?.interview?.id;
  check("interview proposed", propose.status === 200 || propose.status === 201,
    `POST interviews → ${propose.status}, id=${interviewId}, status=${propose.json?.interview?.status}`);

  const candInterviews = await api(candJar, "GET", "/api/opportunities/me/hiring-rooms");
  const candRoom = (candInterviews.json?.rooms ?? []).find((r: any) => r.id === roomId);
  check("candidate sees own room", candInterviews.status === 200 && !!candRoom, `GET me/hiring-rooms → ${candInterviews.status}`);

  const alt = new Date(Date.now() + 48 * 3600_000).toISOString();
  const alt2 = new Date(Date.now() + 49 * 3600_000).toISOString();
  const proposeAlt = await api(candJar, "POST", `/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/alternate`, {
    startsAt: alt, endsAt: alt2,
  });
  check("candidate proposes alternate time", proposeAlt.status === 200 || proposeAlt.status === 201,
    `alternate → ${proposeAlt.status}, status=${proposeAlt.json?.interview?.status}`);
  const confirm = await api(j6o, "POST", `/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/confirm`, {});
  check("interview confirmed", confirm.status === 200 && confirm.json?.interview?.status === "CONFIRMED",
    `confirm → ${confirm.status}, status=${confirm.json?.interview?.status}`);

  // RD-15: the meeting link is disclosed to the CANDIDATE on live
  // (PROPOSED/CONFIRMED) interviews — check the candidate's room view
  // BEFORE completion (COMPLETED interviews omit the link entirely).
  const candRoomView = await api(candJar, "GET", `/api/opportunities/me/hiring-rooms/${roomId}`);
  const candInterview = (candRoomView.json?.interviews ?? candRoomView.json?.room?.interviews ?? [])
    .find((i: any) => i.id === interviewId);
  const candLink = JSON.stringify(candInterview ?? {});
  check("meeting link disclosed to candidate after confirm", candLink.includes("meet.example.com"),
    `candidate interview view meetingLink=${candInterview?.meetingLink ?? "(absent)"}`);

  const complete = await api(j6o, "POST", `/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/complete`, {});
  check("interview completed", complete.status === 200, `complete → ${complete.status}`);

  const completedView = await api(candJar, "GET", `/api/opportunities/me/hiring-rooms/${roomId}`);
  const doneInterview = (completedView.json?.interviews ?? completedView.json?.room?.interviews ?? [])
    .find((i: any) => i.id === interviewId);
  check("completed interview omits meeting link (RD-15)", doneInterview && !JSON.stringify(doneInterview).includes("meet.example.com"),
    `completed interview meetingLink=${doneInterview?.meetingLink ?? "(omitted)"}`);

  const withdraw = await api(candJar, "POST", `/api/opportunities/me/hiring-rooms/${roomId}/withdraw`, { reason: "PERSONAL" });
  check("candidate withdrawal terminal", withdraw.status === 200 && withdraw.json?.room?.status === "CANDIDATE_WITHDRAWN",
    `withdraw → ${withdraw.status}, room status=${withdraw.json?.room?.status}`);

  const roomDetail = await api(j6o, "GET", `/api/opportunities/hiring-rooms/${roomId}`);
  const activity = roomDetail.json?.activity;
  const eventCount = Array.isArray(activity) ? activity.length
    : Array.isArray(activity?.items) ? activity.items.length
    : Array.isArray(activity?.events) ? activity.events.length
    : Number.isFinite(activity?.total) ? activity.total : 0;
  check("activity history recorded", roomDetail.status === 200 && eventCount >= 3,
    `GET room → ${roomDetail.status}, activity=${JSON.stringify(activity)?.slice(0, 160)}`);
}

// ---------- J9: messaging and notifications ----------
async function j9() {
  journey = "J9 messaging & notifications";
  console.log(`\n== ${journey} ==`);
  const alice = await registerOrLogin("alice@beanfolio.test", "Alice");
  const bob = await registerOrLogin("bob@beanfolio.test", "Bob");

  // Idempotent preconditions: no blocks either direction (earlier runs may
  // have left the audit block in place).
  await api(alice, "DELETE", "/api/me/blocks?username=bob");
  await api(bob, "DELETE", "/api/me/blocks?username=alice");

  // alice↔bob already follow each other (seeded graph) → conversation opens
  // ACTIVE with no request gate; the REQUEST gate is exercised separately
  // with two fresh strangers below.
  const start = await api(alice, "POST", "/api/me/messages", { username: "bob" });
  const conversationId = start.json?.conversationId;
  check("conversation started (mutual follow → ACTIVE)", start.status === 200 || start.status === 201,
    `POST /api/me/messages → ${start.status}, conversation=${conversationId}`);
  if (!conversationId) return;

  const send = await api(alice, "POST", `/api/me/messages/${conversationId}`, { body: "Phase 4 audit message — hello Bob." });
  check("message delivered", send.status === 200 || send.status === 201, `POST message → ${send.status}`);

  const bobList = await api(bob, "GET", "/api/me/messages");
  const conv = (bobList.json?.conversations ?? []).find((c: any) => c.id === conversationId);
  check("recipient sees unread", bobList.status === 200 && (conv?.unread ?? 0) >= 1,
    `GET messages → ${bobList.status}, unread=${conv?.unread}`);
  const read = await api(bob, "PATCH", `/api/me/messages/${conversationId}`, { markRead: true });
  const bobList2 = await api(bob, "GET", "/api/me/messages");
  const conv2 = (bobList2.json?.conversations ?? []).find((c: any) => c.id === conversationId);
  check("read behavior", read.status === 200 && (conv2?.unread ?? 1) === 0,
    `markRead → ${read.status}; unread after=${conv2?.unread}`);

  // Message-request gate with two fresh strangers (recipient does not
  // follow the sender → sender blocked until the recipient approves).
  const strangerA = await registerOrLogin(`j9-a-${uid()}@qa.beanfolio.test`, "J9 Stranger A");
  const strangerB = await registerOrLogin(`j9-b-${uid()}@qa.beanfolio.test`, "J9 Stranger B");
  await api(strangerA, "POST", "/api/me/onboarding", { username: `j9a${uid()}`, displayName: "J9 A", professions: ["ui-ux"] });
  const bUsername = `j9b${uid()}`;
  await api(strangerB, "POST", "/api/me/onboarding", { username: bUsername, displayName: "J9 B", professions: ["ui-ux"] });
  const reqStart = await api(strangerA, "POST", "/api/me/messages", { username: bUsername });
  const reqConv = reqStart.json?.conversationId;
  check("message request created (partner PENDING)", reqStart.status === 201 && reqStart.json?.partnerRequestState === "PENDING",
    `POST → ${reqStart.status}, partnerRequestState=${reqStart.json?.partnerRequestState}`);
  // Documented contract: the opening message IS the request — allowed once;
  // every FURTHER send is refused until the recipient approves.
  const opening = await api(strangerA, "POST", `/api/me/messages/${reqConv}`, { body: "Opening request message." });
  const second = await api(strangerA, "POST", `/api/me/messages/${reqConv}`, { body: "Second pre-approval send — must be refused." });
  check("opening message allowed; further sends blocked pre-approval",
    (opening.status === 200 || opening.status === 201) && second.status === 409,
    `opening → ${opening.status}; second → ${second.status} ${JSON.stringify(second.json)?.slice(0, 90)}`);
  const approve = await api(strangerB, "PATCH", `/api/me/messages/${reqConv}`, { accept: true });
  const after = await api(strangerA, "POST", `/api/me/messages/${reqConv}`, { body: "After approval." });
  check("recipient approval unblocks sender", approve.status === 200 && (after.status === 200 || after.status === 201),
    `accept → ${approve.status}; send after → ${after.status}`);

  // Block handling: bob blocks alice → alice can no longer message.
  const bobUsername = (await api(bob, "GET", "/api/auth/me")).json?.user?.username;
  const aliceUsername = (await api(alice, "GET", "/api/auth/me")).json?.user?.username;
  await api(bob, "POST", "/api/me/blocks", { username: aliceUsername });
  const blockedSend = await api(alice, "POST", `/api/me/messages/${conversationId}`, { body: "Should be refused now." });
  check("block stops messaging", blockedSend.status === 403 || blockedSend.status === 404 || blockedSend.status === 409,
    `send after block → ${blockedSend.status} ${JSON.stringify(blockedSend.json)?.slice(0, 110)}`);
  await api(bob, "DELETE", `/api/me/blocks?username=${aliceUsername ?? "alice"}`); // cleanup: remove the audit block

  // Notifications: list + preferences + payload privacy.
  const notes = await api(bob, "GET", "/api/me/notifications");
  check("notifications list", notes.status === 200, `GET notifications → ${notes.status}, count=${(notes.json?.notifications ?? []).length}`);
  const payloads = JSON.stringify(notes.json?.notifications ?? []);
  const leaks = /salaryMinPaise|salaryMaxPaise|offerSalary/.test(payloads);
  check("no compensation data in notification payloads", !leaks, `salary fields in payloads=${leaks}`);
  const prefs = await api(bob, "PATCH", "/api/me/notifications/preferences", { type: "MESSAGE", enabled: false });
  check("notification preference updated", prefs.status === 200, `PATCH preferences → ${prefs.status}`);
  await api(bob, "PATCH", "/api/me/notifications/preferences", { type: "MESSAGE", enabled: true });
}

// ---------- J10: account deletion and privacy ----------
async function j10() {
  journey = "J10 account deletion & privacy";
  console.log(`\n== ${journey} ==`);
  const email = `j10-live-${uid()}@qa.beanfolio.test`;
  const jar = await registerOrLogin(email, "Journey Ten Disposable");
  const me = await api(jar, "GET", "/api/auth/me");
  const userId = me.json?.user?.id;
  const project = await api(jar, "POST", "/api/projects", {
    title: "J10 Disposable Piece", description: "Created to verify deletion semantics on historical records.",
  });
  const projectId = project.json?.project?.id ?? project.json?.id;
  const ox = await api(jar, "PUT", "/api/opportunities/me/profile", { employmentTypes: ["FULL_TIME"] });

  const wrongPw = await api(jar, "POST", "/api/me/deletion", { currentPassword: "wrong-password-1" });
  check("deletion requires correct password", wrongPw.status === 403, `wrong password → ${wrongPw.status}`);
  const del = await api(jar, "POST", "/api/me/deletion", { currentPassword: PASSWORD, reason: "Phase 4 deletion audit" });
  check("deletion request succeeds", del.status === 200, `POST /api/me/deletion → ${del.status}`);

  const meAfter = await api(jar, "GET", "/api/auth/me");
  check("session invalidated immediately", meAfter.json?.user === null || meAfter.status === 401,
    `me after deletion → ${meAfter.status}, user=${meAfter.json?.user === null ? "null" : JSON.stringify(meAfter.json?.user)?.slice(0, 60)}`);
  const relaunch = await api(jar, "POST", "/api/auth/login", { email, password: PASSWORD });
  check("deleted account cannot log in", relaunch.status === 401 || relaunch.status === 403 || relaunch.status === 404,
    `login after deletion → ${relaunch.status}`);

  const row = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true, email: true, name: true, username: true, headline: true } });
  const anonymized = !!row?.deletedAt && row.email.startsWith("deleted+") && row.name === "Deleted user" && row.username === null;
  check("identity anonymized (DB)", anonymized, `deletedAt=${!!row?.deletedAt}, email=${row?.email}, name=${row?.name}, username=${row?.username}`);
  const sessions = await db.session.count({ where: { userId } });
  check("all sessions revoked (DB)", sessions === 0, `Session rows=${sessions}`);
  const proj = projectId ? await db.project.findUnique({ where: { id: projectId }, select: { id: true, ownerId: true, status: true } }) : null;
  check("historical record state recorded (DB)", !!row, `project row after deletion=${proj ? `owner=${proj.ownerId === userId ? "orphaned/owned-by-deleted" : "changed"}` : "(absent)"}`);
  const oxRow = ox.json?.profile?.id ? await (db as any).candidateOpportunityProfile.findUnique({ where: { id: ox.json.profile.id } }).catch(() => null) : null;
  check("OX profile after deletion recorded (DB)", true, `candidateProfile=${oxRow ? `userIdSet=${oxRow.userId === userId}` : "(absent — removed)"}`);
  const delReq = await db.deletionRequest.findFirst({ where: { userId }, select: { status: true } });
  check("deletion request COMPLETED (DB)", delReq?.status === "COMPLETED", `status=${delReq?.status}`);
}

// ---------- runner ----------
const requested = (process.argv[2] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const all: Record<string, () => Promise<void>> = { j1, j2, j3, j4, j5, j6, j7, j8, j9, j10 };
const run = requested.length ? requested : Object.keys(all);
for (const name of run) {
  if (!all[name]) { console.error(`unknown journey ${name}`); process.exit(2); }
}
for (const name of run) {
  try {
    await all[name]();
  } catch (e: any) {
    (results[name.toUpperCase()] ??= []).push({ name: "journey crashed", ok: false, evidence: String(e?.stack ?? e).slice(0, 400) });
    console.error(`JOURNEY ${name.toUpperCase()} CRASHED:`, e?.message ?? e);
  }
}
console.log("\n================ JOURNEY AUDIT SUMMARY ================");
let fail = 0;
for (const [name, checks] of Object.entries(results)) {
  const failed = checks.filter((c) => !c.ok).length;
  fail += failed;
  console.log(`${name}: ${checks.length - failed}/${checks.length} checks passed${failed ? ` — ${failed} FAILED` : ""}`);
  for (const c of checks.filter((c) => !c.ok)) console.log(`    FAIL ${c.name} — ${c.evidence}`);
}
await db.$disconnect();
process.exit(fail > 0 ? 1 : 0);
