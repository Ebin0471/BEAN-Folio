# BEAN Folio — Phase 4 Canonical QA Fixture Manifest

**Purpose:** make the isolated-QA journey-audit environment reproducible after
any workspace recycle. Everything in the QA database is rebuilt from the
registered migration chain + the documented seeders below — no historical
restore, no invented data.

**QA database:** `db/custom.db` in the authoritative workspace
(`/home/z/bean-folio`), reachable **only** through the fail-closed guard:

```bash
DATABASE_URL='file:/home/z/bean-folio/db/custom.db' scripts/ops/qa-db-env.sh assert --must-exist
```

Every DB-touching command pins `DATABASE_URL` inline. The inherited shell
`DATABASE_URL` (legacy workspace) is never trusted. The legacy database
(`/home/z/my-project/db/custom.db`) is never accessed.

---

## 1. Rebuild sequence (after a workspace recycle)

```bash
cd /home/z/bean-folio
git fetch origin && git checkout main          # authoritative remote main
bun install
bunx prisma generate                            # SQLite client LAST (the PG mirror overwrites the output path)
# QA schema: 100-table chain replay or `DATABASE_URL=<pinned> bunx prisma db push` on a fresh file
./ensure-dev.sh                                 # dev server :3000, pinned DATABASE_URL, upload sentinel 401

export DATABASE_URL='file:/home/z/bean-folio/db/custom.db'
scripts/ops/qa-db-env.sh assert --must-exist    # fail-closed gate before every DB touch
bun scripts/seed-professions.ts                 # taxonomy: 13 families / 221 professions / 39 specialisms
bun scripts/seed.ts                             # 8 demo users, 13 published projects + 1 draft, follows/views
bun scripts/restore-qa-fixtures.ts              # 10 canonical QA accounts (isDemo=true, qa-fixture-password)
bun scripts/seed-social-e2e.ts                  # alice/bob/carol/dave (socialtest1; dave PRIVATE)
bun scripts/set-admin.ts admin@beanfolio.test   # promote the admin fixture (no admin API by design)
bun scripts/seed-ox-journeys.ts                 # OX journey fixtures via REAL APIs (below)
```

`scripts/seed-ox-journeys.ts` is idempotent and refuses non-QA targets. It
drives the product's own HTTP APIs end-to-end (register → login → profile →
consent → visibility → org → verification → admin review → opportunity →
submit → admin approval → shortlist → invitations) and prints a JSON manifest.

## 2. Journey identities (deterministic)

Password for all `@qa.beanfolio.test` journey accounts: `qa-journey-password-1`
(canonical QA accounts use their own documented `qa-fixture-password`).

| Role | Email | Fixture state |
|---|---|---|
| Admin | `admin@beanfolio.test` | `role=ADMIN`, canonical QA account |
| J1 candidate | `j1-candidate@qa.beanfolio.test` | account + base profile (skill taxonomy rows); portfolio work is the audit |
| J4 visible | `j4-visible@qa.beanfolio.test` | OX profile ACTIVE + DISCOVERY consent; skills editing/after-effects/color-grading/typescript |
| J4 hidden | `j4-hidden@qa.beanfolio.test` | OX profile, visibility HIDDEN, consent present but display off |
| J4 revoked | `j4-revoked@qa.beanfolio.test` | OX profile; consent granted then REVOKED |
| J7 candidate | `j7-candidate@qa.beanfolio.test` | ACTIVE + consent; invitation SENT (negotiation is the audit) |
| J8 candidate | `j8-candidate@qa.beanfolio.test` | ACTIVE + consent; invitation SENT (room flow is the audit) |
| J3 owner | `j3-owner@qa.beanfolio.test` | org `Journey Labs` (slug `journey-labs-qa`) VERIFIED |
| J5 owner | `j5-owner@qa.beanfolio.test` | org `Journey Studios` (slug `journey-studios-qa`) VERIFIED |
| J6 owner | `j6-owner@qa.beanfolio.test` | org `Journey Talent` (slug `journey-talent-qa`) VERIFIED |
| J3 boundary | `j3-unverified@qa.beanfolio.test` | org `Boundary Works` (slug `boundary-works-qa`) verification deliberately left PENDING |

## 3. Opportunity Exchange fixture state

| Object | Value |
|---|---|
| Opportunity `Senior Motion Designer` | org Journey Talent, PUBLISHED, INR ₹6–9 L/yr, skills editing+after-effects REQUIRED, color-grading PREFERRED |
| Opportunity `Backend Engineer (Payments)` | org Journey Studios, PUBLISHED, INR ₹4.5–8 L/yr, skill typescript REQUIRED |
| Opportunity `Platform Engineer (Draft Fixture)` | org Journey Studios, DRAFT (lifecycle audit drives it) |
| Shortlist | j4-visible, j7, j8 on Senior Motion Designer (ACTIVE) |
| Invitations | j7 + j8 on Senior Motion Designer, SENT, offer INR ₹6–8 L/yr — deliberately left unanswered |
| Hiring rooms / interviews | none — created by the J8 audit through the real accept → room → stage → interview flow |

**Deliberately left for the audit** (not fixture state): J1 portfolio
creation/publishing, J2 privacy flips + unauthorized access, J3 Boundary Works
verification decision, J4 discovery matrix + consent revalidation, J5 draft
lifecycle + invalid transitions, J6 match transparency + shortlist
add/remove, J7 negotiation rounds, J8 room creation (RD-1) + stages +
interviews, J9 messaging/notifications, J10 account deletion (fresh disposable
identity), J11 responsive layouts.

## 4. Expected post-bootstrap counts (verified 2026-11-20)

`User 32 · Session 11 · Project 14 · MediaAsset 37 · CandidateOpportunityProfile 5 ·
EmployerOrganization 4 · EmployerMembership 4 · EmployerVerification 4 ·
Opportunity 3 · OpportunitySkill 4 · TalentMatch 3 · CandidateShortlist 3 ·
OpportunityInvitation 2 · HiringRoom 0 · Interview 0 · Profession 221 · Skill 4 ·
ProfileSkill 15 · Post 5 · Notification 5 · integrity ok · FK violations 0 ·
100 tables`

## 5. Deliberate non-restoration

The lost Phase 2/3 historical QA dataset (1,026 users / 516 invitations) is
**not** recreated — per owner directive the objective is a reliable,
reproducible QA dataset, not an invented historical restoration. Pre-bootstrap
QA database backups are retained in `/home/z/beanfolio-backups/db/` with
SHA-256 manifests (empty-schema `ec275bed…`, pre-reset `5bffac42…`).
