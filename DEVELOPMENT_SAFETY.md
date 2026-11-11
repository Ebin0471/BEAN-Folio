# BEAN FOLIO — Development Safety & Preservation Policy

**BINDING for every coding-agent task on this repository** (human or automated).
Referenced from [`AGENTS.md`](./AGENTS.md). Introduced 2026-11-11 after the
recurring `Upload failed (405)` incident (see §6).

The prime directive: **BEAN FOLIO is an existing product with years of
development work. Every change must preserve all unrelated existing
functionality and user data.**

---

## §0 Before every task

1. `git status` + `git branch --show-current` + `git log --oneline -10` —
   know the branch and recent history before touching anything.
2. Inventory uncommitted (`git status --porcelain`) and untracked files.
3. Capture the current state before editing: if the tree is dirty, make a
   descriptive checkpoint commit first (never mix unrelated work into a
   feature commit).
4. Verify the dev server is healthy: `./ensure-dev.sh` (idempotent; also
   sentinel-checks the upload route — see §4).
5. Never discard existing work to make a task easier.

## §1 After every completed task

1. Run the relevant regression suites (§5) — they must be green.
2. Run `bun run lint` and fix NEW issues introduced by the change
   (pre-existing warnings outside the touched scope are not in scope).
3. Review the complete diff (`git diff` + `git status`) before committing.
4. Create a descriptive checkpoint commit (what & why, not just "update").
5. Verify the commit exists: `git log --oneline -1` and
   `git status --porcelain` shows the intended clean state.
6. If a git remote is configured AND access is authorized, push and confirm
   the push output. **Never claim a remote push succeeded without seeing the
   server's confirmation.**
7. If no remote is available, refresh the persistent backup:
   - DB: `bun scripts/ops/backup-db.ts --out /home/z/beanfolio-backups/db`
     (outside the workspace) — the script verifies integrity and row parity.
   - Media: `bun scripts/ops/backup-media.ts --out /home/z/beanfolio-backups/media`
     (verifies archived file count vs. live tree).

## §2 Forbidden without EXPLICIT human approval

Never execute, in this repository:

- `git reset --hard`, `git clean -fd`, `git checkout -- .` on the whole tree
- Force push, branch deletion
- Database reset / deletion / destructive migrations
- Recursive deletion of trees, overwriting existing backups
- Restoring or replacing the workspace from an older archive
- Deleting user uploads, generated assets, or DB rows
- Removing/untracking GIFTZ conversations, actions or proposals

Before any potentially destructive operation, state: (1) what will be
affected, (2) why it is necessary, (3) what backup exists, (4) how rollback
works — then **wait for approval**.

## §3 Database protection

- Do NOT "solve" durability by blindly committing the live user database to
  Git. Use the verified, versioned backup scripts (§1.7) — they snapshot via
  SQLite's own `VACUUM INTO`, run `PRAGMA integrity_check` on the snapshot
  and compare row counts of key tables.
- Protected data: `db/custom.db`, users, sessions, projects, MediaAsset rows,
  AgentTask records, GIFTZ conversations/proposals, SiteDesign revisions.
- Do not restore an older database merely because a newer one is unavailable
  — a restore overwrites the live state and needs human approval with a
  pre-restore backup of the CURRENT database.
- Keep the recovery-source inventory (§7) up to date.

## §4 Upload & media protection

- `uploads/` files and their `MediaAsset` rows must stay consistent. Never
  silently remove either side.
- The classic multipart transport `POST /api/media/upload` is load-bearing:
  the client (`src/lib/client.ts`) falls back to it when presigned direct
  upload answers 501. If the static `src/app/api/media/upload/route.ts`
  segment is missing from the working tree, the dynamic `/api/media/[id]`
  route (no POST export) captures the request and **every upload in the app
  returns 405**. This exact failure happened repeatedly.
- Two permanent guards now exist:
  1. `./ensure-dev.sh` — refuses to pass when the route 405s and prints the
     one-line read-only fix (`git checkout -- src/app/api/media/upload/route.ts`).
  2. Regression suites (§5) — `media-upload-route` (handler contract) and
     `media-upload-http` (real HTTP, pins "POST is never 405").
- After a sandbox recycle / workspace restore, run `./ensure-dev.sh` BEFORE
  anything else; if it reports the 405 signature, restore the single tracked
  file from Git immediately (read-only operation, zero data loss).

## §5 Regression suites (run after every task that touches media/auth/api)

```bash
./ensure-dev.sh                                # server + upload-route sentinel
bun test tests/media-upload-route.test.ts      # handler contract (QA user, self-cleaning)
bun test tests/media-upload.test.ts            # saveUpload text-sniffing boundary
bun test tests/media-upload-http.test.ts       # LIVE HTTP: 405 pin, bytes, avatar+cover flows
bun run lint
```

## §6 Incident record — the recurring 405

- 2026-10/11: `POST /api/media/upload` repeatedly failed with 405 in preview.
- Root cause (confirmed 2026-11-11): the route file was committed to Git but
  the sandbox recycle restored the working tree WITHOUT materializing it
  (`git status` showed exactly ` D src/app/api/media/upload/route.ts`);
  requests fell through to `/api/media/[id]` → `405 Method Not Allowed`,
  `allow: DELETE, GET, HEAD, OPTIONS`.
- Fix: restore the tracked file from HEAD (content already in Git), verify
  `401` on anonymous POST, keep both suites + the `ensure-dev.sh` sentinel
  so the failure is caught within seconds of any future recycle.

## §7 Recovery-source inventory (keep current)

| Source | Date | Contents | Status |
| --- | --- | --- | --- |
| `backups/db/db-2026-11-04T06-23-17-531Z.sqlite3` (in-repo; in local git history) | 2026-11-04 | User 20, Project 14, MediaAsset 38, AgentTask 29, Giftz 2, Laxii 5/10 | integrity ok; == HEAD |
| Git blob of `db/custom.db` @ `0809d5d` | 2026-10-27 | User 43, Project 17, MediaAsset 42, SiteDesign 16 | older; integrity ok |
| `upload/BEAN-Folio.7z.001…012` (gitignored, on disk) | 2026-11-09/10 | archived workspace state | retained, never committed |
| `backups/db/db-2026-11-11T04-51-38-875Z.sqlite3` (in-repo; untracked from index 2026-11-11) | 2026-11-11 | thin live DB (User 1: ebin) | integrity ok |
| `/home/z/beanfolio-backups/{db,media}/` (outside workspace) | 2026-11-11 | current DB + all 1379 media files (329 MB) | verified |

Runtime data is NO LONGER git-tracked (2026-11-11 — GitHub-safety policy):
DB + media durability comes from the verified backups above, refreshed per
§1.7. Local `main` keeps full local history (including historical db blobs)
and must NEVER be pushed to any remote — see §8.

## §8 GitHub sync workflow (permanent source of truth)

GitHub carries **source only**, via the `github-clean` snapshot lineage
(single-commit verified checkpoints, runtime data permanently excluded).
Local `main` keeps the full local history — **it must NEVER be pushed**
(its history contains historical `db/custom.db` blobs with password hashes
and private user media).

Remote of record: **`https://github.com/Ebin0471/BEAN-Folio.git`** — the
owner-confirmed PRIVATE repository (connected 2026-11-11).

### Initial connection — COMPLETED 2026-11-11

```bash
git remote add origin https://github.com/Ebin0471/BEAN-Folio.git  # owner-confirmed PRIVATE repo
git push -u origin github-clean:main              # clean snapshot becomes GitHub main
git ls-remote origin refs/heads/main              # MUST equal `git rev-parse github-clean`
```

Executed 2026-11-11: remote `main` verified ==
`845641afbacc1a6caea78b4420a8c6572d8668c7` (800 source files, leak scan
clean, repo PRIVATE).

- Repository stays PRIVATE. No duplicate repos.
- Credential: GitHub CLI OAuth token (owner-authorized device flow,
  scopes `repo`, `read:org`) stored in gh's local keyring OUTSIDE the
  repository, never committed; revocable at github.com/settings/applications.

### Mandatory synchronization after every completed task (owner directive, 2026-11-11)

**Syncing to GitHub is REQUIRED after every completed task that changes BEAN
Folio — a task is not complete until its source changes are published to
`origin/main` and hash-verified.** It applies to the ENTIRE platform (all
modules, APIs, schemas, tests, docs — never selected modules only).

```bash
# after the descriptive commit on local main:
scripts/ops/publish-github-clean.sh "checkpoint: <what + why>"   # audits + syncs + commits
git push origin github-clean:main                                # safe fast-forward only
git ls-remote origin refs/heads/main                             # MUST equal `git rev-parse github-clean`
```

Per-task loop: tests/lint/build checks → full diff review (accidental
deletions, unrelated modifications, secrets, private data) → descriptive
commit → publish script → push → **hash-verify** → end-of-task report.

### No silent synchronization failures

If authorization expires, the network fails, tests fail, the push is
rejected, or the remote differs: NEVER claim synchronization succeeded.
Keep local changes and commits safe, report the exact failure, and state
the next recovery action. **Never reset or delete local work just to make
a push succeed.** No force-push, no remote history rewrite, no overwriting
other commits — ever.

### End-of-task report (required every task)

- What was changed.
- Tests and checks performed.
- Local commit hash.
- GitHub remote commit hash (`git ls-remote`).
- Whether both hashes match.
- Files intentionally excluded (runtime data — see "Security exclusions").
- Any unresolved issues.

### Every future development session

- Start: `git remote -v` (verify origin) → `git fetch origin` → compare
  local vs `origin/main` commit hashes and trees → inspect uncommitted
  changes (`git status --porcelain`) → identify whether the workspace is
  behind the remote → preserve any uncommitted or newer local work → pull
  ONLY when fast-forward-safe. **On conflict: STOP and resolve safely —
  never discard work automatically.**
- End: run regression suites (§5) → lint → review the diff → descriptive
  commit → `publish-github-clean.sh` → push → **verify the remote hash
  matches the published commit (`git ls-remote`) before claiming any
  synchronization happened** → file the end-of-task report (above).

### New workspace recovery

Clone the private repo (gets the `github-clean` lineage) → `bun install` →
`bunx prisma generate` → `bunx prisma db push` (fresh local DB) → restore
`db/custom.db` + `uploads/` from `/home/z/beanfolio-backups/` only when user
data is needed → `./ensure-dev.sh` → resume from the latest verified commit.

### Security exclusions (never pushed, verified per snapshot)

`.env*` · `db/*.db` · `uploads/` · `backups/` · `data/laxii-tmp/` ·
`public/downloads/` · `pg-migration/` · `upload/` · `tool-results/`.
Audited: `.env` was never committed in the entire local history (0 commits).
