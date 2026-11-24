# BEAN Folio — Phase 5 Release-Candidate Checklist

**Date:** 2026-11-21 · **Baseline:** `e52786e` (Phase 4 completion commit) ·
**Purpose:** single checklist defining what "beta-ready release candidate" means, what
"beta exit" means, and the February 2027 public-launch go/no-go criteria. Rule of the
house: **do not check a box you did not verify.**

**Current status: RELEASE CANDIDATE — READY FOR CONTROLLED PRIVATE BETA.**
Product functionality, UX, security posture, data integrity, performance envelope,
monitoring and recovery are verified to the levels stated below, with known limitations
listed honestly. The blocking items before the first beta cohort are operator actions
(deployment approval, uptime monitor, backup drill) — not product defects.

---

## 1. Functional completeness (verified evidence basis)

| Area | State | Evidence |
|---|---|---|
| Registration, recovery key, sessions, deletion | Complete | J1/J10 live checks (97/97 re-run 2026-11-21); auth suites green |
| Portfolio: create → media → publish → persistence | Complete | J1 11/11; browser acceptance desktop+mobile |
| Privacy: default-private, flips, unauthorized access, revocation | Complete | J2 7/7; `p3-public-meta` 5/5 |
| Employer: org, members/roles, verification workflow, pending/verified states | Complete | J3 10/10; admin panel real |
| Discovery & consent: search/filter, masking, revocation, blocks | Complete | J4 9/9; consent re-validated per read |
| Opportunities: draft→publish lifecycle, skills, salary, invalid transitions | Complete | J5 11/11 |
| Matching/shortlist/invitations: transparency, eligibility, add/remove | Complete | J6 6/6 |
| Compensation negotiation: proposals, counters, snapshots, protected transitions | Complete | J7 7/7 |
| Hiring rooms: RD-1 one-room, stages, interviews, withdrawal, closures | Complete | J8 16/16 |
| Messaging & notifications: consent gate (P1-1 fix), delivery, read state | Complete | J9 11/11; `social-network` 30/30 |
| Responsive desktop+mobile | Complete | J11 (Phase 4) + this phase's 1440×900 / 390×844 spot checks, zero errors |
| AI features (LAXII V1, RIISHE, GIFTZ) | Complete as shipped | existing suites green in the 90-file run; LAXII engine = managed provider only |

## 2. UX and mobile quality

- Design system preserved: obsidian-black + champagne-gold, verified in browser this
  phase (screenshots desktop + mobile; consistent nav, footer, bottom nav on mobile).
- Empty/loading/error states present on the audited surfaces (employer workspace shows
  structured empty states; auth gate for anonymous OX access).
- Onboarding is a real 2-step flow (identity → profession picker) — completed
  end-to-end by automation this phase.
- Known polish debt is recorded, not hidden: P3 focus-outline contrast (R-5), P3
  match-card pseudonym label (R-4).

## 3. Security and privacy

- Full-suite security coverage green this phase: security-hardening 8/8,
  ox-tenant-isolation, ox authz/room-route matrices, workspace-origin, auth contracts.
- Journey-level privacy: default-private posture, purpose-scoped consent, immediate
  revocation, serializer allowlists, minimal notification payloads — all re-verified
  live (97/97).
- Production build exits 0; headers present (nosniff, referrer-policy; CSP deferred by
  documented decision M-1).
- Honest boundary: no external penetration test, no WCAG certification, no AT session
  (`PHASE5_LAUNCH_ASSURANCE.md` §9).

## 4. Data integrity

- Schema parity 100/100 (SQLite + PostgreSQL mirror) — re-run this phase.
- QA DB: 100 tables, integrity ok, FK 0 — re-run this phase.
- DB-level invariants proven in Phase 3 and structurally present in the registered
  artifacts: RD-1 unique invitation→room, O6 one-ACTIVE-invitation per
  (org, opportunity, candidate), FK SET NULL/CASCADE semantics.
- Backup/restore tooling verified by tests and drilled (Phase 3 record).

## 5. Performance

- Measured ceiling (2026-11-07 record, honestly bounded): 100 concurrent virtual
  users / ~165 req/s browse on 2 vCPU with p95 breach at that level; p95-clean ≈50 VU.
  Beta-scale (≤30 users) is far below the measured envelope.
- Live API timings from Phase 4: 11–76 ms typical; home DCL 677 ms.
- Load limits above the measured envelope: NOT claimed; staging k6 plan ready but
  unexecuted.

## 6. Monitoring and recovery

- `/api/health` (queue depth/age, cache stats) + `/api/ready` (startup, DB) — verified
  live 2026-11-21.
- Structured JSON logs + redacted error webhook seam; error boundaries present.
- Backups: verified tooling + manifests; restore refuses unverified artifacts; drills
  on record.
- Operator actions still required before first cohort: external uptime poll (G-1) and
  a fresh `backup-all` + restore drill on the deployed environment.

## 7. User support

- Beta support model: single operator, same-day acknowledgment, 48h resolve-or-schedule
  (`PHASE5_BETA_PLAN.md` §7). In-product help center intentionally NOT built.

## 8. Known limitations (accepted, recorded)

1. In-product notifications only (no email/push) — participants must check the app.
2. Per-process rate limiter (single-instance beta topology; HP-3 swap documented).
3. CSP absent (M-1 deferral) — accepted risk, owner decision pending.
4. Presigned uploads verified against local S3 fake; real-bucket smoke pending deploy.
5. No screen-reader/real-device pass yet — beta cohorts provide this signal.
6. Workspace-recycle fragility of this sandbox (documented twice-proven recovery).
7. Deferred features by owner decision: room chat, room document sharing, M-O8
   reporting — kept out of the beta scope.

## 9. Beta entry criteria (ALL must hold — current state marked)

- [x] Release candidate verified: 97/97 journeys, full suite 0 failures, tsc 0, lint
      baseline, build exit 0, parity 100 (all re-executed 2026-11-21).
- [x] No open P0/P1 (P1-1 fixed in `e52786e`, re-verified).
- [x] Beta plan approved in writing by the owner (this document set).
- [ ] **Operator:** deployment environment approved and reachable (Gate B,
      `PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md`).
- [ ] **Operator:** fresh `backup-all` + restore drill on the deployed environment.
- [ ] **Operator:** external uptime poll configured (G-1).
- [ ] **Owner:** cohort-1 participant list (10 candidates + 4 employers) approved.

## 10. Beta exit criteria (ALL must hold to declare beta successful)

- [ ] 4 consecutive weeks with zero open P0/P1.
- [ ] ≥ 70% onboarding completion in the latest cohort without unplanned hand-holding.
- [ ] ≥ 1 full candidate funnel and ≥ 1 full employer funnel completed by real users
      (consent → invitation → negotiation → room → interview/closure), no operator
      intervention.
- [ ] ≥ 1 live consent-revocation observed taking effect; privacy complaints all
      answered with evidence.
- [ ] Support load ≤ 10 steady-state items; no unrecoverable data-loss incidents.
- [ ] Risk register (R-1…R-11) reviewed with the owner; P0/P2 count zero; every P3 has
      a post-launch or launch-blocking decision recorded.

## 11. February 2027 public-launch go/no-go criteria

**GO requires all of:**

1. Beta exit criteria met (§10) on at least one expansion step (≥ ~20–30 participants).
2. PostgreSQL migration Gate A and Deployment Gate B executed cleanly with full
   evidence (`PHASE5_POSTGRES_DEPLOYMENT_PREREQUISITES.md`), including the O2.1
   destructive-adjacent approval record.
3. Owner go/no-go review of: risk register (zero open P0/P1/P2), operational gaps
   (G-1/G-2/G-5/G-7/G-8 accepted or closed), and the P3 register (each item explicitly
   launch-blocking or not).
4. Load posture decided consciously: launch within the measured Tier-A envelope with
   queued signup/invite gating, OR a staging k6 run executed above it. (The honest
   default is queued/gated launch within the measured envelope.)
5. Support and incident processes staffed (single operator minimum, escalation ladder
   in `PHASE5_BETA_PLAN.md` §8).

**NO-GO on any of:** an open P0/P1 at review time; a data-loss or privacy incident
without a completed root-cause + fix + regression evidence; migration or deployment
gates not executed with evidence; cohort metrics regressed below §10 thresholds.

**Feature freeze:** from beta start until public launch, only verified P0/P1 defects
trigger product changes. Room chat, document sharing and M-O8 reporting remain out of
scope through launch unless the owner re-opens them explicitly.
