# BEAN Folio — Database (SQLite + Prisma, as built)

**Summary:** The data model is a 27-model Prisma schema on SQLite (`db/custom.db`), covering
identity, taxonomy, media, projects, discovery, connections, insights, AI and governance. SQLite
has no native enums or arrays, so status/visibility fields are plain strings validated with zod
at the API boundary, and multi-value fields use join tables or JSON-string columns. Deletes
cascade from owning aggregates. This doc lists every model, the uniqueness/index design, the
view-dedup mechanism, transaction usage, and the PostgreSQL migration path.

**Status:** As built in this repository — schema pushed with `bun run db:push` and exercised by
the verified API flows (`docs/testing.md`).

---

## 1. Models at a glance (27)

| Model | Purpose |
|---|---|
| `User` | Account + profile (email/passwordHash, username, headline, bio, location, avatar/cover, availability, links, profileVisibility, aiConsent, onboarded, isDemo, role, deletedAt) |
| `Session` | Server-side sessions (SHA-256 token hash, 30-day expiry) |
| `Profession` | Curated profession taxonomy (slug, label, group, order) |
| `ProfileProfession` | User↔Profession join (composite PK) |
| `Skill` | Skill taxonomy (slug, label) — free-form creation allowed |
| `ProfileSkill` | User↔Skill join (composite PK) |
| `MediaAsset` | Uploaded file metadata (kind, mime, size, storagePath, status) |
| `Project` | Universal project aggregate (title/summary/description/category/status/visibility, brief/process/challenges/outcome/role, tools JSON, links, coverMediaId, publishedAt) |
| `ProjectSkill` | Project↔Skill join (composite PK) |
| `ProjectMedia` | Project↔MediaAsset join with `order` + `caption` (composite PK) |
| `Contributor` | Named contributors per project (userId link reserved) |
| `SavedProject` | Save/bookmark per user+project (composite PK) |
| `Collection` | User-owned named list of projects (isPublic flag) |
| `CollectionItem` | Collection↔Project membership (composite PK) |
| `Follow` | Social graph edge follower→following (composite PK) |
| `Inquiry` | INQUIRY/COLLABORATION/INVITE message with PENDING/ACCEPTED/DECLINED status |
| `Notification` | FOLLOW/INQUIRY/INQUIRY_RESPONSE/SAVE/SYSTEM events with JSON payload |
| `Block` | Block edge blocker→blocked (composite PK) |
| `Report` | Moderation reports (targetType/targetId/reason/status) |
| `ProjectView` | View ledger for projects (deduped per viewer/day) |
| `ProfileView` | View ledger for profiles (deduped per viewer/day) |
| `AiConversation` / `AiMessage` | BEAN Intelligence chat threads |
| `AiUsage` | Per-call AI accounting for the 30/day quota |
| `AuditEvent` | Sensitive-action trail (actor, action, target, meta JSON) |
| `ExportJob` | Data-export jobs (payload JSON, READY/FAILED) |
| `DeletionRequest` | Deletion requests (PENDING→COMPLETED) |

## 2. Keys, uniqueness, indexes

**Natural uniqueness:**

| Constraint | Model / columns |
|---|---|
| Account identity | `User.email @unique`, `User.username @unique` (nullable — anonymous-adjacent states before onboarding) |
| Sessions | `Session.token @unique` — stores the **SHA-256 hash**, never the raw cookie value |
| Taxonomy | `Profession.slug @unique`, `Skill.slug @unique` |
| Media | `MediaAsset` rows are cuid-keyed; blobs live on disk keyed by generated filenames |

**Composite primary keys (idempotent joins):**
`ProfileProfession(userId, professionId)` · `ProfileSkill(userId, skillId)` ·
`ProjectSkill(projectId, skillId)` · `ProjectMedia(projectId, mediaId)` ·
`SavedProject(userId, projectId)` · `CollectionItem(collectionId, projectId)` ·
`Follow(followerId, followingId)` · `Block(blockerId, blockedId)`

**View dedup uniqueness** (the core insights mechanism):

```prisma
model ProjectView {
  // …
  @@unique([projectId, viewerKey, day])
  @@index([projectId])
}
model ProfileView {
  // …
  @@unique([profileUserId, viewerKey, day])
  @@index([profileUserId])
}
```

**Other indexes:** `Session(userId)`, `MediaAsset(ownerId)`, `Project(ownerId)`,
`Project(status, visibility, publishedAt)` (serves the discover candidate query),
`Inquiry(recipientId)`, `Inquiry(senderId)`, `Notification(userId)`,
`Follow(followingId)`, `AiConversation(userId)`, `AiMessage(conversationId)`,
`AiUsage(userId, feature)` (serves the daily-quota count).

## 3. JSON-string fields (SQLite has no arrays/enums)

| Column | Format | Validated by |
|---|---|---|
| `Project.tools` | JSON string array of tool names (≤ 15 × 40 chars) | zod at the API boundary; serialized back to `string[]` in DTOs |
| `Notification.payload` | JSON string, default `"{}"` (e.g. `{ actor, actorUsername, projectTitle }`) | producer-side only; parsed for the client |
| `AuditEvent.meta` | JSON string, default `"{}"` | never returned to clients by `GET /api/me/audit` |
| `ExportJob.payload` | Full JSON export of the owner's data | written by the export route |

String "enums" (`status`, `visibility`, `kind`, `role`, `type`, …) are constrained by zod
schemas in the route handlers, not by the database — the schema comments document this
deliberately.

## 4. View dedup design

- `resolveViewerKey()` (`src/lib/api-helpers.ts`): signed-in → `u:<userId>`; anonymous →
  `a:<uuid>` minted into the `bean_vk` cookie (httpOnly, SameSite=Lax, 1-year maxAge).
- `utcDay()` → `YYYY-MM-DD` UTC string.
- Recording is an **upsert** on the unique `(target, viewerKey, day)` tuple, so repeats within a
  UTC day are no-ops. Owner views are never recorded; drafts/PRIVATE never recorded.
- Recording is always wrapped so it can never fail the request that triggered it.
- Consequence: counts are **estimates** (same person on two devices with cleared cookies counts
  twice; one person counts once per day) — surfaced honestly in the Insights UI copy.

## 5. Transactions & integrity patterns

- **Onboarding/profile PATCH** — professions/skills full-replace inside `db.$transaction`;
  skill creation is P2002-safe (race-safe upsert semantics).
- **Project create** — project + skills + media + contributors in one transaction; PATCH
  re-resolves skills, re-verifies media ownership, then replaces all child rows in one
  transaction.
- **Deletion** — `DeletionRequest` created, then user anonymized/soft-deleted, then all sessions
  revoked.
- **Cascades** — deleting a User cascades to sessions, taxonomy links, media rows, projects,
  collections, saves, follows, inquiries, notifications, AI rows, export jobs, deletion
  requests; `AuditEvent` and `Inquiry.project` use `SetNull` to survive.
- `db.ts` uses a dev-singleton PrismaClient with `log: ['warn','error']` (query logging removed
  during the audit).

## 6. PostgreSQL migration path

The schema was written to convert cleanly:

| Concern | SQLite (today) | PostgreSQL (target) |
|---|---|---|
| Enums | String columns + zod | Native `CREATE TYPE` enums (status, visibility, kind, inquiry type/status, report target/status, roles) |
| Multi-value fields | Join tables / JSON strings | Keep join tables for relations (they carry FK integrity); `tools` can become `text[]`; `Notification.payload`/`AuditEvent.meta` become `jsonb` |
| Search | ASCII case-insensitive `contains` OR-chain across title/summary/description | `tsvector` full-text columns + GIN indexes for projects/profiles; trigram indexes for partial username matches |
| Concurrency | Single-writer lock (whole-DB write serialization) | MVCC; connection pooling via pgBouncer |
| Migrations | `prisma db push` (prototype-grade) | `prisma migrate` with a real migrations folder (`docs/deployment.md` §3) |
| Row-level access | App-layer checks only | Optional PostgreSQL RLS as defense-in-depth under the Supabase pattern |
| Analytics queries | 14-day series grouped in app code from `ProjectView.day` | Materialized rollups or `date_trunc` group-bys once volume grows |

Steps: switch `provider = "postgresql"`, add enums + native types, `prisma migrate dev`
(scaffold initial migration), import SQLite data (Prisma has no cross-engine migrate; a small
ETL script over the export JSON works — the `ExportJob` payload shape is already the canonical
row set), then re-run the verification suite from `docs/testing.md`.

### 6.1 Prepared migration kit (as built)

The migration is prepared and rehearsed up to the boundary the sandbox allows
(no PostgreSQL server exists here, so the import + live-verification steps are
documented, not executed — nothing in the live app was switched):

- `prisma/schema.postgres.prisma` — Phase-A target schema: byte-identical model
  surface with `provider = "postgresql"`, so the generated client (and therefore
  all app code) works unchanged on both engines.
- `scripts/migrate-to-postgres.ts` — ETL. `export` (executed; read-only against
  the live SQLite file) produced `pg-migration/{data.json, inserts.sql, counts.json}`
  — 27 tables in FK-safe order, transactional + idempotent SQL. `import` refuses
  to run unless `DATABASE_URL` is a postgresql:// URL and a PG client is generated.
- `scripts/verify-postgres-migration.ts` — runbook-verifier for the live PG
  database: row counts vs `counts.json`, zero orphans for all 28 FK pairs,
  uniqueness, dedup invariants, authorization-critical domains, ILIKE search
  parity, index presence.
- `pg-migration/rollback.md` — cutover + rollback runbook and the
  engine-behavior matrix (gitignored artifacts contain user data).

**SQLite-specific behaviors discovered and addressed:**
`contains` without `mode: "insensitive"` is ASCII-case-insensitive on SQLite
(`LIKE`) but case-sensitive on PostgreSQL — both search routes now pass
`mode: "insensitive"` (a no-op on the SQLite connector, `ILIKE` on PG), so
search behavior is preserved across the engine swap. Long-form text needs no
action: Prisma maps `String` → `text` on PG natively. JSON-in-text columns
(`tools`, `payload`, `meta`) and native enums stay as-is in Phase A by design
(zero-app-change); Phase B converts them to `jsonb`/`text[]`/`CREATE TYPE` in
its own PR with app-code updates.

## 7. Related docs

`docs/api.md` (how each table is exposed) · `docs/product-spec.md` §4 (visibility semantics) ·
`docs/deployment.md` (migrate vs push in production) · `docs/known-limitations.md` (SQLite
single-writer constraint)
