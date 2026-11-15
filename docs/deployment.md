# BEAN Folio — Deployment

**Summary:** What is true today: BEAN Folio runs in this sandbox with the dev-grade server
(`bun run dev`) on port 3000, on SQLite, with local-disk media. **No production deployment has
been performed** — no build has been shipped, no domain attached, no TLS terminated, no
production database provisioned. This page states that plainly, then provides the production
runbook (build + standalone server, PostgreSQL migration, S3 media, secure cookies, TLS,
monitoring, backups, rollback) and a pre-launch checklist.

**Status:** As built in this repository — **dev-grade only, not deployed**. Everything from §3
onward is a runbook for work that has not yet been executed.

---

## 0. Deployment status — verified facts (no staging, no placeholders)

Checked directly in the repository/host (nothing inferred):

| Check | Result (verified) |
|---|---|
| Connected to GitHub? | **YES** — `origin = https://github.com/Ebin0471/BEAN-Folio.git` (owner-confirmed PRIVATE). Publishing runs exclusively through the verified `scripts/ops/bean-sync.sh` workflow (source only — see docs/ops/MILESTONE_EXECUTION_PROTOCOL.md §5); local `main` history is verified clean of runtime data |
| Deployed on Vercel? | **NO** — no `.vercel/` directory, no CLI auth, no project |
| Production domain? | **NONE exists** — there is no `.vercel.app` URL to use; `NEXT_PUBLIC_APP_URL` therefore cannot be set to anything real yet |
| Runtime | Bun + Next.js 16 (App Router); no Bun-specific APIs in `src/` — builds as a standard Node/Next app |
| Database | SQLite (`db/custom.db`) — **does not persist on Vercel** (ephemeral filesystem). Postgres mirror schema (`prisma/schema.postgres.prisma`, 85 models — full regeneration, M22 Phase 2) + ETL (`scripts/migrate-to-postgres.ts`, `verify-postgres-migration.ts`) exist; `prisma generate --schema prisma/schema.postgres.prisma` and the schema DDL (`bunx prisma migrate diff --from-empty --to-schema-datamodel … --script`) both verified |
| Media | **Storage layer implemented** (`src/lib/storage.ts`): local-disk driver in the sandbox, S3-compatible driver (`@aws-sdk/client-s3`) for production — verified end-to-end against a local S3-compatible server (upload → object stored → byte-identical serve → delete). The S3 driver MUST be configured on stateless hosts; until its env vars are set, uploads on Vercel are ephemeral. The multipart upload endpoint (`POST /api/media/upload`) serves bodies up to Vercel's ~4.5 MB function limit — large videos need the presigned-direct-upload upgrade (docs/media-pipeline.md §5) |
| AI features | `z-ai-web-dev-sdk` is the sandbox runtime gateway; on Vercel, AI calls (`/api/ai/*`) will error at runtime until a provider key is configured (`docs/ai-integration.md` §9). **Not a build blocker**; publishing/sharing does not depend on AI |

### 0.1 What was prepared in the repo for deployment

- **Git hygiene (security):** `.env`, `db/custom.db` (contains account password hashes) and user-uploaded
  media files are **excluded from the deploy branch** (see §0.2 Step A). `.env` was never committed to any
  commit in history; `git ls-tree` on the deploy branch must show zero runtime-data files.
- **`package.json` → `vercel-build` script:** Vercel runs `vercel-build` (when present) instead of
  `build`. It generates the Prisma client from the **Postgres** schema (`prisma/schema.postgres.prisma`)
  before `next build` — required because production runs Postgres while the local sandbox runs
  SQLite. Local `bun run build` is unchanged.
- **Media storage layer (`src/lib/storage.ts`):** `putObject/getObject/deleteObject` with a local-disk
  driver and an S3-compatible driver; the multipart upload endpoint (`POST /api/media/upload`), the
  serving route and deletes all go through it. Storage paths are validated against path traversal;
  S3 config is all-or-nothing. Verified by unit tests (`tests/storage.test.ts`) and live E2E in both
  drivers. Without S3 env vars the app behaves exactly as before (local `uploads/`).
- **`.env.example`** — the authoritative list of environment variables and their meaning (now
  including the S3 storage block and the serverless body-size caveat).
- `output: "standalone"` in `next.config.ts` is Vercel-compatible; `src/proxy.ts` (path-form
  `/u/<username>` → `/#/u/<username>` 308 redirect) is supported by Vercel with zero extra config.

### 0.2 Exact steps to connect GitHub and deploy (manual — requires your GitHub/Vercel accounts)

Nothing below has been executed; there is no deployment to verify. These are the real steps:

**Step A — Publishing to GitHub (supersedes the pre-M18 deploy-branch flow)**

> **Runtime-data warning (updated 2026-11-14):** an older revision of this
> document instructed `git push -u origin deploy:main`. That instruction is
> **VOID and DANGEROUS**: the local `deploy` branch carries historical
> `db/custom.db` blobs (account password hashes) and ~746 `uploads/` media
> files in its history. It must NEVER be pushed, in any direction. The
> current verified policy: publish **only** through `scripts/ops/bean-sync.sh`
> from the verified-clean `main` lineage (secret scan + runtime-data scan +
> push + remote-SHA verification), then confirm with
> `git ls-remote origin main`. See docs/ops/MILESTONE_EXECUTION_PROTOCOL.md §5.

```bash
git branch -v                        # publish from 'main' only; 'deploy' and 'github-clean' are NEVER pushed
scripts/ops/bean-sync.sh commit -m "feat(scope): what + why" -- <approved paths...>
git ls-remote origin main            # MUST equal local HEAD (independent verification)
```

Before pushing, sanity-check the tree you are about to publish — the bean-sync
workflow already runs the secret scan and the runtime-data scan on the staged
snapshot; the tracked-tree scan below is the pre-publish eyeball check:

```bash
scripts/ci/guard-runtime-data.sh            # tracked tree: fails on ANY runtime-data path
scripts/ci/guard-runtime-data.sh --staged   # what the next commit would add
```

Publishing is MAIN-ONLY and fast-forward-only: `scripts/ops/bean-sync.sh` is
the only documented publishing path. There is no squash-and-push bypass and
no alternative branch publish — runtime data never reaches GitHub
(DEVELOPMENT_SAFETY §8).

**Step B — Create the production database and media bucket**

*Database (Postgres):*

1. Vercel Dashboard → your (new) project's **Storage** tab → **Create Database** → **Postgres**
   (Neon-powered) → create. This also works before the first deploy via a standalone Vercel
   Postgres store, then link it to the project.
2. Copy the **connection string** (`postgresql://…`) — you will paste it as `DATABASE_URL`.
3. Create the schema (run locally, from the repo — against Postgres, NOT the SQLite one):

   ```bash
   DATABASE_URL="postgresql://…your-pg-url…" bunx prisma db push --schema prisma/schema.postgres.prisma
   ```

*Media bucket (S3-compatible object storage — REQUIRED for uploads to survive redeploys):*

1. Easiest if you already use Supabase: create a project at supabase.com → **Storage** →
   **New bucket** (e.g. `bean-media`, keep it **private**) → **Settings → Storage** S3-compatible
   credentials: copy the endpoint (`https://<project-ref>.supabase.co/storage/v1/s3`), region,
   access key id and secret. (Alternative: AWS S3 or Cloudflare R2 — any S3-compatible provider
   works; create a private bucket + access keys.)
2. You will paste four values as env vars in Step C: `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ optional `S3_REGION`).
3. Media is NEVER served from the bucket directly — it stays private and streams through
   `GET /api/media/:id/raw` behind the app's authorization ladder. No bucket CORS/policy setup is
   needed.

**Step C — Import the repo into Vercel (first deploy)**

1. Vercel Dashboard → **Add New… → Project** → **Import** the GitHub repo (authorize GitHub when asked).
2. Framework preset auto-detects **Next.js**. Build Command stays default — Vercel automatically
   uses the `vercel-build` script (Postgres client + `next build`).
3. In **Environment Variables** (choose scope **Production** — also check Preview if you want it there):
   - `DATABASE_URL` = the Postgres connection string from Step B.
   - `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` = media bucket from
     Step B (add `S3_REGION` if your provider requires it). Without these the app still deploys
     and publishes websites, but uploaded images/videos live on the ephemeral filesystem and are
     **lost on the next redeploy**.
   - Leave `NEXT_PUBLIC_APP_URL` unset for this first deploy (the domain doesn't exist yet —
     see Step D). Share links fall back to `VERCEL_URL`, which Vercel sets automatically.
4. Click **Deploy**. Wait for **Ready**.

**Step D — Set `NEXT_PUBLIC_APP_URL` to the real domain, then redeploy**

1. After Deploy #1: Vercel Dashboard → **Settings → Domains** → the stable production domain is
   shown (e.g. `https://bean-folio.vercel.app`, or your custom domain if you add one — buying a
   domain is NOT required; the `.vercel.app` domain is a real, public HTTPS origin).
2. Project → **Settings → Environment Variables** → add (scope **Production**):
   - `NEXT_PUBLIC_APP_URL` = that exact origin, e.g. `https://bean-folio.vercel.app`
     (HTTPS, no trailing slash, no path).
3. **Redeploy** so the new variable is compiled in (`NEXT_PUBLIC_*` values are inlined at BUILD
   time): Deployments tab → ⋯ on the latest production deployment → **Redeploy**. (If you had set
   it before the first deploy this redeploy would be unnecessary.)
4. Verify the value took effect: open the deployed site, publish a website in Website Studio —
   the publish dialog must show `https://<your-domain>/u/<username>`. If it instead says
   production domain configuration is required, the variable is missing/mistyped/in the wrong scope.

**Step E — Your data on the new deployment (important, honest constraints)**

- The production Postgres starts **empty**. Your sandbox account (e.g. `ebin0471`), projects and
  site design do **not** exist there until you either (a) register fresh on the deployed site and
  rebuild, or (b) run the ETL carry-over below. A pre-migration backup of the sandbox data was
  exported to `pg-migration/` (`data.json`, `inserts.sql`, `counts.json` — 808 rows; gitignored,
  never pushed).
- Optional carry-over (rows only — uploaded image/video BLOBS are not transferred, so media must
  be re-uploaded after migrating; the dump includes a few harmless QA test accounts
  (`qa-*`, `pub-e2e-*`, `media-e2e-*`) — prune them from `data.json` first if you want a clean start):
  ```bash
  bun scripts/migrate-to-postgres.ts export                                   # reads local SQLite (creates pg-migration/)
  DATABASE_URL="postgresql://…" bunx prisma generate --schema prisma/schema.postgres.prisma
  DATABASE_URL="postgresql://…" bun scripts/migrate-to-postgres.ts import     # writes Postgres
  DATABASE_URL="postgresql://…" bun scripts/verify-postgres-migration.ts
  ```
- **Media persistence verdict:** with the S3 env vars configured (Step B/C), uploaded media is
  stored in object storage and **survives redeploys** (verified logic; final confirmation is the
  §0.3 checklist item). Without them, uploads land on Vercel's ephemeral filesystem and are lost
  on the next redeploy (the DB row survives; the blob does not).

### 0.3 Verification checklist to run on the deployed URL (after Steps A–D)

I (the build agent) cannot execute these without a real deployment; they are the acceptance test:

- [ ] External incognito browser (no session, no login): open `https://<domain>/u/<username>`
      → 308-redirects to `/#/u/<username>` → renders the creator's standalone website with no
      platform chrome; refresh keeps working.
- [ ] Publish → dialog shows `https://<domain>/u/<username>`; **Copy Link** pastes exactly that;
      **Share** uses that URL; **Open Live Website** opens exactly that URL (all three agree).
- [ ] Edit draft → live site unchanged → **Republish** → same URL, new content live →
      **Unpublish** → public access blocked immediately, draft preserved.
- [ ] With S3 env vars set: upload an image, **redeploy**, confirm it still renders (expected: YES).
      Without them: expect the image to vanish after a redeploy (ephemeral filesystem — §0.2 Step B/C).
- [ ] Upload-size note: Vercel functions accept bodies up to ~4.5 MB; larger files fail until the
      presigned-direct-upload upgrade ships (docs/media-pipeline.md §5).
- [ ] `GET https://<domain>/api/health` → `{"ok":true,…}` (NOTE: this endpoint does **not** touch
      the database — it proves the deployment is alive, not that the DB works).
- [ ] `GET https://<domain>/api/professions` → `200` with a JSON array (DB-BACKED smoke test —
      proves the PostgreSQL connection, credentials and schema all work from the deployment).
- [ ] `GET https://<domain>/api/discover` → `200` JSON (second DB-backed route).

### 0.4 Troubleshooting — production database authentication failure (Prisma P1000)

**Symptom in the Vercel logs:** `PrismaClientInitializationError: Authentication failed against
database server. The provided database credentials for <user> are not valid.` — routes that touch
the database (`POST /api/auth/register`, `GET /api/professions`, `GET /api/discover`, …) return 500.

**What this error means (and does not mean):** the PostgreSQL server WAS reached — DNS, TCP and
TLS all succeeded — and the server itself rejected the user/password pair (PostgreSQL error class
`28P01`/`28000`). It is therefore NOT an application bug, NOT a schema/model problem, and NOT an
unreachable host (that would be Prisma P1001). The build is working as designed: the Vercel build
(`vercel-build` script) generates the Prisma client from `prisma/schema.postgres.prisma`, whose
datasource is `provider = "postgresql"` with `url = env("DATABASE_URL")`.

**`DATABASE_URL` alone is sufficient — no `DIRECT_URL` is required by this project.** The schema
declares only `DATABASE_URL`; nothing in the repo references `DIRECT_URL`; and no `prisma
migrate`/`db push` command runs on Vercel (the `vercel-build` script only runs `prisma generate`,
which is pure code generation and needs no database connection). Schema changes are applied
manually from your machine (see Stage 2 below). `DIRECT_URL` would only become necessary if you
later run `prisma migrate` from CI against a pooled connection endpoint (pgbouncer) — at that
point add `directUrl = env("DIRECT_URL")` to `prisma/schema.postgres.prisma`.

**Never guess, hand-type or fabricate credentials.** The fix is always: copy the CURRENT connection
string from your database provider's dashboard and paste it into Vercel.

Where to retrieve the real connection string:

| Provider | Where to copy it |
|---|---|
| Vercel Postgres (Neon-powered) | Project → **Storage** tab → your database → **`.env.local` tab** (or **Connect**) → copy `DATABASE_URL`. Warning: **Reset password** invalidates every previously copied string. |
| Supabase | Project → **Settings → Database → Connection string → URI**. POOLED hosts (`.pooler.supabase.com`) require user `postgres.<project-ref>`; the DIRECT host (`db.<ref>.supabase.co`) requires plain `postgres`. Mixing them produces exactly this auth failure. |
| Neon (console.neon.tech) | Dashboard → **Connection Details** → pick pooled or direct and copy the URI. |
| Self-hosted / other | Your DBA/provider console; verify with a local `psql` first. |

Which Vercel field to update: **Project → Settings → Environment Variables → `DATABASE_URL`** →
scopes **Production** and **Preview** → Save → then **Redeploy** (Deployments → latest production
deployment → Redeploy). Environment-variable changes apply only to NEW deployments — an existing
deployment keeps the old value until it is redeployed.

Common concrete causes of `28P01` (check in this order):

1. The database password was **reset/rotated** after the env var was saved.
2. **Supabase user/host mismatch** — pooled host with direct username, or vice versa (see table).
3. The URL was **typed by hand** instead of copied (placeholder password never replaced).
4. Special characters in the password **not percent-encoded** (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `%` → `%25`).
5. A **trailing space/newline** captured when pasting the value into the Vercel field.
6. Parts of **two different databases** mixed (host from one store, credentials from another).

Verify before redeploying — read-only probe (runs on YOUR machine, never on Vercel; redacts the
password and full URL from all output; executes only SELECT/to_regclass lookups; exit codes:
0 ready · 1 schema missing · 2 config · 3 network · 4 credentials rejected):

```bash
DATABASE_URL="postgresql://…the real string…" bun scripts/check-postgres-connection.ts
```

The probe also reports **Stage 2**: whether the BEAN Folio tables exist. A credentials fix changes
nothing in the database, so after the auth error disappears the deployment may still need its
schema applied once (empty production database — non-destructive):

- **Option A (documented runbook, empty DB only):**
  `DATABASE_URL="postgresql://…" bunx prisma db push --schema prisma/schema.postgres.prisma`
- **Option B (preferred — freshly generated, reviewed DDL):** regenerate the initial DDL from the
  CURRENT schema and review it before applying:
  `bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.postgres.prisma --script > new-initial-schema.sql`
  ⚠️ The checked-in `docs/deployment/initial-schema.sql` and `additive-schema.sql` are **HISTORICAL
  artifacts from before the LAXII feature set** — they cover only 31 tables and are missing the five
  LAXII tables (`LaxiiConversation`, `LaxiiMessage`, `LaxiiImageVersion`, `LaxiiUsage`,
  `LaxiiResume`) plus their indexes/FKs. They are NOT safe for the current 36-model schema; the
  readiness probe now expects 36 tables and will keep reporting the LAXII objects missing if a
  historical file is applied. Use `scripts/check-postgres-schema-readiness.ts` to print an
  additive-only plan for exactly the objects your database lacks (it carries verified DDL for all
  nine post-27-baseline tables, LAXII included).

**Data-safety rules:** NEVER run a data-lossing schema command against a database that already
holds accounts/portfolios (the `db:push` script no longer carries `--accept-data-loss` — keep it
that way; production changes must use reviewed, additive migrations after a backup). The optional
data carry-over is the ETL import in §0.2 Step E, which only ever INSERTs and must be run deliberately.

After the credentials are fixed and the schema is present, confirm from the deployed URL with the
§0.3 checklist items: `GET /api/professions` and `GET /api/discover` (DB-backed), then registration
and login from a browser.

### 0.5 Database initialization & schema readiness — committed SQL + read-only verification

**Which database is "production"? Never assume.** The app uses exactly the database named by the
`DATABASE_URL` environment variable on Vercel (Production scope). The readiness probes print
non-secret diagnostics (`target host: host:port`, `database:`, `user:`) — cross-check the host
against the value stored in Vercel → Settings → Environment Variables and against your provider's
dashboard. A look-alike Supabase project that was inspected manually is NOT proof that the Vercel
variable points at the same database; only the probe run against the real `DATABASE_URL` (copied
from the provider dashboard on YOUR machine) verifies the target.

**Committed artifacts (⚠️ HISTORICAL — generated from the pre-LAXII 31-table
`prisma/schema.postgres.prisma`; the current mirror holds 85 models and is proven parity-identical
to `prisma/schema.prisma` via scripts/check-schema-parity.ts (M22 Phase 2 regeneration). Do NOT
apply the files below as-is to a database meant to serve the current app — 50+ models incl. the
whole social/GIFTZ/RIISHE layers would be missing; regenerate the DDL from the current mirror
instead. The newer reviewed additive artifact
`docs/deployment/additive-portfolio-models-migration.sql` (3 tables, 5 indexes — Portfolio /
PortfolioRevision / DesignChatMessage restoration) is NOT historical: it is the current
delta for databases created before the M22 model restoration):**

| File | Contents | Use when |
|---|---|---|
| `docs/deployment/initial-schema.sql` | ⚠️ HISTORICAL (pre-LAXII). Complete initial DDL for the 31-table era: 31 tables, 26 indexes (incl. uniques), 40 foreign keys, `CREATE SCHEMA IF NOT EXISTS public`. Zero DROP/TRUNCATE/DELETE/UPDATE. | Reference only — regenerate from the current schema for a fresh database. |
| `docs/deployment/additive-schema.sql` | ⚠️ HISTORICAL (pre-LAXII). Additive-only delta on top of the pre-Task-26 baseline (27 tables): 8 `ADD COLUMN`, 4 `CREATE TABLE` (SiteDesign, SiteMaterial, SiteRevision, PasswordResetToken), 6 `CREATE INDEX` (2 unique), 6 `ADD FOREIGN KEY`. Zero DROP/type changes. | Reference only — for the LAXII delta use the probe's printed plan. |

**Step 1 — Probe (read-only, secret-safe, on YOUR machine):**

```bash
DATABASE_URL="postgresql://…the real string from your dashboard…" bun scripts/check-postgres-schema-readiness.ts
```

Exit codes: `0` ready · `1` schema incomplete (prints an additive-only plan limited to the
missing objects — PRINTED, never executed) · `2` config · `3` network · `4` credentials rejected ·
`5` unexpected. The password and the full connection string are redacted from every output line.
The probe checks all 36 tables (including the LAXII set), the 8 post-migration User columns,
`Project.coverMediaId` FK + `Project_category_idx`, and every index/FK of the nine models added
after the 27-table legacy core (SiteDesign, SiteMaterial, SiteRevision, PasswordResetToken,
LaxiiConversation, LaxiiMessage, LaxiiImageVersion, LaxiiUsage, LaxiiResume). It refuses to propose
a partial plan when core tables are missing (it points at a fresh from-empty DDL instead).

**Step 2 — Apply the ONE matching file (manual, explicit approval required):**

- *Supabase:* Dashboard → **SQL Editor** → New query → paste the entire file contents → **Run**.
  The statements are plain PostgreSQL DDL; no extensions or functions are required.
- *psql alternative:* `psql "$DATABASE_URL" -f docs/deployment/initial-schema.sql` (or
  `additive-schema.sql`).
- Take a backup/snapshot first (Supabase → Database → Backups). Apply exactly once — the DDL is
  not `IF NOT EXISTS`; if a statement fails, re-run the probe and apply only the statements for
  objects still missing. Both files preserve all existing rows: the additive file contains no
  data-touching statement, and the initial file is only for a database with no BEAN Folio tables.

**Step 3 — Verify afterwards (read-only SQL, Supabase SQL Editor or psql):**

```sql
-- expect 31 rows, including SiteDesign, SiteMaterial, SiteRevision, PasswordResetToken
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;

-- expect exactly the 8 post-migration User columns
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'User'
   and column_name in ('coverPositionY','avatarFit','avatarZoom','avatarPosX','avatarPosY',
                       'experienceLevel','recoveryKeyHash','recoveryKeySetAt');

-- expect exactly these 6 indexes
select indexname from pg_indexes
 where schemaname = 'public' and indexname in
 ('Project_category_idx','SiteDesign_userId_key','SiteMaterial_userId_idx',
  'SiteRevision_userId_createdAt_idx','PasswordResetToken_tokenHash_key',
  'PasswordResetToken_userId_idx');

-- expect 1 row
select conname from pg_constraint
 where conrelid = '"Project"'::regclass and conname = 'Project_coverMediaId_fkey';
```

Then re-run the Step-1 probe and expect exit code `0`.

**Step 4 — Application-level verification (after redeploy):** `GET /api/professions` and
`GET /api/discover` (seed-on-read taxonomy + feed), then register a throwaway account, log in,
and exercise one upload. Registration is transaction-safe: on a database missing the new User
columns the whole write rolls back with a 500 instead of leaving a half-created account.

---

## 1. What exists today (verified)

| Piece | State |
|---|---|
| Dev server | `bun run dev` (Next.js dev, port 3000, logs teed to `dev.log`) — this is how every verification in this build was performed |
| Build tooling | `output: "standalone"` is set in `next.config.ts`; `package.json` has `build` (`next build` + copy static/public into the standalone dir) and `start` (`NODE_ENV=production bun .next/standalone/server.js`) scripts ready |
| Public website URLs | Published sites live at `/#/u/<username>` on the deployed origin; `src/proxy.ts` 308-redirects the path form `/u/<username>` to it so direct requests and refreshes work (§6). Canonical URLs come from `src/lib/site-url.ts` — never hardcoded |
| Database | SQLite file via `DATABASE_URL="file:./db/custom.db"`, schema managed with `prisma db push` |
| Media | local `uploads/` directory |
| AI | server-side z-ai SDK via the platform runtime |

Note (verified 2026-11-14): `next.config.ts` does **NOT** set `ignoreBuildErrors` — `next build`
runs full type checking, and `bunx tsc --noEmit` is clean (0 errors) as of the M22 Phase 2
baseline. Keep it that way: never re-enable `ignoreBuildErrors` to make a build pass
(protocol §2 — no weakening TypeScript settings to hide errors).

## 2. Why nothing is deployed

The sandbox exposes exactly one port (3000), one visible page route, SQLite, and no external
service credentials. A production deployment requires, at minimum: a host, a domain + TLS, a
PostgreSQL instance, object storage, and a secrets store — none of which exist here. Rather than
faking a deployment, the runbook below is the handoff.

## 3. Production runbook

### 3.1 Provision

1. Host for the Next.js standalone server (any Node/bun-capable VM or container platform).
2. Managed **PostgreSQL** (16+) instance with backups enabled.
3. **S3-compatible** bucket for media (+ CDN, ideally).
4. Secrets manager or platform env vars (never committed files).

### 3.2 Environment

Validate before first boot — the app reads `DATABASE_URL` today; the reserved names are in
`.env.example`:

```bash
DATABASE_URL="postgresql://…"          # PostgreSQL via Prisma (required)
NEXT_PUBLIC_APP_URL="https://…"        # the REAL production origin (for canonical public URLs)
NODE_ENV=production                    # drives the `secure` cookie flag today
SESSION_SECURE_COOKIES=                # optional explicit override ("true"/"false"; see src/lib/auth.ts)

# Media storage (LIVE feature — src/lib/storage.ts). On a stateless host such
# as Vercel the filesystem is EPHEMERAL: set all four S3 vars (any S3-compatible
# store: AWS S3, Cloudflare R2, Supabase Storage, MinIO) or uploaded media is
# silently stored on local disk and lost between deployments.
S3_ENDPOINT= S3_BUCKET= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY=
S3_REGION=                             # optional, default "auto"
S3_FORCE_PATH_STYLE=                   # optional, default true (path-style for R2/Supabase/MinIO)
MEDIA_STORAGE_DRIVER=                  # optional: "local" forces local disk (tests/sandbox/self-hosted)
MEDIA_LOCAL_ROOT=                      # optional local-driver root, default <cwd>

GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=                           # when Google OAuth ships (docs/google-auth.md)
NEXT_PUBLIC_SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY=              # service-role key: SERVER-ONLY
AI_PROVIDER_API_KEY=                   # when swapping AI providers (docs/ai-integration.md §9)
```

`NEXT_PUBLIC_APP_URL` is what makes published-website links (`Copy Link`, the
publish confirmation dialog, `Share`, social/SEO metadata) resolve to the real
domain. It must be the actual production origin (HTTPS, scheme included, no
trailing slash). It is the ONLY source of a permanent public URL: when it (or
`VERCEL_URL` on Vercel) is missing — or points at an internal/preview/non-HTTPS
address — the share actions honestly report that production domain
configuration is required and the workspace/preview host the app happens to
render on is NEVER presented as the permanent link (request headers and
`window.location` are never consulted — `src/lib/site-url.ts`, enforced by
`tests/site-url.test.ts`). **No domain is ever hardcoded in the codebase.**

Startup env validation is IMPLEMENTED (M22 Phase 2): src/lib/startup-validation.ts fails fast on missing DATABASE_URL, partial S3 config (production), insecure-cookie policy, unknown backend values — see src/instrumentation.ts.

### 3.3 Database

```bash
bun install
bunx prisma generate --schema prisma/schema.postgres.prisma
# Schema application in production = reviewed additive SQL artifacts
# (e.g. docs/deployment/additive-portfolio-models-migration.sql), applied
# deliberately — NOT blanket `prisma migrate deploy` (no migrations/
# directory exists in this repo) and never destructive. See
# docs/deployment/production-deployment.md §2.5 and DEPLOYMENT_OPTIONS.md.
bun run build                  # next build + standalone asset copy
NODE_ENV=production bun .next/standalone/server.js
```

- Convert the schema per `docs/database.md` §6 (enums, arrays/jsonb, full-text) **before** the
  first `migrate`, so the initial migration is the real baseline.
- `prisma db push` must never be pointed at production with a destructive intent — the script no
  longer carries `--accept-data-loss`; keep it that way and use reviewed, additive migrations.

### 3.4 Edge & TLS

- Terminate TLS at a reverse proxy (nginx/Caddy/managed LB); forward `x-forwarded-for` (the
  rate limiter already prefers it) and `x-forwarded-proto`.
- Cookies become `secure` automatically under `NODE_ENV=production` (`src/lib/auth.ts`); confirm
  the proxy passes cookies untouched and consider HSTS at the proxy.
- Health probe: `GET /api/health` → `{ ok: true, service: "bean-folio", time }` — use it for
  liveness/readiness and uptime checks.

### 3.5 Media

Until the S3 storage layer's limits are lifted — i.e. until presigned direct uploads ship
(`docs/media-pipeline.md` §5) — uploads larger than ~4.5 MB fail on serverless hosts; beyond that,
do **not** scale beyond one instance
or rebuild containers freely: `uploads/` is ephemeral local disk and media rows will point at
missing blobs (the serving route degrades to `FAILED`/404 by design). Migrate to S3 before any
multi-instance deployment.

### 3.6 Monitoring & error tracking

- Add Sentry (or equivalent) with the server + browser SDKs; the `handler()` wrapper and
  `aiComplete` already funnel errors through single choke points (`console.error("[api]…"`,
  `console.error("[ai]…")`) to hook into.
- Alert on: 5xx rate, `AiProviderError` bursts, rate-limit saturation, DB connection errors,
  disk usage (if local media persists), `/api/health` failures.

### 3.7 Backups & tested restore

- PostgreSQL: automated daily backups + PITR (managed provider feature).
- S3: versioning or cross-region replication for the media bucket.
- **A backup is not a backup until a restore has been rehearsed:** quarterly, restore a snapshot
  into a scratch environment, apply the reviewed additive SQL artifacts, boot the standalone server against
  it, verify `GET /api/health` plus a login and a project read. Document the measured RTO/RPO.

### 3.8 Rollback strategy

- Keep the previous standalone build artifact per release (`builds/<git-sha>/server.js`); a
  rollback is a symlink/pointer flip + restart, no rebuild.
- DB rollbacks: schema changes are reviewed, additive SQL artifacts applied deliberately
  (never blanket `migrate deploy`, never destructive); rollbacks restore the backup, not reverse migrations.
- Static/client assets: the standalone build is self-contained; keep the prior artifact serving
  until rollback completes.

## 4. Pre-launch checklist

Secrets & config

- [ ] Rotate **all** credentials used during development (DB password, AI keys if any, S3 keys)
- [ ] Secrets only from the platform secret store; `.env` never committed; git history scanned
- [ ] `NEXT_PUBLIC_*` surface reviewed (nothing sensitive is public-by-prefix)
- [ ] Placeholder contact addresses in the legal pages (`src/views/StaticView.tsx` privacy/terms)
      replaced with real ones — **flagged in `docs/known-limitations.md`**

Security (see `docs/security.md` §8)

- [ ] Review each known gap; ship at minimum: Redis-backed rate limiter, explicit secure-cookie
      handling, email verification + password reset
- [ ] `ignoreBuildErrors` disabled or `tsc --noEmit` gating in CI
- [ ] TLS + HSTS verified; cookie flags verified in production traffic
- [ ] Moderation runbook agreed (reports exist; tooling is minimal)

Data & content

- [ ] Schema baseline applied from the reviewed additive SQL artifacts; `db:push` disabled in prod envs
- [ ] Backup + **rehearsed restore** completed (§3.7)
- [ ] Demo fixture data (any `isDemo` accounts) absent from production DB
- [ ] `uploads/` migration to S3 completed (or single-instance constraint accepted and monitored)

Verification

- [ ] Golden journeys smoke-tested on the production URL: register → onboard → upload → publish
      → discover → inquiry → export → deletion (`docs/testing.md` §4 list)
- [ ] `/api/health` wired into uptime monitoring + deploy gating
- [ ] Error tracking receiving events (test exception confirmed end-to-end)

## 5. Related docs

`docs/architecture.md` (system shape + production mapping) · `docs/database.md` §6 (PostgreSQL
path) · `docs/media-pipeline.md` §5 (large-upload/worker upgrades) · `docs/google-auth.md` (OAuth setup) ·
`docs/security.md` (gaps to close) · `docs/testing.md` (verification gates)

## 6. Published websites as real public URLs (multi-tenant, one deployment)

Every creator who publishes gets a **real, shareable, stable URL on the one BEAN Folio
deployment** — there is no per-user build, project or subdomain:

| Concern | How it works (verified in this repo) |
|---|---|
| Slug | `User.username` — unique in the DB, claimed at onboarding, never changed by saves/publishes |
| Canonical URL | `https://<real-domain>/#/u/<username>` — built only by `src/lib/site-url.ts` (`publicSiteAbsoluteUrl`) |
| Path form | `/u/<username>` (and `/p/<projectId>`) → `308` to the hash route via `src/proxy.ts` (Next.js 16 proxy convention); direct requests, refreshes and pasted links all land on the site. Vercel supports it with zero extra config |
| Publish response | `POST /api/me/site/publish` returns `publicUrl` (route form) and `canonicalUrl` (absolute, resolved ONLY from a VERIFIED source — deployment configuration (`NEXT_PUBLIC_APP_URL`/`VERCEL_URL`, kind `production`) or the current environment's edge host after the active origin-proof round trip (`lib/workspace-origin`, kind `workspace`); `canonicalUrlUnavailable` + `canonicalKind` tell the UI exactly what was resolved and why nothing was) |
| Share actions | The builder's publish dialog + toolbar expose **Copy link**, **Open live website** and **Share** (`src/lib/share.ts`; Web Share API with honest clipboard fallback) |
| Anonymous access | The published snapshot is served by `GET /api/profiles/:username` to anyone; drafts are owner-only; PRIVATE/demo/deleted profiles 404 (`src/lib/visibility.ts`) |
| Standalone rendering | A published site renders as the creator's own independent website: the platform shell (header nav, account buttons, footer, mobile tab bar) is suppressed on `/u/<username>` while a published site is shown (`src/lib/standalone-site.ts` + `page.tsx`); no platform controls are rendered inside the site — the owner manages it from the Website Studio builder |
| Update flow | Draft → save → **Republish** keeps the same URL; the snapshot is swapped server-side. **Unpublish** removes public access to the website (visitors see the standard profile per its own visibility setting) and preserves the draft |
| Caching | Profile/site APIs are `force-dynamic`; publishes are visible on the next page load with no purge step needed |

**Vercel specifics.** Deploy the repo as ONE Next.js project (do not create a project per
portfolio). Set `NEXT_PUBLIC_APP_URL` (and `DATABASE_URL`) in Project → Settings → Environment
Variables for Production. Two hard requirements before a real deployment: (1) the SQLite file
database must be migrated to managed PostgreSQL (`docs/database.md` §6, `prisma schema.postgres.prisma`)
— a SQLite file does not persist on serverless filesystems; (2) the S3 storage driver must be
configured via env vars (`src/lib/storage.ts`, §0.2 Step B) — the storage layer is implemented,
but without its env vars uploads land on the ephemeral local `uploads/` directory. The database
swap and env configuration are deployment actions, not code work.

**Workspace environments (before a production deploy).** In a workspace/sandbox platform the app
runs behind the platform's edge, which may rewrite the `Host` header to an internal trigger name.
`src/lib/workspace-origin.ts` resolves the CURRENT environment's genuine public share address by
(1) collecting candidate hosts from the edge headers AND the browser's `Origin`/`Referer` headers,
then (2) PROVING a candidate with an active round trip: the server fetches
`https://<candidate>/api/origin-proof?nonce=<one-time>` over public DNS + TLS and accepts it only
when the nonce is echoed back — a host that the platform edge does not route to this app (its edge
answers 410 for unknown/recycled names) can never be issued as a share URL. Verified origins are
cached 10 min (failures 60 s). The publish dialog labels the two verified kinds honestly:
`production` = permanent configured domain; `workspace` = "Shareable now — verified publicly
reachable", with the explicit caveat that the address belongs to the workspace and is stable while
the workspace lives. When nothing verifies, Copy/Share stay disabled and the publish toast is a
warning ("Snapshot saved — no shareable public link yet"), never a green success.

### 6.1 Architecture reference: vercel/platforms (adapted, not copied)

The multi-tenant publishing design follows the patterns of
[vercel/platforms](https://github.com/vercel/platforms) (MIT), evaluated for this codebase:

| vercel/platforms pattern | BEAN Folio adaptation |
|---|---|
| Next.js 16 `proxy.ts` detects the tenant (subdomain) and routes it to tenant content | `src/proxy.ts` (same Next.js 16 proxy convention) maps the canonical path form `/u/<username>` → the hash route `/#/u/<username>` (308, query preserved) — the single multi-tenant routing seam. Custom-subdomain detection is the documented future capability at that seam (needs DNS + TLS + domain verification) |
| Tenant data keyed `subdomain:{name}` | Creator website keyed by unique `User.username` with a `SiteDesign` row (draft + published snapshot) — lookup by slug, one site per creator |
| Platform UI (landing/admin) on the main domain; tenant sites render standalone | Dashboard/builder live in the app shell; published websites render with ALL platform chrome suppressed (`src/lib/standalone-site.ts`) so they are the creator's own website |
| Per-tenant domains table (custom domains) | Not implemented — `src/proxy.ts` documents the seam; no domain verification exists |

Nothing was copied from the starter kit code (different data layer — Redis/KV vs Prisma/SQL;
different routing model — subdomains + server-rendered pages vs the hash-SPA constraint of this
sandbox); only the architecture patterns above are reused. The hash-route URL form is the
deliberately compatible alternative for `/u/<username>` in this SPA (see `src/lib/site-url.ts`
header); a production migration to path-served websites would replace the 308 redirect with a
server-rendered page route, keeping `publicSitePath()` and all share URLs unchanged.

Known limitation (honest): the platform shell is removed once the profile route resolves on the
client, so a visitor who opens a published site sees the app header for the brief SSR/hydration
window before the profile data arrives. Servers cannot see URL fragments (hash routes are never
sent to the server), so fully removing that first paint requires the path-route architecture
above — it is a deployment-time choice, not a code change to the publishing system.

**Custom domains — future capability, not implemented.** The code is structured for them
(single-tenant-per-host resolution seam documented in `src/proxy.ts`; username→site mapping
already exists), but domain ownership verification, DNS routing, HTTPS issuance and the
domain→portfolio mapping are NOT built. Do not promise custom domains until that work exists.

### 6.2 Share URL architecture — what is supported today vs what is missing (audited)

The preferred long-term patterns are `https://<creator-slug>.<bean-domain>/` (per-creator
subdomain) and `https://<bean-domain>/<creator-slug>` (path on a bean domain). Audited against
the ACTUAL hosting platforms:

| Pattern | Status | Evidence |
|---|---|---|
| `https://<bean-domain>/<creator-slug>` (path form) | **SUPPORTED — this is what ships.** On any deployment with a configured domain (`NEXT_PUBLIC_APP_URL`) the canonical URL is `https://<domain>/u/<username>`, 308-redirected to the site. In the current workspace the same path form works on the verified workspace origin (`preview-chat-<chat-id>.space-z.ai/u/<username>`, origin-proofed). | `src/proxy.ts`, `lib/site-url.ts`, `lib/workspace-origin.ts`; E2E anonymous access verified |
| `https://<creator-slug>.<bean-domain>/` (per-creator subdomain) | **NOT SUPPORTED in the current workspace — documented, not faked.** | Audited this environment: (a) the workspace edge answers HTTP 410 for any hostname except the platform-registered `preview-chat-<chat-id>.space-z.ai` (invented subdomains like `my-portfolio-test.space-z.ai` → 410 "Recycled"); (b) no DNS control (`space-z.ai` is platform-owned); (c) the app-side gateway (Caddy) only proxies to the app port — no Host-based tenant routing; (d) no TLS issuance capability. Nothing in this environment can register or route a new hostname. |

**Exact infrastructure a per-creator subdomain future requires** (all four, in order):

1. **A registered domain owned by BEAN Folio** (e.g. `beanfolio.app`) — bought and managed by the
   operator; nothing in the app can create it.
2. **Wildcard DNS** `*.<domain>` (and apex) → the production host — a DNS record on the registrar,
   or Vercel custom domains with the wildcard attached to the project.
3. **Wildcard TLS** certificate for `*.<domain>` (Vercel issues this automatically for attached
   wildcard domains; self-hosted needs certbot/Caddy on-the-fly TLS).
4. **Host-based tenant routing in the app**: `src/proxy.ts` reads the request host, strips the
   apex, and maps `<slug>.<domain>` → the creator's site (the seam and the username→site mapping
   already exist — see §6.1). Plus creator-owned custom domains later = the vercel/platforms
   domains table (verification + DNS target per domain).

Until 1–4 exist, the app MUST NOT display or issue invented per-creator hostnames — the share
URL stays the honest path form on the verified origin, and the publish dialog says exactly that.

### 6.3 "Made with BEAN Folio · Code Giftz" footer attribution (watermark)

- **What it is**: a small, muted, single-line credit in every published website's footer —
  `Made with BEAN Folio · Code Giftz` — with "BEAN Folio" as a subtle link to the platform home.
  It sits AFTER the creator's own footer line (`<site name> · <creator name>`), separated by the
  site's own divider, inherits the creator's theme colors (readable contrast, `text-xs opacity-70`),
  and never overlays hero/profile/projects/content.
- **Where it lives (dedupe/corruption-proof by construction)**: rendered by `SiteRenderer` at
  VIEW time — it is NOT part of `SiteConfig`, the draft, or the published snapshot
  (`publishedConfig`). Republishing can therefore never duplicate or overwrite it, and content
  editing cannot corrupt it. Verified: watermark count stays exactly 1 across repeated publishes.
- **The platform setting**: `SiteDesign.watermark` (default `true`) — owner-scoped, toggled in
  Website Studio → Design tab → "Footer attribution" and in the publish dialog. It is a LIVE
  setting: `PATCH /api/me/site { watermark }` applies to the public website immediately without
  republishing. The public API exposes it per profile (`GET /api/profiles/:username` →
  `site.watermark`).
- **Standalone contact behavior (same commit)**: for anonymous visitors the site's Contact CTA
  renders as a `mailto:` link to the creator's public contact email instead of the platform
  inquiry flow — a published website never pushes visitors to platform sign-in. Signed-in
  visitors keep the in-app inquiry dialog.
