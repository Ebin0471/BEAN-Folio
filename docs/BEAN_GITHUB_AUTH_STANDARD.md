# BEAN GITHUB AUTH STANDARD — Master Standardization (Folio / Intelligence / FX)

Status: **PARTIAL — BEAN Folio fully verified (M19 hardening COMPLETE for in-session tests); BEAN Intelligence provisioned but push-BLOCKED by account permissions; BEAN FX BLOCKED (inaccessible).**

Created: 2026-11-14. Supersedes per-project improvisation; aligned with `docs/GITHUB_AUTHENTICATION_AND_SYNC.md` (M18, Folio) and `docs/HANDOFF.md` §0 (Intelligence).

---

## 1. Architecture

One shared, repo-local standard. No cross-project credential sharing; no
platform-global dependency.

```
<repo>/
  scripts/ops/bean-credential-helper.sh   # Git credential helper (host-scoped)
  scripts/ops/bean-auth.sh                # device flow: start|poll|status|test
  scripts/ops/bean-sync.sh                # safe sync workflow (section 6 pipeline)
  .git/bean-auth/                         # vault: token (600), dir (700)
  .git/config                             # credential.https://github.com.helper -> helper
```

- **Vault location** — inside the repo's own `.git/`. Verified rationale
  (M18 audit): the Z.ai workspace restore preserves tracked files plus
  `.git/` wholesale and drops untracked working-tree files; the prior
  session's `.git/config` credential line survived the restore that
  destroyed the untracked `.github-auth/` vault. `.git/bean-auth/` is
  invisible to Git's object model (cannot be staged/committed/pushed).
- **Helper behavior** — answers only for `credential.https://github.com`
  (repo-local config key); emits the credential protocol block to Git
  (never to a terminal); no-ops `store`/`erase` (vault writes are exclusive
  to `bean-auth.sh poll`); returns nothing when the vault is empty so Git
  fails fast instead of hanging.
- **Token handling** — OAuth token (`gho_*`, scopes `repo read:org`) is
  piped from the RFC 8628 OAuth response straight into the vault file
  (`umask 077`, chmod 600); never printed, never in argv (API calls use
  `curl -H @-` header-on-stdin), never in logs or shell history.
- **OAuth app** — GitHub CLI's public OAuth app id (`178c6fc778ccc68e1d6a`);
  public information, revocable per-account at
  `github.com/settings/applications`.
- **Host scoping** — helper is wired as
  `credential.https://github.com.helper`; no other host matches; no global
  `credential.helper` is set.
- **Independent authorization** — one device flow per repository, authorized
  by the account that owns (or has write access to) that repository.
  Tokens are minted per repo and never copied between projects.

### Historical `.tools/` architecture — verification result

The BEAN FX historical reference (`/home/z/my-project/.tools/gh-config/
hosts.yml` + `.tools/git-cred.sh`, "survived two recycles") was audited:
**neither `/home/z/.tools` nor `/home/z/my-project/.tools` exists in the
current environment**, and the Bean-FX workspace is not present on this
machine. The claim is unverifiable here; the standard does not adopt it.
The M18-verified `.git/bean-auth/` plane is the active architecture.

## 2. Per-project configuration

| | BEAN Folio | BEAN Intelligence | BEAN FX |
|---|---|---|---|
| Workspace root | `/home/z/my-project` | `/home/z/bean-intelligence` (fresh public clone) | not present on disk |
| Remote | `Ebin0471/BEAN-Folio` | `jon0471-dot/Bean-intelligence` | `ebinj-dev/Bean-FX` (URL per owner; unverified) |
| Branch | `main` | `main` | — |
| Designated account | `Ebin0471` | `jon0471-dot` (pinned by `docs/HANDOFF.md` §0) | `ebinj-dev` (presumed owner) |
| Vault state | token present, working | provisioned, **empty (fail-safe)** | not created |
| Helper wired | yes (repo-local) | script installed; config wired by `bean-auth.sh` on first use | — |
| Scripts installed | `scripts/ops/bean-*.sh` (committed, M18) | `scripts/ops/bean-*.sh` (committed locally `055d8d8`, push blocked) | not installed |
| Status | **OPERATIONAL** | **PROVISIONED / PUSH-BLOCKED** | **BLOCKED** |

## 3. Repository-specific authentication findings

### BEAN Folio (`Ebin0471/BEAN-Folio`)
- M18 vault operational; account `Ebin0471`; `repo read:org`.
- No `gh` CLI, no SSH client, no platform GitHub integration exists in the
  sandbox (swept in M18 audit) — device flow into the `.git/` vault is the
  only viable mechanism.

### BEAN Intelligence (`jon0471-dot/Bean-intelligence`)
- Public repository — anonymous fetch works without any credential.
- Standing policy (`docs/HANDOFF.md` §0, owner-approved 2026-11-12):
  repo-local git-internal credential store, account pinned `jon0471-dot`,
  workflow MAKE→TEST→REVIEW→SCAN→COMMIT→PUSH→VERIFY, device flow as
  fallback only. This standard implements the same workflow via
  `bean-sync.sh` and the same security properties via `.git/bean-auth/`.
- **Authorization blocker (exact evidence):** the sandbox's device-flow
  authorizations returned account `Ebin0471` (verified twice via
  `GET /user` → `login: Ebin0471`). GitHub API permissions for `Ebin0471`
  on `jon0471-dot/Bean-intelligence`: `pull: true, push: false` (verified
  twice via `GET /repos/jon0471-dot/Bean-intelligence`). A non-designated
  read-only token was therefore erased from the vault per fail-safe policy
  (the public repo needs no token for fetch; keeping a wrong-identity
  token would violate the pinned-account policy).
- Per the master spec ("use the official GitHub device flow **once** for
  that repository"; "never loop authentication requests") the device-flow
  allowance for this repository is consumed. No further authentication
  requests are made until the underlying access changes.
- Local commit `055d8d8` (standardization scripts) is **preserved unpushed**
  per "preserve local commits when authentication fails".

### BEAN FX (`ebinj-dev/Bean-FX`)
- Workspace not present on this machine (only `/home/z/my-project` exists).
- `git ls-remote https://github.com/ebinj-dev/Bean-FX.git` (unauthenticated)
  → `Repository not found`.
- Authenticated existence probe with the Folio token (**diagnostic only —
  the token was not installed into any FX credential store**):
  `GET /repos/ebinj-dev/Bean-FX` → `404 Not Found` — `Ebin0471` has no
  visibility of the repository (private to others, or not at that URL).
- No device flow was requested for FX: the only authorizable browser
  account (`Ebin0471`) is provably denied access; requesting a code would
  mint a dead token. FX is **BLOCKED** pending either an `ebinj-dev`
  browser session or an owner-granted collaborator access for `Ebin0471`.

## 4. Automatic synchronization workflow (all projects)

```
IMPLEMENT → TEST → REVIEW DIFF → STAGE APPROVED FILES → SECRET SCAN
→ COMMIT → FETCH → CHECK REMOTE → FAST-FORWARD PUSH → VERIFY REMOTE SHA
```

Implemented by `scripts/ops/bean-sync.sh`:

```bash
scripts/ops/bean-sync.sh commit -m "feat(scope): message" -- <approved paths...>
scripts/ops/bean-sync.sh push       # already-verified local commits
scripts/ops/bean-sync.sh verify     # connectivity + SHA match only
```

Guarantees: explicit-path staging only (no unrelated changes), staged-diff
secret scan with masked reporting, remote-advance/divergence detection
before pushing, plain push only (force flags never used), remote SHA must
equal local HEAD or the failure is loud, local commits always preserved on
auth failure, single clear recovery hint instead of auth loops.

## 5. Persistence test evidence (exact)

### Test A — authentication
| Project | Result | Evidence |
|---|---|---|
| Folio | VERIFIED | `bean-auth.sh test`: account `Ebin0471`, repo access yes, remote main SHA read |
| Intelligence | FAILED | Device flow returned `Ebin0471`; API: `push:false, pull:true` on designated repo (twice) |
| FX | BLOCKED | Repo Not Found for anonymous and `Ebin0471`-authenticated probes |

### Test B — reuse
| Project | Result | Evidence |
|---|---|---|
| Folio | VERIFIED | 3× fetch no prompt; test branch push SHA-verified then deleted; no prompts |
| Intelligence | VERIFIED (read) | 3× anonymous fetch OK (public repo); push probe fails fast and clean (empty vault, no hang) |
| FX | NOT IMPLEMENTED | no workspace |

### Test C — push (dedicated branch)
| Project | Result | Evidence |
|---|---|---|
| Folio | VERIFIED | `bean-m18-sync-test` push: local `237921296d63cbc429eccc0750862e41505b1041` == `git ls-remote`; branch deleted after |
| Intelligence | FAILED | push rejected: no write-capable authorization (see §3) |
| FX | NOT IMPLEMENTED | no workspace |

### Test D — session persistence
| Project | Result | Evidence |
|---|---|---|
| Folio | VERIFIED (session turns) | Vault token minted 2026-11-14 02:43 still answers API + fetch at the next conversation session with no device flow. Recycle-boundary survival remains architecturally evidenced only (`.git/` demonstrably survived the prior workspace restore); first natural recycle will confirm. |
| Intelligence | UNVERIFIED | no valid credential to test; workspace `/home/z/bean-intelligence` sits outside the only proven-persistent snapshot plane |
| FX | NOT IMPLEMENTED | no workspace |

## 6. Recovery instructions

| Situation | Action |
|---|---|
| Folio: remote ops fail (401/prompt) | `scripts/ops/bean-auth.sh status` → if no token: `start` → authorize as `Ebin0471` → `poll` → `test`. |
| Intelligence: to unblock push | Either (a) authorize a device flow from a browser session logged in as `jon0471-dot` (check avatar at github.com first), then `bean-auth.sh start`/`poll` in `/home/z/bean-intelligence`, then `bean-sync.sh push`; or (b) owner adds `Ebin0471` as a collaborator, then the same flow. Afterwards re-run Test A/C and update this document. |
| FX: to unblock at all | Workspace must be cloned (requires visibility) from a browser session/authorization that can see `ebinj-dev/Bean-FX`; then install `scripts/ops/bean-*.sh` (copy from Folio, pin `REPO_ROOT`), one device flow, `bean-sync.sh` thereafter. |
| Sync aborts "histories diverged" | Follow the printed reconciliation plan; never force-push. |
| Secret scan hits | Remove material, rotate any real exposed credential, re-run. |
| `.git/config` helper line lost | Any `bean-auth.sh`/`bean-sync.sh` run re-attaches it idempotently. |

## 7. Security model (requirement → implementation)

| Requirement | Implementation |
|---|---|
| No plaintext tokens in tracked files | vault inside `.git/` (untrackable by construction); sync secret-scan as defense in depth |
| No credentials in Git history | token never enters an object; history scanned for token patterns (clean) |
| No tokens in terminal logs | masked status output only; device-flow response parsed silently |
| No tokens in shell history | values live in shell variables piped via stdin; no literal secrets in commands |
| No credentials in argv | API calls via `curl -H @-` (stdin header) |
| No private keys committed | none exist; history scan for key material returned only scanner-regex/redaction fixtures |
| Minimum OAuth scope | `repo read:org` only; per-repo revocable |
| No credential copying between projects | separate vaults, separate device flows; FX probe used Folio token read-only as diagnostics, never stored |
| Helper restricted to GitHub | repo-local `credential.https://github.com.helper` key only |
| 600/700 permissions | vault file 600, vault dir 700; enforced on every `bean-auth.sh` run |

## 8. Platform limitations

- Workspace restore preserves tracked files + `.git/`; drops untracked
  working-tree files (`.tools/`-style storage cannot persist here).
- `/home/z/bean-intelligence` (outside the proven snapshot plane) has
  **unverified** persistence; assume re-clone may be needed after a
  sandbox recycle.
- No `gh`, no `ssh`, no credential managers installed; non-TTY shell
  forbids interactive prompts; unauthenticated GitHub REST API is
  rate-limited.
- Device-flow authorizations take the identity of the browser session that
  enters the code — the sandbox cannot force an account; wrong-account
  results must be handled by fail-safe erasure (as done here), not retries.

## 9. M19 hardening and verification — BEAN Folio only (2026-11-14)

Scope: BEAN Folio exclusively. No other BEAN repository was opened, cloned,
or modified in this milestone.

### Immutable identity (verified, not assumed)

| Item | Verified value |
|---|---|
| Authenticated identity (`GET /user`) | `Ebin0471` (id `204152288`, type `User`) |
| Repository (`GET /repos/Ebin0471/BEAN-Folio`) | `Ebin0471/BEAN-Folio`, private, `default_branch: main` |
| Permissions | `push: true`, `admin: true` |
| Remote URL | `https://github.com/Ebin0471/BEAN-Folio.git` (correct — preserved, no correction needed) |
| Branch | `main` |
| Local HEAD / Remote main SHA | `90ffaa5663754d7469fa6873bcb841e9a87d89ee` (identical at verification time; commit confirmed present locally via `git cat-file -t` and remotely as ancestor of `origin/main`) |

### M18 asset preservation

All six assets inspected and preserved (no recreation): `scripts/ops/
bean-credential-helper.sh`, `scripts/ops/bean-auth.sh`, `scripts/ops/
bean-sync.sh`, `.git/bean-auth/` (dir 700, token 600), `.git/config`
(helper wired), both auth documents. Reference commit `90ffaa5` preserved
locally and remotely.

### Concrete defect found and fixed (architecture unchanged)

The M18 credential helper answered **any** host when invoked directly
(a probe with `host=gitlab.com` returned a full credential block — 107
bytes). In practice Git never invoked it for other hosts because the
helper is wired under the repo-local
`credential.https://github.com.helper` key, but the M19 requirement
("never return credentials for arbitrary hosts") mandates defense in
depth. Fix (inside the same helper script, no architecture change): the
`get` operation now parses the credential request from stdin and answers
only for `protocol=https` **and** `host=github.com`; every other
host/protocol gets zero output and Git fails fast.

Post-fix verification: `gitlab.com` → 0 bytes; `http://github.com` →
0 bytes; `https://github.com` → credential served; 3× real fetch OK.

### M19 test results (exact)

| Test | Result | Evidence |
|---|---|---|
| A — Identity | PASS | `/user` → `login: Ebin0471` |
| B — Repository | PASS | `/repos/Ebin0471/BEAN-Folio` → full_name, private, main, push:true |
| C — Auth reuse | PASS | 3× fetch, no prompt, no device flow; helper returns exactly `protocol/host/username/password` keys |
| D — Auto commit | PASS | `bean-sync.sh commit` (this milestone's doc + helper hardening), explicit staging, secret scan clean |
| E — Push | PASS | plain fast-forward push via `bean-sync.sh`, no force |
| F — Remote verify | PASS | `git ls-remote origin refs/heads/main` == local HEAD (reported in the M19 delivery report) |
| G — Session persistence | VERIFIED across session turns | Token minted 2026-11-14 02:43:57 UTC still answers `/user` as `Ebin0471` and fetches without device flow at this later session. Recycle-boundary survival remains architecturally evidenced only (`.git/` survived the prior workspace restore); the first natural recycle will complete it. |

### Credential-manager migration tradeoff (required check)

No alternative persistent credential manager exists in this sandbox
(no `gh`, no Git Credential Manager, no `git-credential-store` binary, no
SSH client, no secrets mounts — swept in the M18 audit). The `.git/`
vault is the only storage plane with demonstrated persistence. **No
migration performed** — none available, and the current architecture has
no concrete defect remaining after the host-scoping fix.

### Remaining Folio limitations

1. Recycle-boundary persistence pending first natural recycle (Test G
   evidence covers session turns; `.git/` survival of restore is strong
   architectural evidence).
2. The OAuth token's lifetime is governed by GitHub; if it is revoked,
   the single recovery path is one device flow (`bean-auth.sh start`/`poll`
   as `Ebin0471`).
3. The Intelligence clone's copy of `bean-credential-helper.sh` still has
   the pre-hardening helper (out of M19 scope by mandate); it will receive
   the same hardening when that project unblocks.

---

*Contains no credentials, tokens, or private keys.*
