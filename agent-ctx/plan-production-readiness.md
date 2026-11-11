# BEAN FOLIO — Final Production Readiness + UI Defect Fix + Universal Resume Upgrade

## Verified implementation plan (written after repo inspection, before code changes)

### Inspection findings (evidence)

1. **LAXII image engine** (`src/lib/laxii/`):
   - Router `router.ts` holds 4 providers: `managed` ("LAXII Core — managed engine", backed by the
     server-side z-ai gateway via `z-ai-web-dev-sdk` `images.generations`, model `managed-image-1`),
     `gemini` ("LAXII Prisma"), `openai` ("LAXII Studio"), `diffusers` ("LAXII Local").
   - User-facing engine selector: `LaxiiStudio.tsx` lines ~1392-1419 exposes
     "LAXII Auto — best available" + all four provider labels (incl. unconfigured ones, disabled).
   - Client sends `provider` (`engine === "auto" ? undefined : engine`) → `/api/laxii/generate`
     `bodySchema.provider` accepts all four ids → `startGenerationJob` → `runLaxiiOperation({provider})`.
   - "Do not silently route" is *mostly* honored for pinned providers (resolveProvider refuses
     pinned-but-unconfigured) but NOT for `undefined` (falls to first available) and users can pin
     gemini/openai directly. Requirement: user-facing engine = LAXII V1 only.
   - `src/components/laxii/Studio.tsx` is DEAD CODE (not imported anywhere) — its provider UI is
     unreachable; no change needed but noted.
   - Avatar presets, reference images, quality selector, generation history live in LaxiiStudio —
     must be preserved.

2. **Resume builder**:
   - Schema `resume-schema.ts`: JSON-Resume-shaped zod schema (basics/work/education/skills/
     projects/certificates/awards), 8 resume types (ats, modern, minimal, creative, technical,
     fresher, experienced, role-specific), 4 visual templates (classic/modern/minimal/creative).
   - Service `resume-service.ts`: managed text gateway (never image providers), anti-fabrication
     entity guard + skill filter + one corrective retry, aiTouched diffing, conversation persistence.
   - Export `resume-export.ts`: pdfkit (selectable text) + docx, fixed section order
     Summary→Experience→Education→Skills→Projects→Certifications→Awards.
   - UI `LaxiiResumePanel.tsx` (818 lines): facts form + targeting (resume type Select w/ prior
     overflow patches) + editor + preview; columns `max-h-[calc(100dvh-16rem)]`.
   - Mount point: `LaxiiStudio.tsx` line ~1049 `<div className="min-h-0 flex-1 overflow-hidden">`.
   - Gaps vs requirement: only 8 formats (need 17 w/ genuinely different section ordering); no
     profession adaptation (need 26 families); no custom sections (publications, licenses, shows…);
     no section add/remove/reorder/rename; no missing-information report.

3. **Security/ops (already substantial — audit, don't rebuild)**:
   - `api-helpers.ts`: handler() w/ request IDs + structured logs (stack only in dev),
     `parseBodySized` byte budgets, rate limiting (sync + shared backend), IS_POSTGRES parity helper.
   - `next.config.ts`: nosniff, Referrer-Policy, Permissions-Policy, COOP, HSTS (prod only);
     poweredByHeader off; pdf-parse runtime require; docs/SECURITY_NOTES.md documents the CSP
     decision (same-origin iframe studio preview).
   - `docs/ops/`: DEPLOYMENT_TIERS, LOAD_TESTING, MIGRATIONS, PRODUCTION_READINESS, RUNBOOK(+QUEUE).
   - `.env.example`: full env reference incl. Google OAuth, queue, shared rate-limit/cache backends,
     S3 storage, LAXII providers.
   - Prisma: dual schemas (schema.prisma SQLite / schema.postgres.prisma), indexes on hot paths,
     LaxiiResume keyed by conversationId @unique + [userId, updatedAt].

### Change plan

**A. LAXII V1 engine restriction** (requirement §1)
- `generate/route.ts`: `bodySchema.provider` → only `"managed"` (LAXII V1's backing provider);
  any other value → clear 400 "LAXII V1 is the only available image engine…".
- `router.ts`: add `LAXII_V1` constant (id "laxii-v1", label "LAXII V1", provider "managed");
  `laxiiCapabilities()` returns `engine: { id: "laxii-v1", label: "LAXII V1", provider: "managed",
  model, available, note }` so the UI has one honest source. Managed stays first-pick for
  unpinned requests (never substitutes for a *refused* engine).
- `LaxiiStudio.tsx`: replace the 5-option engine Select with a locked "LAXII V1" badge (real
  status: available / not configured + honest message); send `provider: "managed"` always;
  generation disabled with clear copy when unavailable. Quality selector, avatar presets,
  references, history untouched.
- `laxii-client.ts` + capabilities route updated accordingly.

**B. Universal resume builder** (requirement §2)
- New `src/lib/laxii/resume-professions.ts`: 26 profession families (slugs, labels, roles,
  skills placeholder, suggested formats, section label overrides, suggested custom sections).
- `resume-schema.ts`: 17 resume formats (9 new: executive, academic-cv, research-cv, journalism-cv,
  healthcare-cv, engineering-cv, portfolio-cv, freelance-cv, international-cv) each with explicit
  `sectionOrder` + emphasis guidance → genuinely different document structures; extend document
  schema with optional `custom` sections (generic entries), `order`, `titles` (rename) — stored in
  dataJson, zero DB migration, backward compatible.
- `resume-service.ts`: profession-aware prompts + label overrides; custom sections pass through as
  user facts (never AI-invented; entity guard extended to custom entries); missing-information
  report computed from facts; format ordering applied to drafts.
- `resume-export.ts` + `LaxiiResumePreview.tsx`: render in format order with renamed headings and
  custom sections (PDF/DOCX stay single-column ATS-safe, selectable text).
- `LaxiiResumePanel.tsx`: profession selector (26), format selector (17), custom-section
  add/remove/reorder/rename incl. core sections, missing-info card. Preserve upload (PDF/DOCX/TXT),
  preserve anti-fabrication notes, preserve templates.

**C. Layout fixes** (requirement §3, screenshots 3-5)
- Root panel fills its flex container (`h-full`), columns `min-h-0` + internal scroll → removes the
  empty vertical region; both columns reach the viewport bottom; form scrolls to final section.
- Targeting card: consistent label/control alignment; Generate button aligned; dropdown stays
  within card (trigger `w-full min-w-0`), popper content capped (`max-w-[calc(100vw-2rem)]`,
  Radix available-height + internal scroll), keyboard nav via Radix.
- Verify at 1440×900, 1366×768, 1024×768, 768×1024, 390×844.

**D. Production security / DB / deploy** (requirements §4-§7)
- Audit pass over route inventory vs controls (auth, ownership, validation, rate limits, cookies,
  uploads/magic bytes, SSRF, IDOR, headers, error redaction) — verify existing coverage, fix
  concrete gaps found, document the rest honestly.
- DB: verify schema parity + indexes; NO destructive migrations.
- Deployment: checklists (deployment, env vars, migration, rollback, smoke, monitoring) under
  docs/ops; measured-vs-projected clearly separated. No deploy/DNS/push.

**E. Regression + load** (requirements §8, §6)
- bunx tsc --noEmit, eslint, bun test suites, browser E2E at 5 viewports.
- Load-test scripts (staged 100→100k vu) + MEASURED local results only (sandbox single instance);
  5k+ are projections, never claimed as measured.

### Out of scope / constraints
- No redesign, no nav changes, no auth replacement, no data loss, no AI provider swap beyond the
  LAXII V1 restriction, no real deploy. Production `next build` cannot run inside the running dev
  sandbox without breaking it — verified via tsc + lint + tests; documented as a deploy step.
