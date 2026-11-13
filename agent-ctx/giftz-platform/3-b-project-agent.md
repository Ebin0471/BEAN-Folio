# Task 3-b (file-level agent pipeline) — GIFTZ standalone platform — Work Record

Agent: 3-b. Contract: `CONTRACT.md` §6 (file pipeline), §4 row `files/apply-proposal`.
Scope honored: turn.ts touched MINIMALLY (routing hook + retry guard only — config pipeline untouched byte-for-byte); no new AI providers; AI only via `aiComplete` server-side; owner-scoped everywhere; honest failures; working tree mutated ONLY by the apply route. Did NOT touch portfolio flows, project-build/files/compiler/versions internals, or any frontend file.

---

## 1. Files created

| File | Purpose |
|---|---|
| `src/lib/giftz/project-agent.ts` | The §6 pipeline: `classifyProjectRequest`, `runProjectTurn`, `applyFileProposal` (+ exported types `ProjectRouting`, `RunProjectTurnParams`, `ProjectFileChange`, `FilesProposal`, `ApplyFilesResult`). |
| `src/app/api/giftz/sites/[id]/files/apply-proposal/route.ts` | POST `{ messageId }` per §4: owner + `rateLimitShared("giftz-apply:"+user.id, 20, 60_000)` + `maxDuration = 120` + `parseBodySized` (4KB budget). |

## 2. Files modified

| File | Change |
|---|---|
| `src/lib/site-studio/turn.ts` | 4 surgical edits ONLY: (1) import `classifyProjectRequest`/`runProjectTurn`; (2) `ExecuteTurnParams` gains `giftzSiteId: string | null`; (3) `startStudioTurn` passes `giftzSiteId: session.targetKind === "giftz" ? session.targetSiteId : null`; (4) `executeTurn` gains the routing block BEFORE the `// ---- PLAN (shared pipeline)` comment (see §4 below); (5) `retryStudioTurnStep` gains a `meta.pipeline === "files"` → 409 guard after meta parsing. The existing config pipeline (plan → direct → execute → review → polish → proposal) is UNCHANGED — no existing line was edited, only insertions. |
| — | No other file touched. Import-cycle rule honored: project-agent.ts does NOT import turn.ts (stage/fail helpers duplicated locally as `setFileStage`/`failFileTurn`, same conventions: message `status RUNNING` + `metaJson { stage, pipeline:"files", ... }`, task `stepsJson [{ step, status:"running", at }]`; failure → FAILED + 300-char task error). |

## 3. FINAL proposalJson contract (source of truth for ChatPanel/preview/apply)

Persisted on the ASSISTANT message via `db.siteStudioMessage.update` (DONE, or FAILED when a batch failed — proposal preserved either way):

```json
{
  "kind": "files",
  "summary": "<plan.summary, ≤2000 chars>",
  "jobId": "<AgentTask id (taskId)>",
  "fileChanges": [
    { "path": "about.html", "action": "modified", "content": "<full utf8 content>", "encoding": "utf8", "summary": "<plan step instructions, ≤240 chars>" },
    { "path": "old.css", "action": "removed", "encoding": "utf8", "summary": "..." }
  ],
  "planNotes": "Validated on the first attempt." | "Plan validated after one repair round: <issues>",
  "verification": { "ok": true|false, "summary": "<real runProjectBuild diagnostics.summary>" },
  "configSynced": false,
  "config": { "...SiteConfig — present ONLY when the overlay changed site.config.json AND it passes normalizeConfig" }
}
```

- `content` present for `added`/`modified` (utf8 only — the pipeline never produces base64), absent for `removed`. Byte-identical rewrites are excluded from `fileChanges`.
- `configSynced: true` implies `config` present (normalized object). `preview-serve.loadProposalOverlay` (2-a) parses exactly this `fileChanges` shape (verified against its code).
- ChatPanel 2-b compatibility verified: ProposalCard reads `kind`, `fileChanges[] { path, action, summary, encoding? }`, `verification.ok/summary` (via `readFilesVerification` — renders only on an explicit boolean), `summary`, `config` (nullable), `baseConfigHash ?? ""` (files preview branch), `changedFiles ?? []`. §6 lists exactly the fields above; `changedFiles`/`baseConfigHash` are deliberately NOT written (absent = fine, both call sites default them) — noted as a deviation for the record.
- metaJson accompanies every state: `{ stage, pipeline: "files", jobId: taskId, runStatus: "succeeded"|"failed", plannedFiles, changedFiles, repairRounds, configSynced, skipped? }` — stages used: `reading files`, `planning` (reuses the existing ChatPanel label), `writing files`, `building` (+ `repairRound` extra), `done` / `writing files` (partial) / `crashed`. All are ChatPanel STAGE_LABELS keys or fall back to "Working…" honestly.
- AgentTask: COMPLETED + `resultJson { kind: "files-proposal", sessionId, assistantMessageId, jobId: taskId, pipeline: "files", buildOk, repairRounds, changedFiles }` on success; FAILED + error on partial/full failure; no-changes → message FAILED + task COMPLETED `kind: "no-changes"` (mirrors the config pipeline's no-op guard).

## 4. classify→delegate integration in executeTurn (insertion point quoted)

In `src/lib/site-studio/turn.ts`, immediately after the user lookup and BEFORE `// ---- PLAN (shared pipeline) ----`:

```ts
  // ---- GIFTZ FILE-MODE ROUTING (contract §6) ---------------------------
  if (p.giftzSiteId) {
    const giftzSite = await db.giftzSite.findUnique({ where: { id: p.giftzSiteId } });
    if (!giftzSite || giftzSite.userId !== p.userId) {
      await failTurn(..., "The generated site bound to this conversation no longer exists.", "plan");
      return;
    }
    await setStage(p.assistantMessageId, p.taskId, "planning");
    const routing = await classifyProjectRequest(p.userId, giftzSite, p.request);
    if (routing.intent === "files") {
      await runProjectTurn({ userId, site: giftzSite, request, sessionId, assistantMessageId, taskId });
      return;
    }
    // intent "config" — the existing design pipeline continues unchanged.
  }
```

- Portfolio sessions never reach the classifier (`giftzSiteId` is null unless `targetKind === "giftz"`); giftz sessions WITHOUT a bound site keep the config pipeline (no project tree exists to operate on).
- `intent: "config"` → the pre-existing flow is 100% unchanged (the duplicate `setStage("planning")` write is idempotent).
- A vanished/foreign site mid-turn is an honest failure, not a silent config fallback.

## 5. Pipeline mechanics (as implemented)

1. **Context** (`reading files`): `listProjectFiles` tree (path — bytes (text|binary, source)) + last build's `parseBuildDiagnostics` + ALL utf8 files ≤48KB each within a 220KB total budget (path-sorted, honest truncation); base64/oversized files listed as paths only ("treat as opaque").
2. **PLAN** (`planning`): `aiComplete(temperature 0.2, thinking: true, AI_DEEP_TIMEOUT_MS, agent CODE_GIFTZ)` → `parseJsonFromText` → zod `filePlanSchema` ({ summary ≤2000, files 1..12 × { path ≤200, action create|modify|delete, instructions ≤4000 } }) PLUS tree validation (safe path, create-vs-exists, modify/delete-vs-missing, no duplicate paths, site.config.json/package.json never deleted). ONE repair round: invalid output passed back verbatim (≤6000 chars) + issue list — mirrors provider.ts. Still invalid → honest FAILED with up to 4 issues.
3. **EXECUTE** (`writing files`): deletes are deterministic (no AI) → overlay `null`; create/modify batched ≤4 files per `aiComplete` (temperature 0.2, AI_DEEP_TIMEOUT_MS) → `{ files: [{ path, content }] }` via `parseJsonFromText` + zod; strict path matching (only requested paths accepted), per-file `constrainProjectPath` + `assertProjectLimits` — violations SKIPPED with honest notes in `overlay.problems` (never abort the turn); batch AI failure/parse failure records the failed batch and continues. Current content for modify = overlay-then-tree (sequential batches see earlier writes).
4. **BUILD** (`building`): `runProjectBuild(site, "ai", overlay)` → on FAILED with error diagnostics: REPAIR up to 2 rounds (`aiComplete` with the real error lines + affected files' effective content, 120KB budget) → overlay updates → rebuild. A repair round producing 0 usable files stops the loop honestly. Build-failure is NEVER reported as success: `verification { ok: false, summary }` + up to 3 error lines quoted in the DONE message; the user can still preview/save/discard (§6).
5. **PROPOSAL**: persisted via `db.siteStudioMessage.update` (shapes in §3). Message text on DONE = plan.summary + honest build verdict (+ skipped notes). Partial batch failure → status FAILED with the specific per-batch error + proposal preserved (mirrors the config pipeline's partial-success convention). Zero changes → FAILED no-op guard (request kept).
6. **Crash resilience**: the catch persists a partial overlay (if any) as FAILED-with-proposal marked "NOT verified"; otherwise the honest generic failure. Outer `startStudioTurn` catch + the SITE_STUDIO_TURN sweep (same task kind; stage writes keep `AgentTask.updatedAt` fresh) cover the remaining cases.

## 6. applyFileProposal (route engine)

- Load message with session include; requires `session.userId === user.id` AND `session.targetKind === "giftz"` AND `session.targetSiteId === site.id` → else 404. `proposalJson.kind === "files"` + `fileChanges` array → else 400.
- Pre-flight BEFORE any write: a changed `site.config.json` must pass `normalizeConfig` (else **422**, nothing applied — mirrors the PUT files/content contract); when `configSynced` is set, `siteConfigMediaError` also runs (**422** on media violations, nothing applied).
- Apply: `removed` → `deleteProjectFile` EXCEPT `site.config.json` (skipped with a note); `added`/`modified` (utf8 string content) → `assertProjectLimits` + `writeProjectFile(source "ai")`; per-file violations are skipped-and-logged (never abort the whole apply); action in the response is computed at APPLY time (`added` vs `modified`) so tree drift between proposal and save is reported honestly.
- `configSynced && config` → `GiftzSite.config` updated with the validated normalized config; `snapshotProjectVersion(siteId, user.id, "AI proposal apply", "ai")` + `recordGiftzActivity "ai.edit"` (`{ messageId, applied, configSynced, skipped }`) run only when something actually changed.
- Response: `{ applied: number, files: [{ path, action }], config?: SiteConfig }` — matches `GiftzApplyFilesResultDTO` in giftz-client.ts (2-b). Skipped entries are logged server-side (`log.warn giftz.agent.apply_skipped`) — the DTO has no channel for them; the response reports what WAS applied.

## 7. Retry behavior decision (documented, not fragile)

- **"Retry request" (full re-run) WORKS for file turns** — `startStudioTurn` re-resolves the base, creates a fresh task/assistant message, and the prompt re-enters the router (it may legitimately classify differently on a retry, e.g. after files changed).
- **"Retry failed step" is an honest 409 for file turns**: `retryStudioTurnStep` now returns `{ ok: false, status: 409 }` when `meta.pipeline === "files"`. Rationale: file turns have no in-memory design job; without the guard the existing `latestFailedJob(userId)` fallback could silently re-run an UNRELATED design job from the same account — a correctness hazard, not just a missing feature. ChatPanel never shows the button for file stages (its condition matches only `execute`/`execute-partial`/`retry-crashed`/`stage-undefined`), so this guards the direct API path; the error message directs users to "Retry request".

## 8. AI-call budget per file turn (all recorded as `recordAiUsage(userId, "giftz-project-agent")`, fire-and-forget, one per successful call)

| Stage | Calls |
|---|---|
| Router (classifyProjectRequest) | 1 (0 if the gateway fails → honest "config" default, logged `giftz.agent.classify_failed`) |
| Plan | 1–2 (first attempt + at most ONE repair) |
| Execute | 0–3 (≤12 write-steps ÷ 4 per batch; deletes are AI-free) |
| Repair | 0–2 (only when the build has error diagnostics and the previous round produced usable fixes) |
| **Total** | **≤8 per turn** (plus the pre-existing 1 usage row the messages route records at turn start) |

Timeouts: plan calls use `AI_DEEP_TIMEOUT_MS` + thinking; execute/repair use `AI_DEEP_TIMEOUT_MS`; classify uses the default 60s at temperature 0.

## 9. Verification

- `bun run lint` → **0 errors, 13 warnings — all pre-existing baseline** (`scripts/loadtest/k6/*`, `PostComments`, `PostComposer`, `PostMediaView`, `VideoCard`, `PostDetailView`); zero findings in any file I created/modified (grep for `project-agent|apply-proposal|site-studio|turn.ts` over lint output: empty).
- `bunx tsc --noEmit | grep -E "project-agent|site-studio|apply-proposal"` → **empty (clean)**. Full tsc shows 113 pre-existing errors, none in my files (stale generated-Prisma models in unrelated routes + `scripts/`/`tests/` clusters + the pre-existing `Response.json` typing in the retry route — untouched by me).
- Dev server (auto-running) recompiled cleanly after the changes (`✓ Compiled`); the instrumentation Edge-Runtime warnings in dev.log are pre-existing and unrelated.
- Not run (per instructions): `bun test`, no dev-server smoke tests.

## 10. Contract deviations / notes

1. **proposalJson does NOT include `changedFiles`/`baseConfigHash`** — §6's field list is authoritative and ChatPanel defaults both defensively (`changedFiles ?? []`, `baseConfigHash ?? ""` in the files preview branch). Adding empty placeholders would have deviated from the §6 shape; ChatPanel renders identically either way.
2. **Router-failure visibility**: a classify failure defaults to "config" (per §6) and is logged server-side; the persisted turn meta does not carry a routing record because writing one would have required touching the config pipeline's final writes (forbidden — "100% UNCHANGED"). The config pipeline still fulfills such requests; the honest note lives in the server log (`giftz.agent.classify_failed` / `giftz.agent.classify_invalid`).
3. **Apply pre-flight is stricter than the §6 text**: ANY changed site.config.json in `fileChanges` must pass normalizeConfig before apply (not just `configSynced` ones) — otherwise the apply would write a broken bridge file that fails every later build; 422 leaves the tree untouched, mirroring the PUT files/content semantics 2-a implemented.
4. **Multiple build rows per file turn**: the pipeline builds up to 3 times (initial + 2 repair rounds), all honest `trigger: "ai"` rows in build history — this IS the audit trail of the repair loop.
5. **Overlay limits vs accumulated total**: per-file `assertProjectLimits` checks against the working tree, not the accumulated overlay; a turn whose overlay alone exceeds the 30MB project cap is caught honestly by the build's check 5 (FAILED diagnostics, `verification.ok: false`).
6. **Pre-existing concurrency characteristic (noted, not mine to fix)**: `runProjectBuild`'s deployStatus transition reads the `GiftzSite` row passed in; a publish completing mid-turn could see a stale `deployStatus` (same exposure exists for the POST builds route — 2-a's surface). The window is small and the transition is monotonic-safe for PREVIEW/READY_TO_PUBLISH.
7. **`classifyProjectRequest(userId, site, request)`** takes the site row (not a free-form context string) so the router can include the real file count; the §6 signature `classifyProjectRequest(request, siteContext)` is satisfied in spirit (siteContext = the site's title/framework/fileCount).
