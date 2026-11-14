# BEAN FOLIO — Agent Instructions

**Read and follow [`DEVELOPMENT_SAFETY.md`](./DEVELOPMENT_SAFETY.md) and
[`docs/ops/MILESTONE_EXECUTION_PROTOCOL.md`](./docs/ops/MILESTONE_EXECUTION_PROTOCOL.md)
before making ANY change to this repository. Both are binding,
version-controlled policy — not optional guidance.** The milestone protocol
(mandatory workflow, approval gates, publishing policy, final-report
requirements) governs every milestone, hotfix, feature, refactor, audit,
deployment and maintenance task.

Non-negotiables (details and rationale in the policies):

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
   PRIVATE). GitHub receives **source only** — databases, media, backups,
   env files and vaults are never pushed; `deploy` and `github-clean` are
   never pushed; no force-push or remote history rewrite, ever.
   Synchronization after every completed task is REQUIRED and runs through
   the verified workflow: tests/lint → full diff review → descriptive
   commit → `scripts/ops/bean-sync.sh commit -m "<message>" -- <approved paths>`
   (secret scan + runtime-data scan + push + SHA verification built in) →
   independent `git ls-remote origin main` verification → end-of-task
   report. The pre-M18 `publish-github-clean.sh` snapshot flow is retired;
   the `git push origin deploy:main` instruction in `docs/deployment.md` is
   VOID (the `deploy` branch carries historical db/media blobs — protocol
   §5.4). Never claim a sync succeeded without the verified remote hash;
   never discard local work to make a push succeed (§8).
7. **Milestone protocol.** Every task follows the full workflow in
   `docs/ops/MILESTONE_EXECUTION_PROTOCOL.md` (§1 mandatory 12-step
   workflow, §2 permanent restrictions, §3 approval gates, §4 required
   final report, §5 verified publishing policy, §6 known-baseline register).
