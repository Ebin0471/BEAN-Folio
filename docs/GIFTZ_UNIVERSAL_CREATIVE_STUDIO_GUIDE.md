# BEAN Folio — Universal Creative Studio, GIFTZ, LAXII & RIISHE Engineering Guide

**Repository:** [`Ebin0471/BEAN-Folio`](https://github.com/Ebin0471/BEAN-Folio)  
**Verified starting point:** `main` at `74123a59f656aa276eea6ed80b1dcb6f0eaf2131` (2026-11-24)  
**Proposed documentation home:** `docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md`  
**Purpose:** product north star, technical architecture guide, capability contract, implementation roadmap and acceptance checklist for the next BEAN Folio milestone (M33+).

> This is an engineering guide, not a claim that every capability described below is already implemented. Sections labelled **Existing**, **Gap**, **Target** or **Later phase** distinguish the current repository from planned work. Never expose an unsupported feature as available in the UI or tell a user that an operation succeeded when it did not.

---

## 0. Non-negotiable product and engineering rules

1. **Preserve the shipped product.** Inspect the real repository, worktree, branch, current main SHA, route contracts, database schema, tests and screenshots before editing. Do not overwrite or discard uncommitted user work. Make minimal, isolated, additive changes. No unrelated redesign, refactor, route rename, schema reset or dependency churn.
2. **GIFTZ remains the website engineering studio. LAXII remains the visual/document production engine. RIISHE remains the user's single conversational agent and orchestrator.** They delegate to one another through typed, registered, permission-checked capabilities; do not create duplicate competing products or workflow engines.
3. **Reuse before adding.** Prefer the existing `SiteConfig`, `site-fonts`, design-language, palette, sections, component registry, GSAP/CSS motion system, project-file agent, build/preview/proposal/publish lifecycle, LAXII pipelines, resume schema and RIISHE tool registry. Add a new dependency only when a measured gap cannot be filled safely by the present stack.
4. **No fabricated results or facts.** Never invent people, employers, clients, qualifications, awards, testimonials, ratings, reviews, performance metrics, business addresses, legal claims, products, prices, booking availability, source citations, model capabilities or completed QA. Missing user facts remain empty, marked as unknown, or requested from the user.
5. **User control.** Generated code, visual changes, resume text, image versions, site configuration and creative assets are proposals until reviewed and accepted. Public publishing, sending messages, external integrations, payments, destructive actions, account changes and production infrastructure changes require the relevant explicit user/owner approval.
6. **Privacy by default.** Private projects and uploads stay private. Re-check ownership on every read/write/execute operation. Do not use reference photos, private documents, resumes or portfolio materials for model training. Do not leak them through logs, prompts, public URLs, analytics or temporary files.
7. **Security is part of generation.** Treat prompts, uploaded files, imported sites, model output, URLs, HTML, CSS, JS, SVG and generated project files as untrusted input. Validate schemas, paths, dependencies, output size, permissions, CSP and sandbox boundaries. The model is a planner, never an authorization authority.
8. **No proprietary cloning.** The phrase “FlimCraft-style trick” is interpreted here as the legitimate open-source adaptation pattern: study public projects, use code only when its exact licence permits the intended use, preserve notices, adapt original modules, rebrand original work and document all changes. Do not copy Adobe/Premiere/other proprietary source, assets, trademarks, UI artwork, model weights or paid-only components. If “FlimCraft” refers to a particular project or technique, verify that project's identity and licence before using it.
9. **No silent fallback.** If the selected image provider, model, font, API, database, custom domain or feature is unavailable, report the concrete limitation. Do not quietly substitute a materially different provider or return a placeholder while saying the requested work is done.
10. **No production shortcut.** No production DDL, `db push`, data-loss acceptance, deploy, DNS, custom-domain routing, paid provisioning, storage migration or irreversible action without explicit owner authorization.

---

## 1. Verified current architecture — build on this, not beside it

### 1.1 Repository baseline

At the time this guide was prepared, GitHub reported `main` at `74123a59f656aa276eea6ed80b1dcb6f0eaf2131`, the verified PR #7 merge commit. Always re-fetch before starting work; do not assume this SHA remains current later.

### 1.2 GIFTZ / website generation — existing

| Existing area | Source of truth | What it is responsible for |
|---|---|---|
| AI design/config generation | `src/lib/ai-design/*` | Brief context, planning, validated design patches, design-quality review, deterministic config execution and verification. |
| Design languages | `src/lib/ai-design/design-languages.ts` | Curated visual grammars, palette/font/motion recommendations, layout and media direction. |
| Profession playbooks | `src/lib/professions/playbooks.ts`; `docs/PROFESSION_AWARE_GENERATION.md` | Professional context and anti-fabrication guidance for profession-led portfolios/sites. |
| Site schema and exporter | `src/lib/site-config.ts`, `src/lib/site-export.ts`, related `lib/site-*` registries | Validated structured website configuration and deterministic static output. |
| Font library | `src/lib/site-fonts.ts` | 100+ / 129-family curated website font library (verify current count from source; do not hardcode a stale count), categories, real families, available weights and loading strategy. |
| Project file agent | `src/lib/giftz/project-agent.ts` | Natural-language requests to create/edit real HTML/CSS/JS/JSON static-site project files. |
| Project planning and execution | `src/lib/giftz/plan.ts`, `project-files.ts`, `workspace.ts`, `commands.ts` | Strict file plan, workspace-scoped changes and safe execution. |
| Build, preview, deploy | `project-build.ts`, `preview-serve.ts`, `project-deploy.ts`, `project-versions.ts`, `project-domains.ts` | Actual build diagnostics, isolated preview, immutable deploy artefacts, rollback/version history and DNS verification. |
| Visual editor | `visual-editor/*`, GrapesJS exact pin `0.23.9` | Visual editing of eligible HTML/CSS source files. Pages with external or multiple stylesheets may be ineligible for safe round-trip editing; preserve the existing refusal behaviour. |
| Components | `component-intelligence.ts`; `docs/GIFTZ_COMPONENT_REGISTRY.md` | Original GIFTZ components and deterministic component selection/consistency. Current guide records 34 entries; verify live registry before claiming a count. |
| Motion | `motion-engine.ts`; `docs/GIFTZ_MOTION_ENGINE.md`; `docs/GIFTZ_ANIMATION_PRESETS.md` | Validated CSS/GSAP motion presets, a fixed interpreter, responsive/reduced-motion behaviour and generated local assets. |

**Two generation modes must remain distinct:**

- **Config mode:** structured `SiteConfig` content/theme/sections/fonts/palettes/motion, compiled by BEAN's deterministic exporter. This is the preferred route when the request fits the schema.
- **Project-file mode:** real static HTML/CSS/JS/JSON file creation or editing for custom layouts and frontend behaviour that config mode cannot express. It runs through planning, path validation, bounded file generation, build diagnostics, repair and a reviewable proposal.

Do not collapse these into an untyped free-form code-generation path. Keep schema mode deterministic and file mode sandboxed.

### 1.3 Existing current boundaries to tell the truth about

- The project agent is a static-site project agent. It can create pages, navigation, layouts, visual components, client-side interactions and form interfaces. It does **not** automatically provide a generic per-site server backend, database, user authentication, payment processing, inventory, order management or any third-party account integration.
- Published generated pages are sandboxed and use restrictive CSP (including `connect-src 'none'` in the documented static-site serving path). Arbitrary external network calls from generated page scripts are therefore not a supported integration mechanism. Do not weaken this policy to make a demo work.
- A generated UI that looks like a cart, login, booking form or dashboard is not proof that a real secure backend exists. Every form needs an explicit submission/data contract; every “save”, “pay”, “book”, “login” or “sync” action must be connected to an actual authorised capability or marked as a demonstrative UI.
- Public `username.beanfolio.app` publishing requires the owner's domain, wildcard DNS, valid wildcard TLS and trusted ingress that preserves the intended Host header. Repository routing code alone does not make the public domain live. Domain verification is not the same as traffic routing.
- The M32 static build and local-tenant E2E do not prove a full-stack runtime, multi-replica production readiness, a real payment flow or 100K-user capacity. Keep those claims gated by separate evidence.

---

## 2. Product responsibility and agent boundaries

### GIFTZ — website architect, designer, engineer and publishing assistant

GIFTZ owns website creation and website-project engineering from a blank brief through a reviewable, tested build and the existing publishing lifecycle. It may ask RIISHE for research, LAXII for assets or resume output, and registered platform tools for data. It must not fabricate backend services or claim a site is live before a deployment is actually LIVE and reachable.

### LAXII — visual and professional-document production engine

LAXII owns image generation/editing, identity-preserving portrait workflows, banners/covers, background work, creative assets and professional resume/CV document production. It returns versioned assets/documents with measured metadata and truthful provider/model status. LAXII does not decide whether an asset becomes public; the user applies it.

### RIISHE — one agent, many specialists, governed tool execution

RIISHE remains the single conversational entry point. Its current specialist registry and durable workflow engine are the authority. Add capabilities as typed tools/specialist profiles over the existing registry; do not create a second agent framework just to route GIFTZ and LAXII. RIISHE can plan, delegate, monitor, summarise, request approval and report real outcomes. It cannot grant itself new permissions.

### Shared orchestration contract

Each delegated task must carry:

- `userId` and (when relevant) verified workspace/organization context;
- originating conversation, project/site/document/image identifiers;
- a typed goal and validated input schema;
- declared file/data scopes and capability permissions;
- explicit constraints, user choices and preservation rules;
- request id/idempotency key, quota, time budget and cancellation signal;
- outputs as typed references (site proposal, build, deployment, media asset, resume version, research brief), never unvalidated free-form claims;
- step status, durable audit trail, real diagnostics and human approval state.

A specialist may only call registered tools. Every tool re-checks ownership, workspace access, resource state and approval at execution time. Model-planned risk labels are never authoritative.

---

## 3. Universal website scope — supported types and required behaviour

GIFTZ should become a **universal website creation system**, but it must route the request to the correct architecture instead of pretending all websites are static pages. The following taxonomy is the product coverage map. Each type has a static/front-end tier and, where needed, a separately provisioned full-stack tier.

| Website family | Typical examples | Core site content / pages | Dynamic capability required when user asks for it |
|---|---|---|---|
| Personal & professional | Portfolio, CV, creator, developer, editor, artist, photographer, filmmaker, consultant | Home, about, work/projects, services, experience, skills, testimonials only if supplied, contact | Resume/profile sync, inquiry storage, private case studies, client portal only through authorised backend. |
| Business & corporate | Company, enterprise, startup, brand, agency, studio | Home, company, services/products, industries, case studies, team, careers, contact, legal pages | CRM lead capture, employee portal, authenticated resources, internal content management. |
| Local services | Salon, repair, trades, clinic front page, restaurant, hotel, gym | Services/menu, pricing, location, opening hours, team, FAQs, contact | Real booking slots, reminders, payments, inventory/availability, maps or messaging integration. |
| Marketing & campaign | Landing page, launch, waitlist, product announcement, event campaign | Hero, benefits, proof backed by evidence, pricing, FAQ, CTA, legal/privacy | Real lead capture, email confirmation, campaign attribution, A/B experimentation. |
| SaaS & software product | SaaS marketing, developer tool, AI product, API product | Product pages, features, integrations, docs, pricing, security, changelog | Authentication, subscription billing, usage metering, account data, secure APIs, tenant isolation. |
| E-commerce | Product store, digital products, catalogue, brand shop | Home, category, product details, search/filter, policies, cart UI | Real product/stock data, cart, checkout, payment provider, tax/shipping, order history, refunds, admin. |
| Marketplace & directory | Freelancer marketplace, property directory, vendor marketplace, business listing | Search/discovery, categories, profiles/listings, filters, detail pages, trust content | Accounts, listing moderation, search index, messaging, escrow/payment, dispute and review controls. |
| Booking & appointments | Doctor appointment front-end, classes, consultations, equipment rentals | Service details, staff, locations, calendar UI, booking policies | Calendar availability, time-zone correctness, double-book prevention, confirmations, cancellation and payment. |
| Food, travel & hospitality | Restaurant, cafe, resort, tour operator, travel guide | Menu/rooms/tours, photo gallery, locations, itinerary, policies, FAQs | Booking, live availability/pricing, payments, reservations and external channel integration. |
| Events & ticketing | Conference, wedding, festival, workshop, exhibition | Event overview, schedule, venue, speakers, FAQs, sponsors | Ticket inventory, payment, QR issuance/validation, refunds, attendee check-in. |
| Education & learning | Course site, academy, school, training, exam-prep | Programs, instructors, lesson previews, schedule, FAQs | Enrollment, course progress, quizzes, certificates, payments, learner records and access control. |
| Membership & community | Member site, club, professional network, paid community | Public landing, benefits, plans, community rules, member stories | Membership entitlements, recurring payments, private content, moderation and member data. |
| Publishing & media | Blog, newspaper, magazine, video channel, podcast | Home, categories, article, author, archive, media pages | CMS/editorial workflow, drafts, scheduled publishing, roles, subscriptions and media processing. |
| Documentation & support | API docs, help centre, knowledge base, changelog | Search, navigation tree, guides, reference pages, examples | Versioned docs, feedback capture, access restrictions, search indexing and support integration. |
| Jobs & talent | Career site, job board, hiring portal, recruiter landing | Roles, role detail, culture, application instructions | Candidate accounts, consent, document upload, pipeline, employer verification and recruitment permissions. |
| Property & real estate | Agency, rental listings, project launch | Property grid, filters, detail pages, agent profiles, location | Verified availability/pricing, inquiry CRM, saved searches, secure document workflows. |
| Nonprofit & public service | Charity, NGO, community campaign, civic information | Mission, programs, impact evidence, campaigns, resources, contact | Donation gateway, volunteer applications, case-management integrations and transparent receipts. |
| Health & wellbeing | Practice information, wellness service, health education | Services, team credentials, evidence-based education, accessibility | Any patient information, appointments, payments or clinical records require privacy/security/legal review and a compliant backend. Do not claim compliance by appearance. |
| Internal tools & dashboards | Admin portal, reporting, workflow app, analytics dashboard | Dashboard shell, navigation, data views, settings, help | Auth/RBAC, server-side APIs, audit logs, database, tenancy, export and secure background jobs. |
| Creative & entertainment | Film, music, game, artist, production house, agency | Showreel, projects, press kit, credits, media kit, gallery | Media transcoding/streaming, licensing, ticketing, ecommerce, booking or private distribution. |
| Government & institutional | Public information, service guide, institution | Services, eligibility, forms, notices, location, accessible content | Identity verification, case data, secure submission and records; high-stakes legal/accessibility review. |

### Capability tier labels

Expose a truthful capability state per feature:

- **Static-ready:** can be built and published as HTML/CSS/JS without private data or server writes.
- **Connected-ready:** integration exists, credentials and user permission are configured, and test calls are passing.
- **Backend-required:** the requested experience needs an isolated server-side capability not available to the static project. Offer a clear architecture plan; do not create fake working forms.
- **Owner-setup-required:** needs a domain, DNS, storage, credentials, payment account, email provider or other outside resource.
- **Unsupported:** current product does not implement it. Explain the gap plainly.

---

## 4. GIFTZ end-to-end website lifecycle — no stage silently skipped

### Stage 1 — Understand the brief

Capture (ask only for essential missing detail; use safe defaults for the rest):

- website objective and desired conversion/action;
- website family, industry and profession;
- intended audience and geography, language(s), accessibility needs;
- brand name, existing logo, visual references, brand voice and prohibited styles;
- preferred tone (e.g. authoritative, warm, playful, editorial, cinematic, premium, technical);
- content source: existing Folio profile, approved uploads, supplied copy, public sources when requested;
- requested pages, features, integrations and functional actions;
- existing assets, aspect ratios, imagery rights and user-supplied fonts;
- privacy level, owner/editor roles and publishing target;
- success criteria, deadline/budget constraints if provided.

Never infer sensitive traits or psychological/medical characteristics. Do not require the user to fill every field before generating a first draft; mark assumptions so they are reviewable.

### Stage 2 — Research and evidence

When asked to research competitors, market, regulations, platform requirements or current information, use real sources, record retrieval date and cite claims. Distinguish user-supplied facts, public-source facts, recommendations and assumptions. Never invent reviews, ratings, awards, clients, testimonials, addresses or competitor features. Respect copyright: use facts and short attributed references, not scraped article copy or copied competitor designs.

### Stage 3 — Sitemap and content architecture

Produce and validate:

- primary goal + CTA hierarchy;
- sitemap, page slugs, navigation, footer and legal/privacy routes;
- page-level audience, intent and unique metadata;
- conversion flow and content dependencies;
- shared components and reusable design tokens;
- accessibility/SEO content outline;
- an explicit content gap list (missing image, text, pricing, service facts, policies, etc.).

Check internal navigation, deep links, active states, breadcrumbs when needed, 404/fallback states, mobile navigation and page titles.

### Stage 4 — Creative direction and brand kit

Create a structured, reproducible brand kit:

- design language from the existing design-language registry (or a proposed new original entry only if registry coverage is genuinely missing);
- palette with semantic tokens (background, surface, text, muted, primary, accent, border, success/warning/error);
- typography roles (display, heading, body, UI, optional mono/brand accent);
- grid, spacing, content width, density, radius, borders, shadow and glass settings;
- illustration/photography/art direction and image focal points;
- motion personality, motion budget, reduced-motion equivalent;
- voice/copy rules and prohibited claims;
- logo/asset placement and clear-space rules.

Keep the creative direction consistent across pages, components, LAXII-created visuals, social assets and the published site. Save a reusable Brand Kit only through the user's existing settings/consent model.

### Stage 5 — Typography selection using brand psychology responsibly

**The safe design principle:** typography changes the *perceived tone of the brand and the reading experience*. It does not prove or diagnose a user's psychology. Choose from explicit user preferences, brand adjectives, audience, industry conventions, language and readability requirements; never make hidden psychographic inferences.

Practical starting heuristics (not universal rules):

| Desired brand impression / use | Candidate families or category | Guardrail |
|---|---|---|
| Editorial, literary, thoughtful, premium | Readable editorial serif for display; neutral sans for body | Keep body text legible at small sizes; avoid thin hairlines. |
| Corporate, trustworthy, operational | Humanist or neutral sans | Use familiar numerals and strong hierarchy; avoid sterile all-caps blocks. |
| Technology, engineering, data | Modern sans; mono only for code/data labels | Never set long body paragraphs in mono. |
| Luxury, fashion, high-end hospitality | Restrained high-contrast serif + quiet sans | Ensure contrast and small-screen rendering; do not overuse letter spacing. |
| Creative, youthful, expressive | Distinct display face + stable sans body | Keep display typography to headings and short labels. |
| Warm, approachable, community | Humanist/rounded sans or warm serif | Don't sacrifice clarity with excessively rounded or light weights. |
| Accessible long-form reading | Screen-optimised text serif or sans with open shapes | Check x-height, line length, line height, glyph support and real reading tests. |
| Multilingual/local language | Font with confirmed glyph coverage for the requested script | Test every language, punctuation, numerals and fallback shaping. |

Rules:

1. Prefer one display family + one body family; add a third only when the design genuinely needs mono/brand lettering.
2. Pick only weights actually shipped by the family. Do not request nonexistent weights.
3. Use the existing `SITE_FONTS` library and design-language mappings first. Validate selected IDs against the real registry.
4. Offer 2–3 previewable pairing choices and explain the design rationale. The user can override any recommendation.
5. Validate contrast, body size, line height, line length, responsive scaling, text wrapping and language glyph coverage.
6. Do not infer font choices from sensitive personal characteristics. Ask for or use explicit adjectives, brand audience and industry context.
7. Audit each font file's individual licence before bundling/self-hosting. Fontsource tooling's MIT licence does **not** mean every font file it distributes is MIT. Keep per-family OFL/Apache/UFL/other license text and attribution where required.
8. Current implementation loads many non-bundled families on demand through Google Fonts. Preserve this unless a reviewed change is approved. A self-hosting move needs privacy, performance, font licence, cache and migration tests.

### Stage 6 — Layout, components and page construction

- Select section types from the actual validated schema and the profession/industry playbook.
- Select components from `COMPONENT_REGISTRY`; reuse native sections and existing components before inventing another.
- Build semantic, responsive HTML; landmarks, heading order, accessible forms, labels, keyboard states and alt text must be correct.
- Apply a consistent design system; no unrelated font, radius, spacing or animation per page.
- Build empty, loading, error, success, disabled and unavailable states for interactive UI.
- Ensure every link/button has a working, safe destination/action or is visibly disabled/not presented as functional.
- No fake placeholder metrics/testimonials/customer logos. Use explicit user-supplied facts or omit.

### Stage 7 — Motion and animation

Use the current CSS/GSAP system first. The AI expresses motion as validated preset/configuration data; it does not generate or execute arbitrary animation code in config mode.

Animation plan should record:

- purpose (orientation, hierarchy, feedback, storytelling, navigation or decoration);
- target element/section and trigger;
- duration, delay, stagger and easing within validated schema limits;
- mobile policy (`full`, `reduced`, `off`);
- `prefers-reduced-motion` static or simplified alternative;
- cleanup on route/page exit and duplicate-init protection;
- performance class and measured effect on LCP/INP/CLS;
- fallback when JS, GSAP, plugin or WebGL fails.

Guidelines:

- Typically 3–8 purposeful motion instances per page; warn when the site becomes overly animated (existing docs note a >12 active-animation warning).
- Motion must never hide content, block navigation or be required to understand the page.
- Avoid scroll-jacking, flashing, excessive parallax, surprise auto-play audio/video and intense continuous backgrounds.
- Keep pointer-only hover effects decorative; preserve keyboard focus and touch interaction.
- Respect reduced motion by default; do not make reduced-motion users wait for animated text to reveal.
- Use CSS for simple transitions, the existing GSAP interpreter for registered advanced motion, and custom file-level JS only where the existing file agent's security checks explicitly permit it.
- No external CDN script injection. Vendor only audited dependencies with valid licences and integrity records.
- Preserve generated runtime/vendor files as compiler-owned; never let AI/user edits silently override them.

### Stage 8 — Images, video and media

Use user-owned uploads, explicitly licensed media, original CSS/SVG illustrations, or assets produced by LAXII. For each image/video define purpose, dimensions/aspect, focal point, crop, alt text, loading strategy, responsive sources and file-size budget. Do not scrape stock images or use copyrighted brand imagery without rights. If a generated image is requested, route through LAXII; a generated image result is not proof of factual or real-world content.

### Stage 9 — Search, SEO, social and structured content

- Unique page title, description, canonical route and Open Graph/Twitter metadata.
- Correct robots/sitemap/canonical policy for public vs private pages.
- Structured data only where the underlying facts are true and user-authorised.
- Semantic headings, descriptive links, image alt text, language and locale declarations.
- Internal linking and working 404s; avoid keyword stuffing and invisible text.
- No fake local business schema, fake ratings or invented address/opening hours.
- Private previews and private sites must not leak in search indexing or metadata.

### Stage 10 — Forms and integrations

Classify every form/action:

- local-only demo interaction;
- static `mailto:` / external link (clearly labelled as such);
- connected, secure server endpoint already integrated;
- new backend module required.

For a genuine form: validate on client and server, CSRF/origin controls, rate limit, spam prevention, field minimisation, consent where needed, secure storage, delivery confirmation, abuse monitoring, retention/deletion and accessible success/error states. Never claim a form is connected merely because its UI exists.

For external integrations (maps, video, analytics, email, CRM, payments, social, calendars): use explicit allowlisted provider adapters; keep secrets server-side; request user connection/consent; define scopes, webhook verification, retry/idempotency and failure states. Don't embed arbitrary third-party iframes or run arbitrary remote JS to bypass CSP.

### Stage 11 — Accessibility, privacy and security review

Minimum target is WCAG 2.2 AA as an engineering target, not a certification claim. Test:

- keyboard-only use, visible focus, skip link, logical focus order;
- contrast, zoom/reflow, text resizing and touch target sizing;
- accessible name/role/value for controls; field labels/errors;
- headings, landmarks, table semantics, captions/alt text;
- reduced motion and non-colour status indications;
- screen reader checks on key flows and multilingual text;
- permissions, private asset exposure, CSRF, XSS, SSRF, open redirects, path traversal, CSP, upload validation, dependency and secret scans.

A passing automated scan is not a full accessibility or security certification. Record manual gaps.

### Stage 12 — Responsive and real-browser QA

Test representative viewport widths at minimum: 360/390, 768, 1024 and 1440/1920 CSS pixels. Inspect real browser screenshots and console/network errors. Verify:

- every page and deep link boots directly and after refresh;
- header/menu/footer, content wrapping, images/crops, forms and tables;
- sticky/fixed elements do not overlap or cover content;
- keyboard focus and modal/dialog dismissal;
- mobile tap interactions, horizontal overflow and orientation;
- animation fallback and reduced-motion mode;
- fonts fully loaded and no layout shift from font swap;
- empty/error/offline states and API authorization;
- performance on low-spec CPU/mobile and reduced bandwidth.

Static build checks do not replace a browser execution test. Capture before/after screenshots for any visual modification and compare unrelated existing screens to ensure no regression.

### Stage 13 — Build, preview, proposal, approval and apply

1. Generate a plan against the current project tree and schema.
2. Validate plan schema, file paths, declared files, dependencies, permissions and size budgets.
3. Build an isolated overlay/proposal; do not write into the user's live project while planning.
4. Run deterministic build checks and bounded repairs using actual diagnostics.
5. Display a diff, summary, generated pages/assets, known limitations and a working preview.
6. Ask the owner to approve applying the proposal.
7. Apply only approved operations atomically; reconcile source timestamps/concurrency.
8. Rebuild and create a version snapshot; make rollback available.
9. Preserve unrelated files and user changes.

### Stage 14 — Publish, domain and lifecycle

- Publish only a successful, immutable build artefact via the existing `project-deploy.ts` flow.
- Ensure previous live version, rollback, unpublish and cache-revocation behaviour is correct.
- Display the exact URL returned by the deployment system, not a fabricated preview URL.
- Clearly label local preview, configured tenant URL, public hostname and verified custom domain as distinct states.
- A custom hostname is not ready until DNS, TLS, Host routing, verification, ownership and serving tests all pass.
- Provide site status, deployment history, error logs (redacted), version restore, unpublish and user data export/deletion controls.
- Do not promise analytics, backups, uptime, SEO ranking or security compliance unless the corresponding real systems exist and are measured.

---

## 5. Full-stack website runtime — the missing architectural tier

### Why it is needed

The existing static project agent should remain lightweight, portable and safe. Dynamic products need server-side state, authentication, database access and external integrations. Do **not** loosen the static-site iframe CSP or give generated code the platform's database credentials.

### Target architecture (separate, isolated capability)

Introduce a separately reviewed **BEAN Application Runtime** for projects that need real backend behaviour:

- immutable per-project build/artifact identity and tenant routing;
- isolated runtime/container or serverless execution with CPU, memory, disk, network and wall-clock ceilings;
- one project/tenant identity and strict per-tenant data isolation;
- a small, versioned, allowlisted API/module contract;
- secrets available only through server-side secret references, never generated bundle files;
- database access through scoped repositories and migrations reviewed by platform code;
- egress/network allowlist and DNS/IP protections against SSRF;
- signed deployment manifests, artifact integrity and rollback;
- logs redacted for secrets and private PII; audit trail for privileged operations;
- lifecycle policies: suspend, quota, backup/restore, export, retention and deletion.

The runtime must be a different trust boundary from GIFTZ preview/published static iframes. Never mount the host filesystem or platform environment into an untrusted generated website.

### Backend feature modules (only enable when implemented and authorised)

| Module | Requirements before it can be labelled working |
|---|---|
| Form submissions / leads | Server validation, spam/rate protection, consent, secure destination storage, notification provider, retention/deletion, audit. |
| User authentication | Secure sessions, password/passkey/OAuth flow, account recovery, MFA policy, role model, tenant isolation, CSRF and audit. |
| CMS / blog publishing | Content schema, editor roles, draft/review/publish, scheduled jobs, sanitised rendering, version/rollback. |
| Product catalogue | Real product schema, media, stock state, price/currency correctness, search and admin. |
| Cart / checkout / payments | Provider integration, server-side price validation, webhook signature verification, idempotency, taxes/shipping rules, receipts, refunds and PCI scope review. Never store raw card numbers. |
| Orders / inventory | Transactional stock reservation, concurrency control, fulfilment state, refunds/cancellation and admin permissions. |
| Booking / calendar | Source-of-truth availability, time zones, no double booking, holds/expiry, reminders, cancellations and payment if selected. |
| Membership / subscriptions | Entitlements, payment webhooks, cancellation/past-due/grace state, access control and account export/delete. |
| LMS / exams | Enrollment, lesson progress, quiz/question bank, integrity policy, attempts/time limits, results and privacy. |
| Marketplace / directory | Moderation, seller/candidate consent, trust/verification, search index, messaging, fraud/dispute controls. |
| Analytics | Consent-aware event schema, data minimisation, aggregation, retention, access and export. |
| Admin dashboard | RBAC, server-side data filtering, audit, rate limits, secure exports and tenant boundary tests. |

### Candidate open-source backend building blocks

- **Medusa:** evaluate for commerce-specific modules when real commerce is prioritised. The repository describes an MIT-licensed core with separately identified commercial Enterprise materials; inspect exact packages, enterprise boundaries, transitive dependencies and deployment/security model before adopting. It is not a drop-in replacement for the BEAN tenant model.
- **Puck:** evaluate as a separate visual editor for React-rendered application pages, not as a replacement for the existing GrapesJS static HTML/CSS editing pipeline. Its core is MIT licensed; prototype against a representative BEAN component schema and prove save/render/version/tenant isolation before adoption.
- Keep static output as the default for portfolios, brochure sites, editorial landing pages and ordinary marketing sites. Provision the full-stack tier only when the actual request requires it.

---

## 6. LAXII — face-preserving portraits, premium banners and creative production

### 6.1 Existing engine and honest identity model

Existing LAXII code lives under `src/lib/laxii/*` with API routes under `src/app/api/laxii/*`. The current source documentation describes managed inference and an optional separately hosted Diffusers worker. The user-facing generate API currently pins provider selection to the managed path; do not claim the local Diffusers worker is user-selectable unless the real API/UI has been changed and tested.

**Preserve-pixel avatar mode (the correct strict no-face-change option):**

- Keep the original subject pixels and composite a newly generated background around a segmented foreground. The documented formula is `output = original_subject × alpha + generated_background × (1 − alpha)`.
- Do not run face regeneration, face swap, face restoration, diffusion re-rendering, expression change, eye/skin enhancement or generative fill on the protected face/subject region.
- Preserve face shape, eye shape/spacing, nose, mouth, jaw, ears, expression, skin texture, age cues, facial hair, glasses, scars/marks, hairline and identity details. Do not beautify or alter body shape unless the user explicitly requests a separate non-identity-preserving edit.
- Permit only safe framing/scale/translation within user-selected bounds; keep source proportions. If the required mask cannot be produced or numerical validation fails, stop and explain why. Do not export a degraded approximation as an identity-locked result.
- Run pixel-level validation on the protected region and keep an audit manifest of mask coverage, transform, input/output dimensions and verification result. Do not expose raw diagnostics publicly.
- Explain the difference between **Identity Lock / Preserve Pixels** (original foreground pixels retained) and **AI Style Portrait** (the model may change features; likeness is not guaranteed). The latter must be labelled experimental and require explicit user selection and review.
- Apply generated output to the profile only after the user selects it. Store source/output privately until then.

Consent and identity safety:

- The user must own the uploaded image or have permission from the person depicted. Where a person is identifiable, require a clear lawful-use/consent confirmation for profile use and publishing.
- Do not create deceptive impersonation, forged identity documents, non-consensual intimate imagery or identity-swap content. The system must refuse unsafe requests and provide a safe alternative.
- Never state a face match score is proof of identity. Avoid unnecessary face recognition/embedding storage. Preserve-pixel processing can solve the strict task without building a face-recognition database.

### 6.2 Avatar production checklist

Provide user-controlled options for:

- crop and framing (headshot, shoulders, waist-up, full body where appropriate);
- neutral, studio, office, outdoor, creative or brand-matched background;
- background replacement/blur/gradient/transparent export where actually supported;
- wardrobe/background changes only if user explicitly selects a mode that may change protected subject pixels; label that mode as non-identity-preserving;
- lighting on the background and global composition without modifying protected face pixels;
- aspect ratio, resolution/quality and PNG/JPEG/WebP export as the actual engine supports;
- preview slider/side-by-side, version history, regenerate background, undo and restore;
- a clear exact statement of what was preserved, what changed and what the model processed.

### 6.3 Premium banner production

Existing LAXII has a canonical BEAN Folio banner preset at **2048×687** with a defined central safe area. Keep that format stable for current profile/banner contracts.

Expand through a versioned preset registry rather than changing the canonical size:

- Folio/profile banner (existing canonical 2048×687);
- website hero/cover formats;
- wide campaign/advertising formats;
- square campaign/product tile;
- portrait story/reel/poster formats;
- custom width/height, with pixel/ratio/size bounds and safe-area validation;
- platform-specific presets only after checking current official platform specifications; record a `checkedAt` date and refresh process.

The brief should capture brand, objective, headline, subheadline, CTA, logo, product/person subject, preferred palette, visual style, audience, channel, crop focus, exclusions and supplied assets. LAXII must:

1. create a composition plan and focal/safe-area layout;
2. generate the background/artwork with a real available provider;
3. render exact text/logo separately with deterministic typography, never trust the image model to spell required copy;
4. verify font, text wrapping, contrast, hierarchy, logo clear space and crop safety;
5. score sharpness/artifacts and inspect actual output dimensions;
6. run bounded refinements only on failed checks;
7. export exact requested dimensions and format;
8. save versions privately and require user selection before applying to a profile/site.

Add multiple art-direction presets (minimal editorial, corporate premium, cinematic, product-led, photographic, typographic, abstract, playful, technology, luxury, local language) as prompts/data. Never copy a proprietary template, ad design or brand identity.

### 6.4 Resume / CV as a genuine professional document

Use the existing resume service/schema/export. Preserve the anti-fabrication guard: employers, institutions, awards, certificates, dates, titles, skills, metrics and achievements must be traceable to user facts or a user-supplied document. If a model invents an entity, retry once under the existing contract; if it still fails, do not save or show it as fact.

Target resume capabilities:

- start from structured profile facts, upload/parse a previous resume, or manually enter data;
- profession-aware sections and terminology (use existing profession taxonomy and playbooks);
- one-page, two-page, academic CV, creative CV, technical, executive, entry-level, career-change and region-appropriate templates;
- ATS-safe single-column template with conventional headings, text extraction checks and sensible formatting; a designed visual version is an optional separate template;
- role/job-description tailoring that reorders/emphasises existing facts and identifies missing evidence without inventing it;
- section-by-section editing with provenance badges showing what was changed by AI vs the user;
- grammar, clarity, consistency, chronology, date and duplicate checks;
- resume-to-cover-letter drafts grounded in the same facts (new feature, only after tests);
- user-approved profile/portfolio sync, version history, compare/restore;
- export to only the formats actually implemented and verified (check current DOCX/PDF routes; do not assume all formats exist);
- parse exported output back to text and compare essential facts to catch missing/garbled content.

ATS compatibility cannot guarantee hiring success or a particular ATS score. Show checks and limitations honestly. The user must approve every factual change.

### 6.5 LAXII provider/model governance

- Maintain provider-specific capability declarations. A capability is offered only if the selected provider can really perform it.
- Model, code and weight licences are separate. Record repository/version/commit, model card, weight licence, base-model restrictions, third-party components, commercial status, attribution and distribution requirements.
- Avoid model downloads at generation time. Pin/cache reviewed model assets and verify checksums; provide explicit cache/storage budgets.
- Support low-resource CPU/GPU paths only when a real measured configuration exists. Expose estimated VRAM/RAM/disk and a clear unsupported message; never silently shift the user's private image to another provider.
- Keep inference workers separate from web app requests; queue, lease, heartbeat, cancel, retry, rate-limit and clean up failed/abandoned jobs.
- Validate output decode, dimensions, MIME, size, pixel limits and metadata. Strip sensitive EXIF/metadata unless preservation is explicitly required.

---

## 7. RIISHE — universal conversational agent without unsafe autonomy

### 7.1 Current design to preserve

RIISHE already has a specialist registry, tool registry, planner, deterministic fallback, durable workflow engine, audit events, approval policy, job queue, retries, pause/resume/cancel and crash recovery. Its registered specialists already include career, talent, project, research, operations, growth/communications, business analysis, people operations and documentation/knowledge roles. GIFTZ owns website engineering; LAXII owns visual production. Use these source-of-truth structures.

### 7.2 Target user experience

The user should be able to speak naturally in one RIISHE conversation:

- “Create my company website and use this brand kit.”
- “Make a premium cover banner using this photo but do not change my face.”
- “Build an ATS-friendly resume for this role using only my real history.”
- “Improve the animation, make it accessible and show me what changed.”
- “Research these competitors, cite the sources, then propose a website structure.”
- “Build, preview, fix the issues and prepare to publish.”

RIISHE should understand the goal, ask one important missing question when absolutely needed, create a plan, delegate to GIFTZ/LAXII/approved research or platform tools, stream real progress, present previews/proposals, request approval for gated actions, verify execution results and summarise changed resources and remaining gaps.

### 7.3 Target specialist/capability map

| Specialist capability profile | Delegates to | Example registered tools to implement only where missing |
|---|---|---|
| Website strategist / information architect | GIFTZ + Research Analyst | `giftz.brief.create`, `giftz.sitemap.propose`, `giftz.brandKit.propose` |
| Website designer / builder | GIFTZ config pipeline | `giftz.site.plan`, `giftz.design.propose`, `giftz.site.preview` |
| Frontend engineer | GIFTZ project file agent | `giftz.project.inspect`, `giftz.files.propose`, `giftz.project.build` |
| Accessibility / SEO / performance auditor | GIFTZ verification | `giftz.audit.accessibility`, `giftz.audit.seo`, `giftz.audit.performance` |
| Site release manager | GIFTZ deploy lifecycle | `giftz.publish.prepare`, `giftz.publish.confirm` (publish must be a human approval boundary) |
| Creative director / visual producer | LAXII | `laxii.avatar.preserve`, `laxii.banner.produce`, `laxii.image.edit`, `laxii.asset.export` |
| Resume / career specialist | LAXII resume service + Career Guide | `laxii.resume.generate`, `laxii.resume.tailor`, `laxii.resume.export` |
| Research analyst | Existing authorised web research capability | Search/summarise/cite, no fabricated citations or unauthorised scraping. |
| Project manager | Existing workflow engine | Status, deadlines, reminders, task dependency and approval tracking. |
| Brand and knowledge custodian | User-approved saved data | Retrieve user-authorised brand kit/preferences; respect workspace boundaries and revocation. |

These are *capability names*, not permission to assume new tools exist. First inspect `RIISHE_TOOLS`, contracts, specialist availability and existing APIs; register missing tools with strict Zod input/output schemas, explicit `risk`, approval, quota and undo semantics.

### 7.4 Authority and confirmation ladder

- **Read:** can read only resources the current user/workspace may access.
- **Draft/propose:** may create private drafts/proposals, not apply them to live projects without approval.
- **Apply:** user confirms a proposed set of reversible file/config changes.
- **Publish/send/pay/delete/connect:** always require explicit, contextual, final confirmation, re-check scope and show the exact target/action/amount/message before executing.
- **High risk:** requires owner-level approval, audit event, idempotency and a reliable rollback/compensation plan. Some operations remain owner-only or unsupported.

Never place passwords, API keys, payment secrets or raw provider credentials into model prompts or client storage. Do not make RIISHE a broad arbitrary shell/browser agent with platform secrets.

### 7.5 Conversation memory and context

Persist user choices only under existing consent/privacy controls. Keep task context scoped to the user, workspace, project and conversation. Do not use unrelated personal/health/sensitive data for marketing or design inference. Provide user-visible review, correction, export and deletion controls in the approved settings flow.

---

## 8. Open-source research and adoption register

**Important:** A repository's source-code licence is not automatically the licence for its model weights, datasets, fonts, assets, trademarks, hosted service or every dependency. Audit each artefact separately before a commercial BEAN release. The links below are starting points, not a substitute for a pinned commit and legal review.

| Project | Current licence signal / role | BEAN decision |
|---|---|---|
| [GrapesJS](https://github.com/GrapesJS/grapesjs) | BSD-3-Clause; already pinned as `0.23.9` and used for eligible visual HTML/CSS editing. | **Keep.** Do not replace or add commercial Studio SDK. Preserve the existing adapter and round-trip tests. |
| [Puck](https://github.com/puckeditor/puck) | MIT React visual editor; can edit a configured tree of BEAN React components. | **Evaluate** for a future isolated React/full-stack application editor. Do not replace GrapesJS for the current static HTML project tree without a measured migration case. |
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) | MIT resume builder with live preview, ATS/readability checks, templates and multiple exports. | **Reference/possible component study.** Reuse UX ideas and schemas where suitable; do not duplicate the current LAXII resume service or copy the whole app without architecture/licence review. |
| [Fontsource](https://github.com/fontsource/fontsource) | Font packaging/tooling repository is MIT; individual font families carry their own terms. | **Optional tooling.** Use only after verifying every font file's own OFL/Apache/UFL/licence and all notices. |
| [Medusa](https://github.com/medusajs/medusa) | MIT open-core; Enterprise materials are separately identified under a commercial agreement. | **Evaluate** only for real commerce backend module; audit package tree and enterprise boundary, then isolate in runtime. |
| [Motion](https://github.com/motiondivision/motion) | MIT React animation library. | **Do not add now.** Existing GSAP + CSS motion + Framer Motion cover current product; only evaluate with a proven gap and size/performance comparison. |
| [Diffusers](https://github.com/huggingface/diffusers) | Apache-2.0 library. | **Keep optional isolated worker.** Check exact model card/weight/base model restrictions individually. |
| [IP-Adapter](https://github.com/tencent-ailab/IP-Adapter) | Apache-2.0 source-code signal; model weights and base-model terms need separate audit. | **Candidate** for identity-guidance only after pinning weights and confirming commercial rights. Do not confuse guidance with exact pixel preservation. |
| [PuLID](https://github.com/ToTheBeginning/PuLID) | Apache-2.0 source licence in upstream repo; checkpoints/backbone/base-model rights still require separate audit. | **Candidate, not approved for production yet.** Test identity fidelity and memory use on supported hardware; review model assets and any dependency licences. |
| [PhotoMaker](https://github.com/TencentARC/PhotoMaker) | Upstream code states Apache-2.0 except listed third-party components. | **Candidate only.** Audit all checkpoints, dependencies and third-party notices; compare with strict preserved-pixel path. |
| [InstantID](https://github.com/instantX-research/InstantID) | Code is Apache-2.0, but its README says InsightFace face models and released checkpoints are research-only/non-commercial. | **Do not use in commercial BEAN production** without separate written model/weight licences. |
| [InsightFace](https://github.com/deepinsight/insightface) | Code is MIT; upstream says pretrained models/training data are non-commercial research unless separately licensed. | **Do not download/use public pretrained weights commercially** without a written commercial licence. |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | GPL-3.0. | **Do not vendor/link source into BEAN's proprietary application.** Any independent sidecar deployment needs separate architecture and legal review; keep current LAXII path independent. |
| [React Bits](https://github.com/DavidHDev/react-bits) | Existing BEAN review records MIT + Commons Clause, not plain MIT. | **Reference-only.** Do not copy/bundle; keep BEAN-native original components and maintain the existing licence review. |

### Adoption workflow for every new project/package/model/font

1. Confirm upstream identity, canonical URL, current commit/tag, activity, security policy and maintenance state.
2. Read the root licence **and** nested/subdirectory licences, notices, third-party directory, package metadata and model card.
3. For ML: separately record code, weights, dataset, VAE/encoder/adapter, base-model and optional plugin licences. Check commercial use, redistribution and use restrictions.
4. Run dependency/SBOM and vulnerability scans. Review install scripts, telemetry, network access and post-install behaviour.
5. Prototype in an isolated branch with a measured product acceptance criterion.
6. Record exact version/hash, used files/packages, changes, attribution and licence obligations in `docs/oss/THIRD_PARTY_COMPONENTS.md` before production import.
7. Keep commercial/cloud/proprietary SDK packages out unless the owner explicitly accepts the terms and cost.
8. Preserve copyright notices and required licences in distributions. Never remove attribution to make a package look native.

---

## 9. Reliability, storage, scale and operational requirements

- GIFTZ proposals/builds/deployments must be durable, recoverable and idempotent. Keep actual artefacts immutable by deployment/version.
- LAXII generation must run as a worker job with bounded concurrency, heartbeat, stale-job recovery, cancellation, safe temp cleanup and storage quota.
- RIISHE workflows must persist each step, attempt, actual result/error and approval transition. Do not mark a workflow complete merely because the model returned a confident sentence.
- For multi-instance PostgreSQL production, close the known concurrency and storage gaps before activation: LAXII duplicate-generation/create-job races, job lease/timeout alignment, needed status/heartbeat indexes, shared durable workspace/object storage, worker recovery and load/soak evidence. A memory-backed limiter or local disk workspace is not a multi-replica guarantee.
- Keep `RATE_LIMIT_BACKEND=memory` acceptable only for dev/single-instance environments; multi-instance production must use a shared durable backend.
- Use S3-compatible object storage for shared artefacts only after the storage-driver contract, migration/retry/rollback and retention policies are tested. Do not silently replace file-backed workspace assumptions.
- Add observability for queue lag, job durations, provider errors, generation cost estimate, retries, storage, database pool saturation and per-tenant quota. Never log prompts/reference images/secrets by default.
- Load test progressively with a distributed generator and real DB/object storage before claiming a concurrent-user envelope. A local single-process test is not proof of 100K-user capacity.

---

## 10. M33+ staged implementation roadmap

Do not attempt every module in one enormous unreviewable PR. Deliver thin, tested vertical slices while keeping this guide as the north star.

### M33.0 — Architecture and capability truth (first)

- Add this guide to the repository and link it from the GIFTZ/LAXII/RIISHE documentation index.
- Generate a source-backed capability matrix from the real registries and API routes; mark `existing`, `partial`, `owner-setup-required`, `backend-required` or `unsupported`.
- Add a licence/model/font provenance decision table; no new dependencies in this slice.
- Add/update tests that prevent the docs/UI capability matrix from claiming nonexistent functionality.

### M33.1 — Brand intelligence and font pairing

- Extend existing design-language/brand-kit reasoning to ask for explicit brand attributes and audience context; do not infer sensitive personality traits.
- Produce 2–3 validated font pairings from `SITE_FONTS`, with rationale and previews; respect real weights and language glyph coverage.
- Add a user-overridable brand kit output shared by GIFTZ and LAXII only through authorised context.
- Tests: unknown font ID rejected, unsupported weight rejected, pairing respects user override, multilingual fallback, contrast/wrapping checks.

### M33.2 — Universal website planner and capability router

- Add a deterministic, registry-backed request classification mapping the website taxonomy in §3 to config mode, file mode, or backend-required.
- Produce sitemap, page plan, section/component plan, content gap list, feature matrix and assumptions.
- Route unsupported backend features to a clear architecture request instead of generating dead buttons.
- Tests across representative categories, ambiguous prompts, prompt injection and false backend claims.

### M33.3 — GIFTZ quality gate

- Consolidate accessibility, SEO, internal links, responsive layout and static performance checks into a report with evidence and explicit untested areas.
- Add real browser QA at 390/768/1024/1440, reduced motion and low bandwidth.
- Keep proposal approval, rollback and versioning unchanged.

### M33.4 — LAXII no-face-change and banner expansion

- Audit existing Preserve-pixel implementation and add direct regression tests proving face/subject core pixels remain unchanged under supported transforms.
- Expose clear identity-locked vs experimental re-render mode labels.
- Add versioned banner canvas presets while preserving canonical 2048×687.
- Improve deterministic typography with user-selected approved font families, glyph coverage and export round-trip checks.
- Benchmark provider/model hardware requirements; no model adoption before licence and quality gates.

### M33.5 — Resume quality and portfolio integration

- Use Reactive Resume as a UX reference only; extend existing LAXII service with ATS parsing checks, job-keyword gap reporting, additional templates and truthful cover-letter draft capability where tested.
- Preserve entity/skill anti-fabrication, provenance and manual review.
- Verify PDF/DOCX output with text extraction and page-break checks.

### M34 — Application Runtime discovery / prototype

- Threat model and prototype a separately isolated server-backed runtime. Start with one safe use case (e.g. server-backed contact forms or a private CMS), not arbitrary user code with unrestricted DB/network access.
- Select one backend module based on a real user requirement; compare Medusa only if commerce is chosen.
- Do not deploy or provision paid services until owner sign-off.

### M35 — RIISHE unified project delivery

- Add GIFTZ/LAXII tools/specialist profiles only where absent; reuse current workflow engine and approval policies.
- Implement task progress, typed artefact references, resumable orchestration and truthful final summaries.
- Keep publish/send/pay/delete/connect approval gates.

### M36+ — Business modules, scale and production readiness

- Add e-commerce, booking, membership, LMS, CMS or marketplace modules one at a time, each with a real backend, permissions, DB schema, API contracts, tests and rollback.
- Complete Postgres concurrency work, shared object storage, worker topology, soak tests, backup/restore drills and production operations gates.
- Activate public domains only after DNS/TLS/ingress and tenant security verification.

---

## 11. Verification and acceptance checklist

### Before touching code

- [ ] Fetch latest `origin/main`; record exact SHA and verify repository identity.
- [ ] `git status --short` and inspect all existing user changes; preserve them.
- [ ] Read `AGENTS.md`, `docs/BEAN_GITHUB_AUTH_STANDARD.md`, `scripts/ops/bean-sync.sh` and QA DB instructions.
- [ ] Confirm branch policy and ensure the feature branch does not already exist with useful work.
- [ ] Map each planned code change to existing files/tests; no guessed file paths.
- [ ] No production DB target, live deployment, domain/DNS or paid provisioning.

### Documentation and architecture

- [ ] All current claims verified against source on the current branch.
- [ ] Existing vs planned vs unavailable clearly labelled.
- [ ] Every third-party package/model/font has exact provenance and licence entry.
- [ ] No proprietary source/assets/trademarks copied.
- [ ] No duplicate editor, image engine, resume service, workflow engine or agent router introduced.

### GIFTZ

- [ ] Config plan validates against actual Zod schema/registries.
- [ ] Project-file plan paths and operations are confined; file count/size/time/token limits enforced.
- [ ] Generated HTML/JS/CSS uses no unsafe eval, arbitrary external script, `javascript:` URL or secret.
- [ ] All generated routes/pages have valid internal navigation and no missing local assets.
- [ ] All buttons/forms either work via an authorised backend or are correctly labelled as static/demo/unsupported.
- [ ] Build diagnostics are real and fed into bounded repairs.
- [ ] User sees diff + preview + known limitations before apply.
- [ ] Apply is atomic, source-aware, versioned and reversible.
- [ ] Publish creates a LIVE deployment only after successful build; rollback/unpublish works.

### Type, fonts and motion

- [ ] Font IDs/weights exist in the current font registry.
- [ ] Font licences, language glyphs and fallback rendering are checked.
- [ ] No font choice is based on sensitive inferred psychological traits.
- [ ] Contrast and responsive type scale verified.
- [ ] Motion preset and target are registry-valid; no untrusted executable motion config.
- [ ] Reduced-motion mode exposes all content immediately.
- [ ] Mobile performance and runtime cleanup pass.

### LAXII

- [ ] Provider advertises only capabilities it really supports.
- [ ] Input images are owned/authorised and private.
- [ ] Preserve-pixel path has numeric mask/core identity tests; failure blocks export.
- [ ] AI-guided likeness mode is clearly marked as non-guaranteed/experimental.
- [ ] Banner output dimensions/ratio/format/safe area and text pixels are verified.
- [ ] Resume facts/employers/skills/qualifications are traceable to user input.
- [ ] Exported PDF/DOCX content can be parsed and compared with approved facts.
- [ ] Temp files are private, age-swept and never served publicly.

### RIISHE

- [ ] All specialist tool names exist in the real registry and availability check.
- [ ] Tool input/output contracts are strict and bounded.
- [ ] Ownership/workspace scope is revalidated at execution time.
- [ ] Workflow steps reflect actual actions/results; model text cannot mark an action successful.
- [ ] Approval, pause, resume, cancel, retry, audit and idempotency work.
- [ ] Publish/send/pay/delete/connect require explicit final confirmation.

### Repository QA

Use the repository's own scripts and pinned runtime; do not assume command availability. Typical checks (confirm current `package.json`/scripts first):

- `bun test` and targeted tests for touched modules;
- TypeScript typecheck command used by this repository;
- ESLint;
- Prisma validation for both relevant schemas;
- schema parity check;
- Next production build;
- security/secret/dependency scans;
- browser E2E with screenshots at the documented viewport widths;
- isolated QA DB only, with `scripts/ops/qa-db-env.sh assert` and explicit `DATABASE_URL` pinning.

Compare failures against the untouched baseline commit; distinguish new failures from existing baseline failures. Do not hide failures by weakening tests or updating snapshots without examining the actual rendered output. Save reports and screenshots under the repository's established evidence locations.

### Publication protocol

- [ ] Use only `scripts/ops/bean-sync.sh` for permitted Folio publication.
- [ ] Normal fast-forward push only; no force push/history rewrite.
- [ ] Open a PR to `main` for owner review; never merge it yourself.
- [ ] Report the exact branch, commit SHA, tests, screenshots, known gaps and PR URL.
- [ ] Leave historical branches untouched; do not delete branches or clean up unrelated refs.

---

## 12. Required implementation report format

For every milestone, report:

1. **Baseline:** repository, branch, starting SHA, worktree status.
2. **Changed files:** exact path and reason for each; distinguish docs/tests/runtime/schema/UI.
3. **What works:** specific real behaviours that were executed and observed.
4. **What does not work yet:** exact unsupported or unconfigured capabilities.
5. **Tests:** command, exit code, pass/fail/skip counts and baseline comparison.
6. **Browser evidence:** desktop/mobile screenshots and console/network findings for affected flows.
7. **Security/licence:** threat checks, permission boundaries and new provenance records.
8. **Data/infrastructure:** state clearly whether migrations, external credentials, DNS, deployment or paid resources were untouched.
9. **Publication:** commit SHA, push verification and owner-review PR. Never say “done” if not remote-verified.

---

## 13. Z.ai execution prompt — use this with this guide

```text
Work in the existing GitHub repository: https://github.com/Ebin0471/BEAN-Folio
Official repo: Ebin0471/BEAN-Folio

Read and follow docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md as the M33+ product/engineering north star. First inspect the full current repository, latest origin/main SHA, worktree, AGENTS.md, docs/BEAN_GITHUB_AUTH_STANDARD.md, docs/oss/THIRD_PARTY_COMPONENTS.md, scripts/ops/bean-sync.sh and isolated QA DB instructions. The guide is not evidence that a feature exists: verify every capability in the actual source and label existing / partial / planned / unavailable accurately.

MISSION
Advance BEAN Folio toward a universal creative studio:
- GIFTZ: create professional websites across the site taxonomy from brief → research → sitemap → brand kit → typography → layout/components → animation → media → forms/integrations → SEO/accessibility/security → responsive/browser QA → build → reviewable proposal → approval → publish/version/rollback.
- LAXII: strict no-face-change avatar mode using protected original subject pixels; premium banners with deterministic text/layout; factual professional resumes/CVs with anti-fabrication and verified export.
- RIISHE: one conversational agent delegating to existing GIFTZ/LAXII/tools through the current specialist registry, tool contracts, durable workflow engine and approval policy.

NON-NEGOTIABLE
- Make minimal targeted changes only. Preserve existing UI, routes, data, APIs, configuration, integrations, algorithms, authorization gates and unrelated functionality. No broad rewrite, visual redesign, parallel builder, second AI workflow engine or speculative dependencies.
- Preserve all existing user work. Never reset, discard, overwrite or auto-format unrelated files.
- Never generate dead UI and call it working. A form, checkout, booking, login, dashboard or integration is only functional if a real authorised backend exists and passes tests.
- Keep config generation and project-file generation separate. Keep static-site execution sandboxed/CSP-restricted. Do not loosen CSP or expose host secrets to generated code.
- Use existing site-fonts/design-language/palette/component/GSAP systems first. Avoid unneeded library additions. Do not infer sensitive psychology to pick fonts; use explicit user style words, sector/audience and readability.
- For LAXII, distinguish preserve-pixel identity lock from AI-restyled likeness. Exact unchanged face pixels can only be claimed in the validated preserve-pixel path. Never claim AI re-rendering guarantees the same face.
- Audit code, weights, datasets, fonts and model licences separately. Do not use InstantID/InsightFace pretrained research-only weights commercially without a separate licence. Do not copy React Bits assets/code or GPL ComfyUI source into BEAN. Preserve third-party notices.
- All model output and uploaded files are untrusted. Validate all inputs, output schemas, paths, sizes, permissions, CSP, URLs and content.
- No production DB DDL/deploy/DNS/domain/paid service changes. Use the isolated QA DB only; pin DATABASE_URL and run scripts/ops/qa-db-env.sh assert before DB tests. Never run against a live/legacy DB.
- No force push, history rewrite, branch deletion or merge. Folio publication is governed by scripts/ops/bean-sync.sh. Open a PR for owner review; do not merge it.

IMPLEMENTATION APPROACH
1. Inspect the real code and write a source-backed capability/gap matrix. Check whether each item in the guide is already implemented before adding anything.
2. Choose the smallest high-value, independently testable M33 slice. Prefer documentation + registry/capability honesty + missing targeted regression tests first. Do not attempt a full-stack runtime, payments, booking or all website types in one milestone.
3. If adding functionality, use existing interfaces and extend the current source of truth. Add a focused regression test for every changed contract.
4. For LAXII identity lock, inspect current mask/compositing code and numerical tests; prove protected face/subject core pixels are unchanged after allowed frame mapping. If source coverage/segmentation fails, fail closed.
5. For GIFTZ, prove config/file-mode routing, actual preview/build, responsive browser rendering, internal links, real/unsupported form status and proposal approval. Never claim server-side behaviour from static output.
6. For RIISHE, add only missing typed tools through the real registry and current workflow engine. Enforce permissions/approval again inside tool execution. Do not let the planner set its own risk/permissions.
7. Run targeted tests, full relevant QA, lint, typecheck, schema validation/parity, production build and real browser screenshots. Compare every failure to the clean baseline. Inspect screenshots/code before claiming visual fixes.
8. Preserve evidence and write the implementation report in the exact format in §12 of the guide.
9. After successful verification, commit all approved milestone changes according to the repository's authorised workflow. Use scripts/ops/bean-sync.sh only. Push normal fast-forward and verify the remote SHA. Open a PR to main for owner review and stop; do not merge.

Start by reporting the current baseline SHA and clean/dirty worktree. If anything is ambiguous, make a safe source-backed choice and document it; do not ask me to repeat details already present in the repository or this guide.
```

---

## 14. Official and upstream references

### Existing BEAN source of truth

- [BEAN Folio repository](https://github.com/Ebin0471/BEAN-Folio)
- [Multi-tenant publishing architecture](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/architecture/multi-tenant-publishing.md)
- [Profession-aware generation](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/PROFESSION_AWARE_GENERATION.md)
- [GIFTZ animation AI pipeline](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/GIFTZ_ANIMATION_AI_PIPELINE.md)
- [GIFTZ motion engine](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/GIFTZ_MOTION_ENGINE.md)
- [GIFTZ animation presets](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/GIFTZ_ANIMATION_PRESETS.md)
- [GIFTZ component registry](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/GIFTZ_COMPONENT_REGISTRY.md)
- [LAXII engine guide](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/laxii/README.md)
- [Third-party components register](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/oss/THIRD_PARTY_COMPONENTS.md)
- [Website editor evaluation](https://github.com/Ebin0471/BEAN-Folio/blob/main/docs/oss/website-editor-evaluation.md)

### Upstream projects and licences to re-check before adoption

- [GrapesJS](https://github.com/GrapesJS/grapesjs)
- [Puck](https://github.com/puckeditor/puck)
- [Reactive Resume](https://github.com/reactive-resume/reactive-resume)
- [Fontsource](https://github.com/fontsource/fontsource)
- [Medusa](https://github.com/medusajs/medusa)
- [Motion](https://github.com/motiondivision/motion)
- [Diffusers](https://github.com/huggingface/diffusers)
- [IP-Adapter](https://github.com/tencent-ailab/IP-Adapter)
- [PuLID](https://github.com/ToTheBeginning/PuLID)
- [PhotoMaker](https://github.com/TencentARC/PhotoMaker)
- [InstantID](https://github.com/instantX-research/InstantID)
- [InsightFace](https://github.com/deepinsight/insightface)
- [ComfyUI](https://github.com/Comfy-Org/ComfyUI)
- [SIL Open Font License](https://openfontlicense.org/)

**Licence/legal status must be rechecked at the exact pinned commit and package/model version before any production addition.** This guide is engineering direction, not legal advice.
