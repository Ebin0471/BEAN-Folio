#!/usr/bin/env bash
# BEAN FOLIO — publish a verified SOURCE-ONLY snapshot of main to the
# `github-clean` lineage (the ONLY branch ever pushed to GitHub).
#
# Usage:
#   scripts/ops/publish-github-clean.sh "<commit message>"
#
# Guarantees:
#   1. refuses to run on a dirty working tree (commit first — see
#      DEVELOPMENT_SAFETY.md §0/§1),
#   2. syncs the snapshot tree to main's exact tree (read-tree reset),
#   3. HARD security audit: any runtime data (db, uploads, backups, .env,
#      tool artifacts, migration dumps) aborts the publish,
#   4. leaves main checked out and prints the verified snapshot hash plus
#      the exact push + verification commands.
set -euo pipefail
cd "$(dirname "$0")/../.."

MSG="${1:?Usage: publish-github-clean.sh \"<commit message>\"}"

if [ -n "$(git status --porcelain)" ]; then
  echo "FATAL: working tree not clean — commit or stash first (DEVELOPMENT_SAFETY.md §1)." >&2
  exit 1
fi

if ! git show-ref --verify --quiet refs/heads/github-clean; then
  echo "FATAL: github-clean branch missing. Create it once with:" >&2
  echo "  git checkout --orphan github-clean && git commit -m \"BEAN Folio — verified source checkpoint\"" >&2
  echo "  git checkout main" >&2
  exit 1
fi

# 1) Sync the snapshot tree to main's exact tree (index + worktree; untracked
#    runtime files on disk are untouched — they are gitignored).
git checkout --quiet github-clean
git read-tree -u --reset main

# 2) Hard security audit on the staged tree.
leaks=$(git ls-files | grep -E '^(db/.*\.db$|\.env$|\.env\.[^.]+$|uploads/|backups/|data/laxii-tmp/|public/downloads/|pg-migration/|upload/|tool-results/|\.github-auth/)' | grep -v '^\.env\.example$' || true)
if [ -n "$leaks" ]; then
  echo "FATAL: runtime data leaked into the snapshot — publish aborted:" >&2
  echo "$leaks" | sed -n '1,20p' >&2
  git checkout --quiet main
  exit 1
fi

# 3) Commit (skip when the tree is unchanged since the last snapshot).
if git diff --quiet HEAD; then
  echo "No source changes since the last github-clean snapshot — nothing to publish."
  git checkout --quiet main
  exit 0
fi
git add -A

# 3b) Staged-diff scan — second guard after `git add -A`. Catches anything
#     the index ignore-rules failed to exclude (e.g. the credential vault
#     losing its .git/info/exclude protection on a fresh clone).
staged_leaks=$(git diff --cached --name-only | grep -E '^\.github-auth/' || true)
if [ -n "$staged_leaks" ]; then
  echo "FATAL: credential vault reached the staged snapshot — publish aborted:" >&2
  echo "$staged_leaks" | sed -n '1,10p' >&2
  git reset --quiet HEAD 2>/dev/null || true
  git checkout --quiet main
  exit 1
fi

git commit --quiet -m "$MSG"
HASH=$(git rev-parse HEAD)
git checkout --quiet main

echo "github-clean updated: $HASH"
echo "push:  git push origin github-clean:main"
echo "verify: git ls-remote origin refs/heads/main   # must equal $HASH"
