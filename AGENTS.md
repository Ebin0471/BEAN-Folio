# BEAN FOLIO — Agent Instructions

**Read and follow [`DEVELOPMENT_SAFETY.md`](./DEVELOPMENT_SAFETY.md) before
making ANY change to this repository. It is binding, version-controlled
policy — not optional guidance.**

Non-negotiables (details and rationale in the policy):

1. **Preserve everything.** This is a long-lived product: never delete
   projects, media, GIFTZ history, database rows, or unrelated work. No
   resets, cleanups, force operations, or restores without explicit human
   approval (DEVELOPMENT_SAFETY.md §2).
2. **State check first.** `git status` + branch + recent log before every
   task; checkpoint uncommitted work before editing (§0).
3. **Dev server first.** `./ensure-dev.sh` before any verification — it is
   idempotent and sentinel-checks `POST /api/media/upload` (401 = good,
   405 = restore the tracked route file immediately, §4).
4. **Verify, don't claim.** Run the regression suites and lint after every
   task (§5); review the diff; make a descriptive commit; verify the commit
   exists; push only with confirmed output; otherwise refresh the verified
   backups (§1).
5. **Database safety.** Versioned verified backups via
   `scripts/ops/backup-db.ts` / `backup-media.ts`; never blindly commit the
   live DB; never restore an older DB without approval (§3).
6. **GitHub discipline — MANDATORY after every completed task.** Repository
   of record: `https://github.com/Ebin0471/BEAN-Folio.git` (remote `origin`,
   PRIVATE). GitHub receives source-only snapshots through the
   `github-clean` lineage pushed to remote `main`; local `main` and `deploy`
   are never pushed; no force-push or remote history rewrite, ever.
   Synchronization after every completed task is REQUIRED: tests/lint →
   full diff review → descriptive commit → `scripts/ops/publish-github-clean.sh`
   → push → verify the remote hash → end-of-task report. Never claim a sync
   succeeded without the verified remote hash; never discard local work to
   make a push succeed (§8).
