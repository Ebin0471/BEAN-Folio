# BEAN Folio — Phase 5 Controlled Private Beta Plan

**Status:** PREPARED (2026-11-21) — implementation-ready, awaiting owner approval.
**Hard boundaries:** no real people invited, no external communications sent and no launch
announcements made without separate owner authorization. No PostgreSQL migration, no
production deployment. No new product features: beta tooling is deliberately NOT built
into the product — feedback, triage and cohort management are manual owner-side processes
using existing product functionality only.

**Product basis:** the Phase 4 audit baseline at `e52786e` — 97/97 live-HTTP journey
checks (J1–J10), desktop+mobile browser acceptance with zero console errors, one P1
fixed and re-verified, no open P0/P2. Re-verified in this workspace on 2026-11-21
(97/97 again; full suite 90 files / 1371 tests / 0 failures; build exit 0; parity 100).

---

## 1. Beta objectives

Validate, with real (but controlled) users, the three claims the internal audit can
prove only partially:

1. **Candidates** can create a credible portfolio, opt in to discovery through explicit
   consent, and move through invitation → negotiation → hiring room → interview without
   confusion or dead ends.
2. **Employers** can register an organization, pass verification, publish an opportunity,
   run discovery/shortlist/invitations and operate a hiring room without support escape
   hatches.
3. **Privacy guarantees hold under real behavior**: default-private profiles, purpose-
   scoped consent, immediate revocation effect, honest data exposure at every surface.

Secondary: surface the real-world rough edges (copy, empty states, mobile ergonomics,
latency perception) that synthetic audits systematically miss.

## 2. Candidate onboarding (manual, white-glove)

No invitation codes, no email infrastructure, no self-serve signup announcement. The
owner personally sends each participant a one-time link-free instruction pack (private
message/email drafted per cohort):

- **Invite text:** what BEAN Folio is, what will be tested, the exact signup URL, the
  expectation (~30 minutes for profile + portfolio, one 20-minute feedback call after
  week 1), and the privacy one-pager (below).
- **Signup:** the product's existing real registration (`/#/auth` → Create account) with
  recovery-key capture. The owner records the participant's anonymous handle (not the
  password, never the recovery key) in the cohort tracker.
- **Profile & portfolio:** participants follow the normal J1 flow (onboarding → studio →
  first project → publish). The owner stays available for a scheduled 15-minute setup
  call during the first 48 hours instead of building in-app guidance.
- **Opportunity-profile + consent walk-through (candidates only):** a short scripted
  walk-through of the OX passport — visibility default, consent purposes, salary privacy,
  and revocation — using the real UI panels. Participants must see a live revocation
  take effect once, so the privacy promise is experienced, not just stated.
- **Time-box:** cohort 1 onboarding completes inside one week; stragglers roll to the
  next cohort rather than blocking it.

## 3. Employer onboarding and verification

- **Invite pack:** same manual pattern. Employers get two additions: the verification
  requirements list (what the admin review looks for — real organization identity,
  hiring intent) and the employer conduct note (shortlists/invitations are consent-gated;
  compensation fields are mandatory and transparent to candidates).
- **Verification flow:** employer registers organization → invites members with roles →
  submits verification → the OWNER (acting as the in-product admin) reviews and approves
  through the real admin panel (`OxAdminVerificationPanel`), or rejects with the product's
  own review notes. Deliberately: at least one cohort-1 organization is left PENDING for
  a day so the pending-state UX is observed, then approved.
- **First opportunity:** the owner coaches each employer through publishing one real
  opportunity with salary range + skills (the product enforces salary transparency; the
  coaching note explains why).

## 4. Invitation and access management (owner-side, no product changes)

- Cohort roster kept in a private owner-side tracker (spreadsheet/doc outside the repo):
  participant alias, role (candidate/employer), signup date, onboarding state, consent
  walk-through done (Y/N), feedback-call date, notes. No personal data beyond what the
  participant shares voluntarily; no passwords or recovery keys ever recorded.
- Invitations to the platform are one-time, person-to-person, and never forwarded
  publicly. If a link/instruction leaks, the owner rotates the instruction (no codes
  exist to rotate in-product) and records the incident in the beta log.
- Access revocation: an unhappy or harmful participant is asked to use the real
  self-serve account deletion flow (J10-verified: sessions revoked, identity anonymized,
  history SetNull-anonymized); the owner independently verifies the tombstone in the
  database after deletion.

## 5. Initial cohort recommendation (smallest useful)

**10 candidates + 4 employers (2 organizations, verified) — 14 people total.**

Rationale:

- **Both sides validated at minimum density.** The hiring funnel only becomes testable
  when an organization can run discovery against a small but non-trivial candidate pool:
  2–3 plausible candidates per skill cluster produce real shortlists and real
  "not selected" experiences without inflated expectations.
- **Funnel arithmetic:** 2 verified organizations × 1–2 published opportunities each →
  2–4 shortlists → 4–6 invitations → at least one negotiation round, one hiring room with
  stages + an interview, and one declined/closed path. That exercises every state of the
  O7 machine (room creation RD-1, stage transitions, interview scheduling, closures,
  notifications) inside one cohort.
- **Employer-side diversity with minimal admin load:** 2 organizations is the minimum to
  observe cross-organization isolation *as a user experience* (employer A never sees
  organization B's pipeline), not just as a test assertion.
- **White-glove ceiling:** 14 participants is the largest group one operator can onboard,
  interview and triage personally in 2–3 weeks without building support tooling.
- **Privacy signal:** 10 candidates is enough to observe consent-grant/decline/revocation
  variety (expected: most grant DISCOVERY, at least one revokes) while keeping every
  participant's exposure risk tiny.

Composition guidance (not quotas): 6–7 design/creative professionals, 2–3 engineering
professionals, 1–2 "observer" candidates who stop after profile + portfolio (the
non-OSX path must stay pleasant too). Employers: 1 founder-led org, 1 hiring-manager-led
org; at least one employer is also a product-leaning user who will notice rough UX.

## 6. User feedback collection

- **Week-1 structured call** (15–20 min, owner-run) per participant: the five questions
  below, answers captured verbatim in the tracker.
  1. What did you try first, and did anything block you?
  2. Anything that felt confusing, slow or untrustworthy?
  3. For candidates: did the consent/visibility controls make sense? For employers: did
     verification + opportunity setup make sense?
  4. What would make you return this week?
  5. Would you feel comfortable putting this portfolio/opportunity in front of a real
     counterpart? Why (not)?
- **Continuous lightweight channel:** one shared group chat (existing IM of the cohort's
  choice) for bugs and gripes; the owner triages into the P-register daily.
- **Behavioral evidence over opinions:** the owner reviews real product telemetry
  (`/api/health` counters, structured logs, audit-event rows) weekly — what users DID is
  weighted above what they say.

## 7. Bug reporting and support

- Single intake: the group chat + the feedback calls. The owner transcribes every report
  into the running `PHASE5_LAUNCH_ASSURANCE.md` risk register with severity (P0–P3) and
  a repro note. Participants never file into the repository.
- Support SLO during beta: acknowledged same day, resolved-or-scheduled within 48h.
- Support posture is manual-only: no in-app help center, no ticketing system, no new
  product surfaces for support. If the volume exceeds one operator's capacity
  (> ~20 open items), that is a beta-exit-criteria signal, not a reason to build tooling.

## 8. Incident escalation and response

| Severity | Examples | Immediate action | Follow-up |
|---|---|---|---|
| P0 — data loss / privacy breach / security | Cross-tenant data exposure, consent bypass, lost uploads | Stop new activity; do NOT modify data; capture evidence (logs, `/api/health`, DB snapshot via `scripts/ops/backup-db.ts`); notify owner | Owner-directed fix; affected participants informed honestly; register updated |
| P1 — core journey broken | Cannot register, publish, invite; hiring room stuck | Reproduce via the committed journey auditor (`scripts/qa-journeys.ts`); pin with a test; fix forward | Full regression gates before redeploy |
| P2 — important quality | Confusing state, broken layout, slow page | Log + schedule into the next beta week | Fix only if in scope and safe |
| P3 — polish | Copy, minor visual | Log in the register | Post-launch candidates |

Escalation uses the existing operational docs: `docs/ops/RUNBOOK.md` (incidents),
`docs/ops/RUNBOOK-QUEUE.md` (queue depth/dead-letter), `docs/ops/BACKUP_AND_RECOVERY.md`
(backup/restore), `docs/ops/MIGRATIONS.md` (never destructive). The owner is the sole
escalation decision-maker during beta.

## 9. Account deletion and privacy requests

- Participants are told up front: full self-serve deletion exists (`Settings → account
  deletion`), it revokes sessions immediately, anonymizes identity, and preserves
  historical records per the documented SetNull provenance (J10 evidence).
- A deletion request made out-of-band (chat message) is fulfilled by pointing the
  participant to the real flow — the owner never deletes rows by hand; direct DB
  modification is forbidden by `DEVELOPMENT_SAFETY.md` §2/§3.
- After any deletion, the owner verifies the tombstone + session revocation in the QA
  manner (read-only count checks) and records completion in the beta log.
- Data-export requests: the product exposes a real data export (`/api/me/export`);
  the owner demonstrates it once during onboarding.

## 10. Beta success metrics

Measured weekly against the cohort roster (counts are absolute, small-cohort friendly):

| Metric | Definition | Cohort-1 target |
|---|---|---|
| Onboarding completion | signup → folio published | ≥ 10/14 |
| Candidate OX activation | opportunity profile created + ≥1 consent granted | ≥ 6/10 candidates |
| Employer activation | verified org + ≥1 published opportunity | 2/2 organizations |
| Discovery→contact | ≥1 shortlist + ≥1 invitation sent by each org | 2/2 organizations |
| Funnel depth | ≥1 negotiation round AND ≥1 hiring room opened | both observed |
| Message/notification sanity | messages delivered; no lost-notification reports | 0 credible losses |
| Privacy experience | ≥1 live consent revocation observed taking effect | observed at least once |
| Unresolved P0/P1 | open at end of week | 0 |
| Support load | open triage items | ≤ 10 steady-state |
| Return usage | ≥1 return session in week 2 | ≥ 8/14 |

## 11. Criteria for expanding the beta cohort

Expand only when ALL hold simultaneously:

1. **Zero open P0/P1** for 14 consecutive days.
2. Onboarding completion ≥ 70% of the current cohort without owner hand-holding beyond
   the scheduled calls.
3. At least one full candidate-side funnel (consent → invitation → negotiation → room →
   interview/closure) and one employer-side funnel completed by REAL users without
   operator intervention.
4. No privacy/trust complaint that survived investigation (every report answered with
   evidence).
5. Support load ≤ 10 steady-state items.

Next step size: **double the cohort (→ ~20–30 participants, +2 organizations)** per step,
re-running the same manual playbook. Two clean expansion steps with stable metrics unlock
the February-2027 public-launch go/no-go review (see `PHASE5_RELEASE_CANDIDATE_CHECKLIST.md`).

## 12. Explicit non-goals during beta

- No room chat, no room document sharing, no M-O8 reporting (owner-held deferrals).
- No CSP rollout (M-1) or shared rate-limit backend switch (HP-3) unless beta evidence
  demands it — both remain documented Tier-C follow-ups.
- No redesign of any surface; fixes only for verified P0/P1.
- No PostgreSQL migration or deployment (separate owner gates — see
  `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md`).

---

## Deployment note for beta hosting

Beta participants need a reachable deployment; provisioning it is an owner-authorized
step outside this plan's scope (Tier A guidance: `docs/ops/DEPLOYMENT_TIERS.md` §Tier A).
The plan itself assumes deployment happens only after the owner approves the
`PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md` gates.
