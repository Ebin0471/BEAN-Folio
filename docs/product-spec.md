# BEAN Folio — Product Specification

**Summary:** BEAN Folio ("Show your work. Find your people.") is a multi-profession portfolio &
discovery platform. Creators in any field — film, design, technology, architecture, photography,
culinary and more — publish projects with process narrative, connect through follows and
inquiries, and get real (never fabricated) insights. This spec describes the 8 product areas,
the universal project model, visibility rules and the discover ranking approach, tied to what is
actually implemented.

**Status:** As built in this repository. **Backend behaviors below are implemented and
verified** (live API tests — `docs/testing.md`). The SPA shell, routing, session handling and
shared components are implemented; the 15 feature views in `src/views/*.tsx` were still stubs at
documentation time (frontend tasks in flight — see `docs/architecture.md` §4).

---

## 1. Who this is for

The platform is deliberately profession-agnostic. Example personas from the product vision:

| Persona | What they publish | What they need |
|---|---|---|
| Video editor | edits, color grades, motion pieces (video) | process narrative, client-ready presentation |
| Developer | apps, libraries, experiments (repo links, screenshots) | skill tags, repo links, discoverability by stack |
| Architect | drawings, renders, built work (images + docs) | case-study structure: brief → process → outcome |
| Photographer | series and singles (images) | feed presence, saves/collections |
| Chef | dishes, menus, events (images, audio) | profession taxonomy that isn't tech-only |
| Any creator | drafts before they're ready | private drafting, controlled publishing |

There is no "default profession". The taxonomy (18 curated professions with labels and groups,
40+ skills, self-seeding via `GET /api/professions` / `GET /api/skills`) is data, not code.

---

## 2. The 8 product areas

| # | Area | Purpose | Implemented behaviors (API-verified) |
|---|---|---|---|
| 1 | **Discover** | Editorial feed of public work | `GET /api/discover` returns ranked PUBLIC+PUBLISHED projects with human-readable `reason` strings; category filter + cursor pagination; block-aware |
| 2 | **Explore** | Search across published projects | `GET /api/search/projects` (q, category, skill, sort=recent\|saved), cursor-paginated, block-aware, PUBLIC-only. (The people directory was removed from Explore; profiles remain reachable at /u/<username>.) |
| 3 | **My Folio** | The creator's own profile + stats | profile GET with real stats (projects, published, followers, following, profile views); PATCH for profile fields, avatar/cover, professions, skills; public profile page with isFollowing/projects/collections |
| 4 | **Create Studio** | Drafting + publishing with the universal project model | project CRUD, publish gate (title + cover or ≥1 media), unpublish, own-list filtered by status, media upload/attach with captions+order, contributors, skills, tools |
| 5 | **BEAN Intelligence** | Consent-gated AI assistant | improve / suggest / chat features; capabilities endpoint with daily usage; conversation history persisted; own-data-only grounding (`docs/ai-integration.md`) |
| 6 | **Connect** | Inquiries, follows, notifications, saves | inquiries (INQUIRY/COLLABORATION/INVITE) with accept/decline + notifications; follow/unfollow with block enforcement; saves + collections; notifications with unread count |
| 7 | **Insights** | Owner-only analytics, honestly labelled "estimated" | totals (profile/project views, saves, followers), 14-day UTC series including zero days, top projects and per-project 14-day views — all from real dedup tables, no invented numbers |
| 8 | **Trust & Settings** | Privacy, data rights, safety | profileVisibility (PUBLIC/PRIVATE), AI consent toggle (audit-logged), blocks, reports, full JSON data export, account deletion (soft-delete + anonymization + session revocation), audit log viewer |

---

## 3. The universal project model

One model serves every profession. Fields (from `prisma/schema.prisma` and the implemented
zod validation):

| Field | Type / limit | Notes |
|---|---|---|
| `title` | string, 1..140 | required |
| `summary` | ≤ 200 | one-liner used on cards |
| `description` | ≤ 20 000 | long-form body |
| `category` | profession slug | validated against the `Profession` table (unknown → 400) |
| `visibility` | PUBLIC \| UNLISTED \| PRIVATE | default PUBLIC; see §4 |
| `status` | DRAFT \| PUBLISHED | not PATCH-able; only `publish`/`unpublish` change it |
| `brief` / `process` / `challenges` / `outcome` | ≤ 6 000 each | case-study narrative for design/architecture-style work |
| `role` | ≤ 120 | creator's contribution |
| `skills` | ≤ 15, resolved or auto-created by slug or label | join table `ProjectSkill` |
| `tools` | ≤ 15 names × 40 chars | stored as a JSON string array (SQLite has no array type) |
| `media` | ≤ 30 items, `{ mediaId, caption?, order }` | must be owned by the caller; join table `ProjectMedia` |
| `contributors` | ≤ 20 `{ name, role?, contribution? }` | optional link to platform users is a future field |
| `coverMediaId` | owned media id | optional; publish gate accepts cover OR ≥1 media |
| `externalUrl` / `repoUrl` | ≤ 300, http(s) | for developers and others linking out |

Drafts start at `status=DRAFT`. Publishing requires a non-empty trimmed title **and** (a cover
image **or** at least one attached media item) — the API returns the exact 400 message
*"Add a cover or at least one media item before publishing"*. Republishing after unpublish
keeps the original `publishedAt`.

---

## 4. Visibility rules (server-enforced)

| Visibility | Feed/search | Direct link (`GET /api/projects/:id`) | Saveable |
|---|---|---|---|
| `PUBLIC` | yes | yes | yes |
| `UNLISTED` | excluded | readable by anyone with the id | yes |
| `PRIVATE` | excluded | owner only (others get 404) | no |

Additional enforced rules:

- **Draft guard** — `GET /api/projects/:id` also 404s for non-owners while `status=DRAFT`,
  even if `visibility=PUBLIC` (a stricter rule than the base spec; prevents draft leaks).
- **Owner always sees own projects** in `GET /api/projects` across all visibilities, with
  `?status=DRAFT|PUBLISHED` filtering.
- **Profiles** — `profileVisibility` PUBLIC or PRIVATE: PRIVATE profiles 404 for everyone except
  the owner. Soft-deleted accounts are treated as not found on public endpoints.
- **Blocks** — neither party appears in the other's discover/search results, and follows or
  inquiries between them fail with 403 `Not allowed`.
- UI-level gating (hiding buttons/routes) is never the auth mechanism; the server re-checks
  everything (`docs/security.md` §4).

---

## 5. Discover feed ranking (no popularity-only, no fabricated stats)

As implemented in `GET /api/discover` (verified live, reasons observed):

- **Candidate pool:** PUBLISHED + PUBLIC projects with live owners, optionally filtered by
  category, block-filtered for the viewer, take 60 by `publishedAt` desc.
- **Score** (per candidate):

  ```
  score = exp(-days_since_publish / 14)                       // recency decay
        * (1 + 0.5·log1p(saves) + 0.3·log1p(views))           // real engagement (log-damped)
        + 0.8 · categoryBoost       // signed-in viewer's professions ∩ project.category
        + 0.5 · newCreatorBoost     // owner has exactly 1 published project
        + jitter(0 .. 0.05)         // deterministic FNV-1a hash — stable per result set
  ```

- **Ranking reasons** (priority order, shown in the feed):
  1. `"New on BEAN Folio"` (new-creator boost)
  2. `"Popular in <Profession label>"` (engagement > 1.4; label resolved from the live
     Profession table; skipped when the project has no category)
  3. `"Matches your profession: <Profession label>"`
  4. no reason string otherwise
- **Anti-goals honored:** never follower-count-only ranking; never invented metrics — every
  count comes from Prisma `_count` on real rows.
- **Pagination:** offset cursor (`limit` 1..24, default 12) with `nextCursor`.

---

## 6. Connect semantics

- **Inquiries** — `{ recipientUsername | projectId, type: INQUIRY|COLLABORATION|INVITE, subject,
  message }`. Recipient resolves from the username or the project owner. Self-inquiry → 400,
  blocked → 403, rate-limited 10/hour per sender. Recipients ACCEPT or DECLINE; both sides see
  the thread status; notifications fire for the inquiry and for the response.
- **Follows** — no self-follow, idempotent, block-aware (either direction → 403), FOLLOW
  notification only on first follow.
- **Saves & collections** — saving a project notifies the owner exactly once (first save only);
  collections are owner-scoped lists (name ≤ 80, optional description/isPublic) with items
  added/removed; PUBLIC visibility of collections exists in the model for future sharing.
- **Notifications** — types FOLLOW, INQUIRY, INQUIRY_RESPONSE, SAVE, SYSTEM; payload is a JSON
  object (e.g. `{ actor, actorUsername, projectTitle }`); read-marking is per-ids or all.

---

## 7. Trust & data rights

- **Privacy controls:** `profileVisibility` and `aiConsent` live in Settings; every change is
  audit-logged (`privacy.update` with changed-field metadata).
- **AI consent:** BEAN Intelligence is off by default; enabling is explicit and revocable
  (`docs/ai-integration.md`).
- **Data export:** synchronous full JSON export of the account (profile, taxonomy, projects,
  collections, saves, follows, inquiries, notifications, AI conversations — never password
  hashes), delivered as an `ExportJob` with READY/FAILED status, owner-only fetch.
- **Deletion:** `POST /api/me/deletion` records a `DeletionRequest`, immediately soft-deletes
  the account (email/name anonymized, username and profile fields nulled), revokes all sessions,
  and audit-logs `account.deleted`.
- **Audit trail:** owners can list their own audit events (actions, targets, timestamps — no
  internal metadata).
- **Reports:** PROJECT or PROFILE targets with reason + details, rate-limited, audit-logged;
  moderation tooling itself is minimal (`docs/known-limitations.md`).

## 8. Related docs

`docs/api.md` (endpoint truth) · `docs/database.md` (data model) · `docs/security.md` ·
`docs/ai-integration.md` · `docs/known-limitations.md`
