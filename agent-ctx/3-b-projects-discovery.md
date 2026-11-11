# Task 3-b — Projects & Discovery API (work record)

Agent: 3-b projects/discovery backend agent (Z.ai Code)
Status: COMPLETE (relaunch — first attempt failed before creating any files; all 13 files created fresh this run)

## Files created (all under src/app/api/)
1. `projects/route.ts` — GET own list (+`?status=DRAFT|PUBLISHED`), POST create
2. `projects/[id]/route.ts` — GET detail, PATCH, DELETE
3. `projects/[id]/publish/route.ts` — POST
4. `projects/[id]/unpublish/route.ts` — POST
5. `projects/[id]/view/route.ts` — POST (deduped view)
6. `projects/[id]/save/route.ts` — POST + DELETE
7. `discover/route.ts` — GET ranked feed
8. `search/projects/route.ts` — GET
9. `search/profiles/route.ts` — GET
10. `me/saves/route.ts` — GET
11. `me/collections/route.ts` — GET + POST
12. `collections/[id]/route.ts` — PATCH + DELETE
13. `collections/[id]/items/route.ts` — POST + DELETE

No shared file was modified.

## Key decisions
- **Draft guard (slight tightening beyond the letter of the spec):** `GET /api/projects/[id]` 404s non-owners for DRAFT projects even when visibility is PUBLIC (drafts are never shared). Mirrored in the view endpoint.
- **403 vs 404:** non-owner PATCH/DELETE/publish/unpublish → 403 'Not allowed'; collections/[id] + items → 404 for missing OR foreign collections (explicit task spec).
- **parseBody pattern:** `if (r.response) return r.response;` (corrected convention).
- **Skills resolver** duplicated module-locally in the two project route files (precedent: 3-a onboarding) to respect file-ownership boundaries; capped at 15, P2002-safe create.
- **Privacy:** owner-card/project-count `_count.projects` filtered to PUBLISHED; collection item lists query-filter `visibility ≠ PRIVATE` + live owner; saves list skips PRIVATE + deleted owners.
- **Discover ranking (all real counts):** `score = exp(-days/14) × (1 + 0.5·log1p(saves) + 0.3·log1p(views)) + 0.8 categoryBoost + 0.5 newCreator + FNV-1a jitter (0..0.05)`; reason priority New → Popular → Profession; labels resolved from the live Profession table; block-filter both directions; candidate pool 60, offset cursor, limit 12 (max 24).
- **Save notifications** fire only on the first save of a project by a user (idempotent re-saves don't spam).

## Verification
- `bun run lint` — clean.
- `bunx tsc --noEmit` — zero errors in the 13 owned files. (Pre-existing elsewhere: `src/app/page.tsx` ×7 — shell/stubs, `src/lib/serialize.ts` ×1, examples/skills.)
- Live curl E2E vs dev server — all passed: register/onboard ×2 users → create (400 bad category / 400 over-length title / 200 full payload) → own-list filters (200 / 400 invalid status) → detail visibility ladder (owner 200 / anon+B on draft 404 / anon on published 200 / UNLISTED readable / PRIVATE 404) → PATCH (401 anon, 403 B, 400 bad category, 200 array-wholesale replace incl. media + cover + skills + tools) → publish gate exact 400 message → foreign cover/media 400 → publish 200 (republish preserves publishedAt) → view dedup confirmed via insights totals (3 distinct viewer keys; repeats and owner views not counted) → discover reasons observed ('New on BEAN Folio', 'Popular in Photography', 'Matches your profession: Photography') + category filter + cursor pagination + limit clamp → search projects q/category/skill/sort=saved/pagination/q≤80 → save (401 anon, 400 own, 404 draft/private, 200 unlisted, idempotent, first-save-only SAVE notification with {actor, actorUsername, projectTitle}) → me/saves → collections (404 foreign, 400 empty name, item add PUBLISHED-only, item DELETE ?projectId= required, PATCH clears empty description) → search profiles (q/profession/skill filters, self-exclusion, real follower/project stats) → block filter excludes blocked party from discover/search as viewer → DELETE 403 foreign / 200 owner.
- Test data cleaned: all test projects/collections/media deleted via API; both temp users soft-deleted via `/api/me/deletion` (sessions revoked, `auth/me` null); 3 SAVE notifications orphaned on the anonymized users removed via Prisma. Final DB: 0 projects, 0 saves, 0 collections, 0 views, 0 media.
- dev.log: no errors from these routes.

## Note for orchestrator (shared file, not touched)
`src/lib/serialize.ts:113` — pre-existing TS2339: `PersonInput.skills` is typed `{ skill: { slug: string } }[]` but `toPublicPerson` maps `s.skill.label`. All callers pass full Skill rows, so widening the type to `{ skill: { slug: string; label: string } }[]` fixes it cleanly.
