# GITHUB AUTHENTICATION AND SYNC — BEAN FOLIO (M18)

Status: **PARTIAL — implementation verified end-to-end in the current session; cross-session persistence is architecturally evidenced but UNVERIFIED until the next session boundary.**

Last updated: 2026-11-14. Applies to `Ebin0471/BEAN-Folio`, branch `main`.

---

## 1. Original authentication problem

Every session required a fresh GitHub device-code authorization before any
remote Git operation (`git fetch`, `git ls-remote`, `git push`) could run.
Between sessions the stored credential vanished even though all source code,
docs, uncommitted work-tree modifications, and `.git/` survived intact.

Additionally, after the loss, remote operations failed with:

```
/home/z/my-project/.github-auth/gh-credential-helper get: ... not found
fatal: could not read Username for 'https://github.com': No such device or address
```

so even the interactive fallback was impossible in the non-TTY sandbox.

## 2. Root cause with evidence

**Primary: C — the authentication vault is ephemeral.**
**Secondary: B — a dangling credential-helper reference blocked every fallback.**

Evidence gathered during the M18 audit:

| Observation | Implication |
|---|---|
| `.github-auth/` (prior session's vault: vendored `gh` binary, OAuth config, helper script) did not exist, while the repo's tracked files — including ~100 uncommitted work-tree modifications from the prior session — did exist. `git ls-files --others --exclude-standard` returned **zero** untracked files. | The workspace is restored per session from a snapshot that preserves tracked files (and their uncommitted modifications) plus `.git/` wholesale, and **drops untracked files regardless of `.git/info/exclude`**. Credential material stored as untracked working-tree files cannot survive. |
| `git config --show-origin` showed `credential.https://github.com.helper=/home/z/my-project/.github-auth/gh-credential-helper` still present in `.git/config` — a line written by the *previous* session. | `.git/` **does** persist across the same session boundary that destroyed `.github-auth/`. This is the decisive architectural fact (see §5). |
| No `gh` binary anywhere (not on PATH, not in the vault), no `~/.config/gh`, no `~/.git-credentials`, no `~/.netrc`, no `~/.ssh`, no credential-related environment variables, no `/run/secrets` or `/mnt/secrets` mounts. | Rules out the "Preferred: existing platform GitHub integration" option and SSH options; the platform provides no built-in Git credential system. |
| `git ls-remote` without credentials failed at the username prompt (non-TTY). | Repository requires authentication for all remote operations (private repo); OAuth scope `repo` was sufficient in prior sessions. |
| GitHub REST API unauthenticated call returned `API rate limit exceeded`. | Confirms no platform-provided authenticated GitHub channel exists. |

Not the cause: GitHub authorization revocation (D) — the device-flow
authorization granted in the current session worked immediately and
repeatedly; permission/scope problems (E) — `repo read:org` suffices.

## 3. Chosen authentication architecture

**HTTPS + OAuth device-flow token in a vault stored inside `.git/`**
(`.git/bean-auth/token`, mode 600), served to Git by a repo-local credential
helper script.

Working priority evaluation per the M18 spec:

1. *Existing persistent GitHub integration* — **not available** (sweep in §2 found nothing).
2. *Secure persistent credential manager* — **implemented, adapted to this environment**: the only store with demonstrated cross-session persistence is `.git/` itself, so the "approved secure credential store" is `.git/bean-auth/` (never tracked, mode 600/700, excluded from git objects by construction).
3. *SSH* — **impossible**: no `ssh` client binary exists in the sandbox, and `~/.ssh` does not persist.
4. *GitHub device flow* — used once to mint the token feeding option 2; will be reused whenever the vault is found empty.

Components (all tracked files contain no secrets):

```
scripts/ops/bean-credential-helper.sh   # git credential helper; reads vault token
scripts/ops/bean-auth.sh                # device flow: start | poll | status | test
scripts/ops/bean-sync.sh                # safe commit/push/verify workflow
.git/bean-auth/                         # vault: token (600), device-flow state (600) — never tracked
.git/config                             # credential.https://github.com.helper -> helper script
```

The OAuth app id used for the device flow is GitHub CLI's **public** OAuth
application id (`178c6fc778ccc68e1d6a`) — the same public id `gh` itself
uses; it is not a secret and was already committed in the legacy
`scripts/ops/gh-device-flow.sh`.

## 4. Why this architecture was selected

- **It targets the actual failure mode.** The audit proved `.git/` survives
  what untracked files do not (the surviving `.git/config` helper line from
  the prior session is direct evidence). Storing the credential inside
  `.git/bean-auth/` moves the vault onto the one persistence plane that works.
- **Minimal moving parts.** No vendored `gh` binary (~100 MB in the old
  vault), no SSH key management, no external credential-manager dependency.
  Device flow is plain `curl` (RFC 8628).
- **It never bypasses security controls.** The token is never printed,
  logged, argv-exposed (curl receives it via `Authorization:` header piped
  on stdin), committed, or placed in tracked config. Helper output goes
  only to Git's credential protocol.
- **Self-healing.** Every `bean-auth.sh` invocation re-attaches the
  repo-local credential helper idempotently, so even a hypothetical
  `.git/config` reset is repaired on next use.

## 5. Credential persistence mechanism

- Vault location: `/home/z/my-project/.git/bean-auth/token` (mode 600;
  parent dir mode 700).
- Writes: exclusively by `scripts/ops/bean-auth.sh poll`, which pipes the
  OAuth access token straight from the HTTPS response into the file
  (`umask 077`).
- Reads: exclusively by `scripts/ops/bean-credential-helper.sh` (invoked by
  Git) and by `bean-auth.sh` (status/test, masked output).
- Scope: token is OAuth (`gho_*`), scopes `repo read:org`, minted for
  account `Ebin0471`.
- Why `.git/` persists: the platform workspace snapshot restores tracked
  files + `.git/` and drops untracked files (§2). `.git/bean-auth/` is
  inside `.git/`, therefore follows `.git/`'s persistence path. It cannot
  be staged, committed, pushed, or listed by `git status` — `.git/` itself
  is invisible to Git's object model.

## 6. GitHub permission requirements

- OAuth scopes: `repo` (full control of the private repository) and
  `read:org` (future multi-repo/BEAN-org operations). Nothing broader.
- The device-flow app id is GitHub CLI's public app; authorizing it grants
  exactly the requested scopes and can be revoked anytime at
  `github.com/settings/applications` ("GitHub CLI").
- Single repository touched: `Ebin0471/BEAN-Folio`. No other repositories,
  no webhooks, no admin scopes requested.

## 7. Automatic commit and push workflow

Implemented in `scripts/ops/bean-sync.sh`. Run after each **completed
logical development task** (never per file-save):

```bash
scripts/ops/bean-sync.sh commit -m "feat(giftz): add component intelligence" -- \
  src/lib/giftz/component-intelligence.ts docs/GIFTZ_COMPONENT_INTELLIGENCE.md
scripts/ops/bean-sync.sh push     # push already-verified local commits
scripts/ops/bean-sync.sh verify   # connectivity + SHA match check only
```

The `commit` pipeline, in order:

1. **Auth precheck** — vault token must exist; otherwise prints the exact
   recovery command once and exits (never loops device-flow requests).
2. **Remote-state gate** — `git fetch origin <branch>`; aborts if the
   remote advanced or histories diverged (prints a reconciliation plan).
3. **Diff inspection** — shows `git status --porcelain` + diff stat so
   unintended files are visible before staging.
4. **Explicit staging** — only the paths listed after `--` are staged.
5. **Secret scan** — staged diff is scanned for token/private-key/cloud-key
   patterns (masking before printing matches); aborts on any hit.
6. **Commit** with the provided conventional message.
7. **Plain push** (`git push origin <branch>` — atomic; a non-fast-forward
   is rejected by GitHub; force flags are never used).
8. **Remote SHA verification** — `git ls-remote` result must equal local
   HEAD; loud failure otherwise (local commits preserved).
9. **Report** — final line prints the verified SHA.

Recommended commit message forms: `feat(giftz): …`, `fix(auth): …`,
`fix(upload): …`, `test(ci): …`, `docs(audit): …`.

## 8. Recovery procedure

| Situation | Action |
|---|---|
| Remote operations fail with "could not read Username" / 401 / 403 | `scripts/ops/bean-auth.sh status` → if no token: `bean-auth.sh start`, authorize at the printed URL with the printed code, `bean-auth.sh poll`, then `bean-auth.sh test`. |
| Token present but repo access fails | Check scope/authorization at `github.com/settings/applications`; re-run device flow if revoked. |
| Sync aborts with "histories diverged" | Follow the printed plan: fetch, `git log --oneline --graph local...remote`, deliberate merge or rebase, re-run tests, `bean-sync.sh push`. **Never** `--force`/`--force-with-lease`. |
| Sync aborts with "remote advanced" | Pull/rebase the remote commit first, verify tests, then sync. |
| Secret scan hits a match | Remove the credential from the file(s), rotate the exposed credential at GitHub if it was ever real, re-run sync. |
| `.git/config` lost its helper line | Any `bean-auth.sh` or `bean-sync.sh` run re-attaches it idempotently. |
| Legacy scripts (`scripts/ops/gh-auth.sh`, `gh-device-flow.sh`, `publish-github-clean.sh`) | Superseded by M18 tooling (their `.github-auth/` vault no longer exists). Kept for history; do not use. |

## 9. Security considerations

- Token never printed: device-flow response → variable → file, via stdin
  pipes; status output shows a masked prefix/suffix only
  (`gho_***********`).
- Token never in argv (process-list safe): API calls use
  `curl -H @-` (header fed on stdin).
- Token never committed: vault lives inside `.git/`; `bean-sync.sh` also
  scans every staged diff for credential patterns as defense in depth.
- Vault file permissions: 600 (file), 700 (directory).
- No plaintext token workaround, no repo-tracked credential files, no
  third-party `store`/`erase` writes (helper no-ops them).
- Revocation path: `github.com/settings/applications` → GitHub CLI.
- Old `.github-auth/` exclusion entry in `.git/info/exclude` remains
  harmless (directory no longer exists).

## 10. Persistence verification results

| Test | Result | Evidence |
|---|---|---|
| **A — Current session** | **PASS** | `bean-auth.sh test`: account `Ebin0471`, repo access `yes`, remote main SHA fetched successfully. |
| **B — Repeated Git operations** | **PASS** | 3× `git fetch origin main` with no auth prompt; test branch `bean-m18-sync-test` pushed (local SHA `237921296d63cbc429eccc0750862e41505b1041` == `git ls-remote` SHA), then deleted; zero authentication prompts. |
| **C — Session persistence** | **UNVERIFIED (pending next session boundary)** | Cannot restart the sandbox from inside it without risking the workspace. Architectural evidence is strong: `.git/` demonstrably survived the prior session restore (the prior session's `.git/config` helper line was still present this session), and the vault now lives inside `.git/`. Next session must run `scripts/ops/bean-auth.sh status` — if the token answers without a device flow, Test C flips to VERIFIED. |
| **D — Security** | **PASS** | Token not in tracked files (pattern scan over worktree), not in Git history (`git log -S` for token prefixes), not in logs/output (masked everywhere), no private keys committed, only the one intended repository accessed. |

Honest status: **PARTIAL** until Test C is observed at a real session
boundary. Do not claim persistence before that observation.

## 11. Known Z.ai environment limitations

- Workspace restore preserves tracked files + `.git/` and **drops all
  untracked files** (verified: prior vault, quarantine dirs, media backups
  vanished; zero untracked files existed after restore). Only storage
  inside `.git/` (or tracked files) persists.
- `HOME=/home/z` does not provide durable credential stores (no
  `~/.config`, `~/.ssh`, `~/.netrc`, `~/.git-credentials`).
- No `gh`, `git-credential-manager`, `git-credential-store`, or `ssh`
  binaries are installed; installing system packages is out of scope and
  would not persist.
- Non-interactive shell: Git cannot prompt for credentials — a credential
  helper must always succeed or the operation fails fast.
- Unauthenticated GitHub REST API is rate-limited; authenticated calls are
  the norm here.
- The dev server and tool-call working directory reset between messages are
  pre-existing platform quirks documented elsewhere; they do not affect the
  vault (`.git/bean-auth/` paths are absolute).

## 12. Adopting this standard in other BEAN projects

`BEAN-Intelligence`, `BEAN-FX`, and other authorized BEAN repositories can
adopt the identical workflow with a per-repo vault (no credential sharing
between projects — each repo mints its own token via its own device flow):

1. Copy the three tracked scripts (`bean-credential-helper.sh`,
   `bean-auth.sh`, `bean-sync.sh`) into `<repo>/scripts/ops/`; make
   executable.
2. Adjust the `REPO_ROOT` constant in `bean-credential-helper.sh` and the
   `cd` target in `bean-auth.sh`/`bean-sync.sh` to the new repo's root.
3. Run `scripts/ops/bean-auth.sh start` → authorize at the printed URL with
   the printed code (use the account that owns/collaborates on that repo;
   minimum scopes: `repo`) → `scripts/ops/bean-auth.sh poll`.
4. Run `scripts/ops/bean-auth.sh test` to verify account + remote SHA.
5. Use `scripts/ops/bean-sync.sh commit -m "…" -- <paths>` for every
   completed logical task thereafter.
6. After the first session boundary in that repo, run
   `scripts/ops/bean-auth.sh status` to confirm Test C for that workspace;
   record the result in the repo's copy of this document.

Never copy a token file between projects. Each device flow takes under a
minute and keeps authorizations per-project, per-scope, individually
revocable.

---

*This document contains no credentials, tokens, private keys, or other
sensitive authentication material.*
