# Trust Onboarding + RIISHE Multi-Agent Workspace — Legal & Owner Decision Register

**Status:** M31 (2026-11) implementation record. This register documents the decisions that
remain with the repository owner. Nothing here is implemented behind the scenes: where a
decision is pending, the platform ships the SAFE DEFAULT and says so honestly in the UI.
**Privacy Policy and Terms of Service remain beta drafts with placeholder contact details
(`privacy@beanfolio.example`). No legal-finalization claims are made anywhere in the product
or the docs, and no legal-acceptance records are created against the placeholder policies.**

Related documents:

- Architecture plan: `docs/product/TRUST_ONBOARDING_AND_RIISHE_MULTI_AGENT_PLAN.md`
- Upstream components: `docs/oss/THIRD_PARTY_COMPONENTS.md`, `docs/oss/LANGGRAPH_POC_DECISION.md`
- Governance: `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md` (§4 report format), `DEVELOPMENT_SAFETY.md`

---

## 1. Implemented with safe defaults (no decision required to keep them)

| Area | Shipped default | Where |
| --- | --- | --- |
| Account identity | 4 polished identities (Career Professional / Independent Professional / Organization / Talent Partner); `User.role` (platform authorization) untouched; legacy accounts keep `primaryIdentity = null` and are never reclassified | `src/lib/identity.ts`, registration + onboarding routes |
| New-account visibility | Identity-aware registrations start `PRIVATE`; explicit user choice during onboarding may change it; existing users untouched | `src/app/api/auth/register/route.ts` |
| Email verification | `EmailVerificationToken` — SHA-256-hashed, single-use, 24 h expiry, resend cooldown 60 s, daily cap 5; delivery adapter `none` (never fabricates a send); dev-test token path refuses to run in production | `src/lib/email-verification.ts`, `src/lib/email/delivery.ts`, `src/lib/startup-validation.ts` |
| Trust gate | Identity-aware unverified accounts are blocked from external outreach / invitations / candidate contact (403 `EMAIL_VERIFICATION_REQUIRED`); legacy + demo accounts grandfathered exactly | `src/lib/identity.ts` (`requiresEmailVerification`) + gates in the inquiries/invitation routes |
| Workspace context | `bean_org` cookie is a pointer only — every resolution re-verifies ACTIVE membership server-side and fails safe to PERSONAL; cross-org access denied with 404-deny semantics | `src/lib/workspace.ts`, `/api/me/workspace/*` |
| Candidate protection | `talent.searchCandidates` requires a VERIFIED organization (OWNER/ADMIN/RECRUITER) or an approved `TrustVerification(TALENT_PARTNER_AUTHORIZED)`; the consent ledger stays authoritative; contact fields never returned; revocation respected immediately | `src/lib/riishe/specialist-tools.ts` |
| Specialist agents | 9 specialists over the ONE tool registry; planner never self-grants permissions; approval policy unchanged (Level-2/3 stays human) | `src/lib/riishe/specialists.ts` |

## 2. Owner decisions required (each with its exact unlock)

### OD-L1 — Real contact identity for the legal drafts (BLOCKER for any public launch)

- Privacy Policy / ToS placeholders: `privacy@beanfolio.example`, no legal entity named.
- **Decision:** the legal/operator identity (entity or individual), the operating address, and
  a real contact mailbox (e.g. `privacy@<real-domain>`).
- **Unlock:** owner supplies the identity + working mailbox; then the beta drafts can be
  updated and — only after owner approval — published as non-beta versions with acceptance
  records. Until then the beta banner stays and no acceptance rows are written.

### OD-L2 — Email delivery provider

- Adapter seam exists (`EMAIL_DELIVERY_ADAPTER=none|console|<provider>`); nothing pretends to send.
- **Decision:** provider (SMTP/Resend/SES or self-hosted), sending domain (SPF/DKIM), cost
  ceiling, and bounce/complaint handling. No credentials were added in this milestone.
- **Unlock:** owner chooses provider + provides credentials through the secret channel; the
  adapter interface is ready (`src/lib/email/delivery.ts`).

### OD-L3 — Trust verification review staffing

- `TrustVerification` kinds (PHONE, IDENTITY, PROFESSIONAL_CREDENTIALS, TALENT_PARTNER_AUTHORIZED)
  are human-reviewed; organization verification stays in `EmployerVerification` with review
  history. Nothing self-grants; a PENDING row is never trusted.
- **Decision:** who reviews (named people with admin access), evidence requirements per kind,
  SLA, and the appeals path.
- **Unlock:** owner names reviewers and approves the per-kind evidence checklist; review tooling
  can then be wired to the admin surface without schema change.

### OD-L4 — Data retention & deletion alignment for the new records

- New records created by M31: `OnboardingProfile` (per-identity answers), `EmailVerificationToken`,
  `TrustVerification` (evidence REFERENCES only — never document contents), identity audit events.
- **Decision:** retention windows (e.g. verification tokens are swept after expiry — the sweep
  exists; onboarding profiles and trust rows follow the user-deletion cascade today), plus whether
  account deletion also revokes organization memberships immediately.
- **Unlock:** owner approves the retention table; then the deletion/export surfaces can list the
  new record classes explicitly.

### OD-L5 — Support & abuse-report channel for agent actions

- RIISHE specialists keep everything draft-first and audited; external outreach requires email
  verification; publishing/sending stays human-approved.
- **Decision:** where recipients report unwanted contact drafted/sent through the platform, and
  who handles those reports (links to OD-L1's real contact identity).
- **Unlock:** owner defines the channel; the report/block surfaces can then reference it.

### OD-L6 — Project-wide LICENSE (deliberately NOT added in this milestone)

- The repository has no root LICENSE. Upstream components used in this milestone are MIT with
  provenance recorded in `docs/oss/THIRD_PARTY_COMPONENTS.md` (pinned versions, file-level
  reuse notes, modifications documented).
- **Decision:** whether BEAN Folio publishes a license at all, and which one. Public visibility
  does NOT by itself grant third-party reuse rights; no license was added without the owner's
  explicit choice.

### OD-L7 — Production rollout of the additive schema

- `prisma db push` for the 3 new models + 2 new columns ran ONLY against the isolated QA
  database (guard-enforced). No production DDL or migration was executed.
- **Unlock:** owner-approved deployment window per the milestone protocol (§3.1/§3.3).

## 3. Honest current limitations (documented, not hidden)

- Email verification currently completes in QA through the dev-test path; in any deployment
  without a provider, the UI states plainly that the verification email cannot be sent yet.
- Organization verification remains a reviewed process — domain matching alone never verifies.
- Talent Partner category selection during registration grants no candidate access by itself.
- The LangGraph.js adoption decision is RETAIN-the-in-repo-engine (OD-11 triggers not met);
  the PoC lives out-of-tree as the evaluated starting point.
