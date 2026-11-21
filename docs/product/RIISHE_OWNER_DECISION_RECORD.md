# RIISHE — Owner Decision Record (OD-1 … OD-12)

| Field | Value |
| --- | --- |
| Product | BEAN Folio |
| Assistant | RIISHE (Personal Intelligence) |
| Repository | `Ebin0471/BEAN-Folio` |
| Decision record | `docs/product/RIISHE_OWNER_DECISION_RECORD.md` |
| Decision authority | Owner instruction, 2026-11-21 (recorded verbatim in the decision table below) |
| Blueprint | `docs/product/RIISHE_AUTOMATION_AND_PORTFOLIO_INTELLIGENCE.md` |
| Blueprint revision approved | `main` @ `4cefc36a0025e80234830d76b09fe0da1f67bff4` (verified against `origin/main` via `git ls-remote` before recording) |
| Status | **APPROVED — OD-1 … OD-12 adopted on the blueprint's recommended defaults, with the five mandatory refinements in this record.** |
| Implementation authorized by this record | **B1 and B2 only** (one coordinated delivery batch). B3–B12 remain unauthorized until B1/B2 evidence is delivered and reviewed. |

## What this approval is

The owner approves the RIISHE blueprint as the product and technical direction
(OD-1) and resolves all twelve open owner decisions using the blueprint's
recommended defaults, with the explicit refinements below. The recommendations
in the blueprint's decision table are preserved verbatim in
[the blueprint's decision table](#cross-reference-to-the-blueprint-table);
any refinement is documented here and is reflected — transparently and without
rewriting the original recommendations — in the blueprint table's approval
columns.

## What this approval is NOT

Approval applies to the blueprint and its decisions. It does **not** authorize:

- production deployment, paid infrastructure, or any purchase of services;
- a PostgreSQL migration or any database change (B1/B2 make **no** schema
  migration; preferences remain KV rows in the existing `RiisheUserPreference`
  store);
- external communications of any kind (no email, push or external report
  delivery — OD-5);
- irreversible user actions beyond the blueprint's own Level-3 protection
  rules;
- B3–B12 implementation. Those batches and their approved product
  requirements remain **recorded, not unlocked**.

---

## Decision table

| ID | Decision required | Blueprint recommendation (preserved) | Owner decision | Status |
| --- | --- | --- | --- | --- |
| OD-1 | Approve the blueprint as the RIISHE product/technical direction | Approve with any scope edits; nothing proceeds until reviewed | **Approved.** The blueprint is the RIISHE product and technical direction. | APPROVED |
| OD-2 | AI quota policy for new features: one shared pool or per-feature budgets | Keep shared pool for beta; revisit at launch | **Shared AI quota for beta.** The existing text-gateway pool (6/min burst, 30/day) is unchanged. Existing LAXII image-generation caps and budget controls stay **separate** from the shared text pool. No silent quota increases. | APPROVED |
| OD-3 | Enable non-managed image providers for user-facing banner/avatar | Keep managed-only through beta (existing LAXII V1 rule) | **Managed image provider only through beta**, following the existing LAXII policy. | APPROVED |
| OD-4 | External web research tool for RIISHE | Not in v1; revisit post-launch | **Excluded from beta.** RIISHE uses verified internal knowledge and authorized user context only. | APPROVED |
| OD-5 | External delivery channel (email/push) for scheduled reports | None in v1; in-app only | **In-app scheduled reports only.** No email, push or external report delivery in beta. | APPROVED |
| OD-6 | Analytics retention windows (raw 180d / aggregates 24mo proposed) | Approve or adjust; align with account-deletion architecture | **Raw retention 180 days; aggregate retention 24 months — proposed**, implemented only after account-deletion, consent-revocation and retention safeguards are verified. Do not retain identifiable data beyond the approved purpose. | APPROVED WITH REFINEMENT (Refinement R3) |
| OD-7 | Privacy suppression threshold k | Confirm 5 for beta | **k ≥ 5** for employer and platform aggregate reports. | APPROVED WITH REFINEMENT (Refinements R1, R2) |
| OD-8 | Event storage: derivation-only vs one additive `MetricDay` table | Derivation-only acceptable for beta; `MetricDay` if cost warrants | **Derivation-only analytics for beta.** Do not add `MetricDay` (or any other analytics table) until measured query cost or latency justifies it. | APPROVED |
| OD-9 | Identity Pack scope for beta | Headline/bio/structure/skills/resume draft + report first; visuals follow | **The Professional Identity Pack includes all fourteen outputs**: headline, short + detailed biographies, portfolio structure, project/case-study drafts, skills & service categories, experience/education drafts, resume, banner, avatar, SEO suggestions, portfolio theme, contact/CTA suggestions and the completion/quality report. Assets remain reviewable drafts; nothing auto-publishes. | APPROVED WITH REFINEMENT (Refinement R4) |
| OD-10 | LAXII generation budget headroom for identity-pack usage | Model expected beta usage; raise caps deliberately, never silently | **Keep existing LAXII quotas and monetary safeguards.** Measure expected usage before proposing any increase. | APPROVED |
| OD-11 | Post-launch reconsideration trigger for an external agent framework | Adopt trigger criteria; no action now | **Continue using BEAN Folio's existing workflow engine.** Reconsider an external framework only when the documented post-launch trigger conditions (blueprint §15.3) are met. | APPROVED |
| OD-12 | RIISHE i18n | English-only for beta; i18n post-launch | **English-only beta**; localization is post-launch. | APPROVED |

---

## Mandatory refinements (binding)

The owner approves OD-1 … OD-12 **with** the following refinements. They are
product policy, binding on every batch that touches the affected surface.

### R1 — k ≥ 5 counts distinct people, never event count

The k ≥ 5 privacy rule (OD-7) counts **distinct people**, never raw event
count. A report cell is suppressed unless at least five distinct individuals
contribute to it. The rule applies to **employer and platform group reports**;
it never restricts a person's access to their **own** data. An individual's
personal report is computed from their own activity regardless of cohort size.

### R2 — Differencing and repeated-filter attack protection

Suppression must resist differencing attacks (overlapping cohorts whose
difference reveals a suppressed small group) and repeated-filter attacks
(slicing by filters until a cell isolates < k people). Mitigations required:
suppression is applied **before** model interpretation — the report's
deterministic fact bundle is built with suppression already applied, so the
interpretation layer never sees a suppressed cell's value; overlapping cohorts
must be suppressed consistently (a derived cell may not expose a value
inconsistent with a suppressed parent); repeated or correlated filter requests
that would isolate a sub-k cohort return the same suppressed representation.

### R3 — Retention respects deletion and consent (refines OD-6)

The 180-day raw / 24-month aggregate retention proposal may be implemented
only after account-deletion, consent-revocation and retention safeguards are
verified to work. The aggregate window must **never** be used to preserve
identifiable personal data beyond its permitted purpose: aggregates that remain
person-identifiable (small cohorts, direct identifiers) fall under the raw
deletion rules, not the aggregate window. Deletion of an account removes that
person's contribution from future report computation.

### R4 — Banner, avatar and resume are first-class Identity Pack outputs (refines OD-9)

Banner, avatar and resume are **first-class** outputs of the Professional
Identity Pack (OD-9). No implementation batching may silently omit them merely
because the first batches focus on response and automation infrastructure.
B1/B2 do not implement the Identity Pack; when B3+ lands, all fourteen outputs
—including banner, avatar and resume—must ship within the approved pack scope,
as reviewable drafts, over the LAXII substrate.

### R5 — User-generated content is untrusted input

User-generated content — resumes, portfolio text, uploaded files, websites —
is **untrusted input**. It must never expand RIISHE's permissions, never
bypass tool authorization, never elevate a tool's level, and never reach a
tool that the registry has not authorized. Content extracted from user files
is data for the user's own features, not instructions: prompt-injection
defenses are a standing requirement for every batch that feeds user content
into a model (B12 pins the corpus; earlier batches apply the principle).

---

## Cross-reference to the blueprint table

The blueprint's "Open owner decisions" table (§ Open owner decisions) keeps
its original recommendation column unchanged and now carries the approval
status recorded here. The two refined decisions (OD-6, OD-7, OD-9) point to
the refinements above. No recommendation text was rewritten.

## Decisions to implementation mapping (B1/B2 batch)

| Decision / refinement | Where it binds in B1/B2 |
| --- | --- |
| OD-2 | No quota changes in B1/B2; the shared `aiGate` pool (6/min, 30/day) and LAXII caps stay as-is. Automation daily action caps are a **separate** action-count control (new), not an AI-quota change. |
| OD-3 | No image-provider change in B1/B2; LAXII surfaces untouched. |
| OD-4 | RIISHE persona v2 and the response loop grant no web-research capability; no research tool is registered. |
| OD-5 | No external delivery exists in B1/B2; all automation reporting is in-app (dashboard, notifications, chat). |
| OD-6 / R3 | No analytics storage exists in B1/B2; nothing to implement yet. The requirement is recorded for the future analytics batch (B6–B11). |
| OD-7 / R1 / R2 | No group reports exist in B1/B2; recorded for B7–B11. |
| OD-8 | No `MetricDay` table and no analytics table of any kind is created in B1/B2 (derivation-only decision; B1/B2 add no schema change at all). |
| OD-9 / R4 | The Identity Pack is NOT implemented in B1/B2; no placeholder tools are registered for it. The 14-output scope is recorded as the approved pack definition. |
| OD-10 | LAXII quotas untouched in B1/B2. |
| OD-11 | B2 extends the existing `RiisheWorkflow` / registry / queue / preferences infrastructure only — no second queue, scheduler or agent platform. |
| OD-12 | All B1/B2 strings are English; no i18n plumbing is introduced. |
| R5 | B2's executor validates every tool and its params from the registry at execution time; planner output can never elevate permissions; tool inputs stay schema-bound. |

## Authorization boundary for the implementation batch

- **Authorized:** B1 (RIISHE response and tool architecture) and B2 (safe
  automation framework), implemented sequentially in one coordinated delivery.
- **Not authorized:** B3–B12, schema migrations, PostgreSQL DDL, production
  deployment, external communications, new paid services, new AI providers or
  agent frameworks.
- **Hard constraint honored:** only tools with real implementations and
  verifiable outputs are registered. Future B3–B11 tools remain unregistered
  until their implementation is authorized. No placeholder or fake tools.

---

*End of decision record. Decisions recorded 2026-11-21 from the owner
instruction; verified against `origin/main` @ `4cefc36a0025e80234830d76b09fe0da1f67bff4`.*
