# BEAN Folio — Phase 5 Additional Launch Assurance

**Date:** 2026-11-21 · **Baseline:** `e52786e` · **Principle:** every claim below is
backed by a check actually executed in this phase or by a committed, green test suite
re-executed in this phase. Where assurance is NOT available, it is stated as an
unresolved risk — no certification and no external review is claimed anywhere in this
document.

**What Phase 4 did not claim, still not claimed:** no independent penetration test and
no external accessibility audit have been performed. Nothing in this document changes
that. What this phase adds: practical additional checks executed directly, plus the
consolidated unresolved-risk register.

---

## 1. Accessibility and keyboard navigation

**Executed this phase (browser, live):**
- Semantic structure verified on the primary surfaces: `navigation "Primary"` /
  `"Footer"` landmarks, `main` content, `heading` levels (h1 → h2 → h3) on home,
  auth, onboarding and the Opportunity Exchange view; notifications region exposed
  as `region "Notifications alt+T"`.
- Interactive elements are real buttons/links/comboboxes (agent-browser accessibility
  tree showed `tab`, `tabpanel`, `textbox` with labels, buttons with names); images
  carry `alt` (105 alt attributes inventoried repo-wide in the M0 audit); icons are
  `aria-hidden`.
- Keyboard: auth tablist operates as a real tablist; onboarding form completed
  end-to-end by keyboard-driven automation; focus-visible utilities exist across
  button/link components (11 app files per the M0 attribute inventory).
- Desktop 1440×900 and mobile 390×844 rendering checked with zero page errors; no
  clipping or overlap observed on the audited surfaces.

**Committed evidence (green in this phase's 90-file run):** `ox-navigation.test.ts`,
`ui-audit-regressions.test.ts`, `browser-checks.test.ts`.

**Honest limits:** no screen-reader session was performed (no assistive technology in
this environment); WCAG conformance is therefore "AA-aligned by automated and
attribute-level checks", not certified. The recorded P3 (focus outline visible but
could be higher-contrast) remains open. Color-contrast was validated in the M0 audit
at attribute level only.

## 2. Cross-tenant authorization

**Committed suites (all green in this phase's 90-file run):**
- `ox-tenant-isolation.test.ts` — organization/opportunity/room scoping (a party
  outside the room/org gets 404-deny, not data).
- `ox-opportunity-authz.test.ts`, `ox-room-routes.test.ts` (27-test security matrix
  from Phase 2), `ox-discovery-privacy.test.ts`, `ox-invitation-privacy.test.ts`,
  `ox-candidate-transparency.test.ts` — object-level authorization + serialization
  allowlists (VIEWER compensation withheld, employer-private notes never serialized).
- `security-hardening.test.ts` (8/8), `workspace-origin.test.ts`,
  `auth.test.ts` + `auth-routes.test.ts` (session/auth contract).

**Executed live this phase:** the 97-check journey auditor re-run — including J2
(unauthorized access + direct-URL privacy flips), J4 (consent revalidation on every
discovery read + revocation hiding profiles instantly), J6 (eligibility enforcement),
J8 (room party authorization), J9 (messaging consent gate — the P1-1 fix verified
again), J10 (deletion revokes sessions, anonymizes identity). All green.

**Honest limits:** authorization was tested from the product's own surfaces and API
contract, not by an adversarial actor with fuzzing tools. No IDOR-fuzzing campaign
was run; the IDOR class is covered only at the audited endpoints.

## 3. Session and account security

- Cookie flags verified in source (`httpOnly`, `SameSite=lax` default /
  `none+Secure` gateway mode, `secure` via `SESSION_SECURE_COOKIES`/auto-HTTPS) and
  observed live in Phase 4.
- Account lifecycle verified live by J10 this phase (wrong-password refusal 403;
  deletion completes; login after deletion 401; all sessions revoked; identity
  anonymized).
- Rate limiting on auth endpoints observed FIRING live this phase (register
  bursts → 429/409 with Retry-After) — limits are real, not just configured.
- Recovery-key flow and password-reset contract covered by `auth.test.ts` /
  `auth-routes.test.ts` (green).

**Honest limits:** scrypt cost parameters below OWASP-2024 guidance and logout
without origin check remain documented M-7 Tier-C items. No credential-stuffing or
session-fixation campaigns were run.

## 4. Upload and download access

- Upload authorization: anonymous → 401 (live sentinel this phase); owner-scoped
  keys; content sniffing enforces declared kind; ownership re-verified on complete.
- Download ladder: delivery only via `/api/media/:id/raw` authorization (anonymous
  403 / foreign 403 / owner 200 — Phase 4 probe; `media-direct.test.ts` 11/11 green
  this phase). Private bucket posture preserved.
- **Honest limit:** presign path verified against a local S3-compatible fake only;
  real-bucket smoke test is a deploy-time item.

## 5. Privacy and data exposure

- Default-private profile posture + explicit-consent discovery verified by J2/J4
  (14 checks green this phase); consent re-validated on every discovery read;
  revocation takes effect immediately (J4 + J2 live evidence).
- Serializer allowlists (employer-private notes, VIEWER compensation, salary privacy)
  verified by the ox privacy/transparency suites (green).
- Shared-cache private-key refusal (private payloads can never enter the shared
  store) verified by `shared-cache.test.ts` 12/12 (green).
- Viewer-dependent profile API: `Cache-Control: private, no-store` (P3 delivery,
  re-verified by `p3-public-meta.test.ts` 5/5 green).
- Notification payloads minimal (no private data — RD-18 verification, J8/J9 green).

## 6. Production-build behavior

- `bunx next build` → **exit 0** this phase on the authoritative baseline (route
  manifest produced; middleware/proxy present; only pre-existing instrumentation
  warnings). Combined with tsc 0 errors, the production artifact builds cleanly.
- Runtime production behavior (standalone server under real TLS) was NOT exercised —
  it requires the deployment environment and remains a go-live checklist item.

## 7. Mobile browser compatibility

- Live checks this phase at 390×844: home and Opportunity Exchange render fully,
  bottom navigation present, no clipped/overlapping controls, zero console/page
  errors. Phase 4's J11 additionally covered onboarding, candidate/employer panels,
  profile, empty states, score-transparency expander at 1440×900 + 390×844.
- Real-device testing (iOS Safari, Android Chrome) has NOT been performed — the
  sandbox has only a Chromium-class headless browser. Recorded as a beta-task: the
  first cohort's own devices are the practical compatibility test.

---

## 8. Unresolved-risk register (P0–P3, complete as of 2026-11-21)

| ID | Severity | Risk | Mitigation / status |
|---|---|---|---|
| R-1 | P0 | **None known.** No critical security, data-loss or launch-blocking defect is open on the audited baseline. | 97/97 journeys + full suite + build + parity + integrity all green |
| R-2 | P1 | **None open.** P1-1 (message-request consent gate) was found and fixed in `e52786e` and re-verified live this phase (J9 green; `social-network` 30/30). | closed |
| R-3 | P2 | **None known** on product surfaces. Nearest P2-class operational item: no external uptime monitoring exists (G-1 in `PHASE5_OPERATIONAL_READINESS.md`) — an operator action, not a product defect. | owner action before first cohort |
| R-4 | P3 | Match-card pseudonym labels show truncated ids (privacy-correct but unpolished). | post-launch candidate |
| R-5 | P3 | Keyboard focus outline visible but could be higher-contrast. | post-launch polish |
| R-6 | P3 | `queue-reliability` timing-sensitive invariant in one-process full-suite runs (claim atomicity held in every observation; batched/focused runs green). | test-infra classification |
| R-7 | P3 | Two `auth.test` invariants encode accumulated-DB state; canonical QA bootstrap restores them on a fresh workspace. | test-infra classification |
| R-8 | P3 | CSP not deployed (M-1, documented Tier-C deferral — redesign-adjacent). | owner decision |
| R-9 | P3 | Rate-limit shared backend not default (HP-3; correct for single-instance beta). | swap when >1 instance |
| R-10 | P3 | scrypt cost below OWASP-2024 guidance; logout lacks origin check (M-7). | Tier-C follow-up |
| R-11 | P3 | No screen-reader/AT session; no real-device mobile pass; no adversarial fuzzing — assurance limited to automated + manual checks described above. | beta cohorts provide real-device signal; external audit remains owner's optional purchase |

**Register rule:** every beta-reported issue is appended here with severity, evidence
and status before any fix is attempted.

## 9. Explicit non-claims

- No penetration test, no bug bounty, no external security review.
- No WCAG certification; no assistive-technology conformance statement.
- No capacity claim above 100 concurrent virtual users (max measured, 2 vCPU sandbox,
  2026-11-07 record; staging k6 plan exists and remains unexecuted).
- No claim that the presigned-upload path works against a real cloud bucket (verified
  against a local S3-compatible fake; AWS SDK owns signatures).
