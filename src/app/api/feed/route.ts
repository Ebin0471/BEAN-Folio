import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { err, getClientKey, handler, ok, rateLimitShared } from "@/lib/api-helpers";
import { feedPage, type FeedMode } from "@/lib/feed";

export const dynamic = "force-dynamic";

const MODES: FeedMode[] = ["following", "foryou", "trending", "video"];

/**
 * GET /api/feed?mode=following|foryou|trending|video
 *
 * The social feed engine (lib/feed.ts — explainable ranking, no fabricated
 * engagement):
 *   following — ACTIVE follow graph, strict chronological keyset;
 *   foryou    — affinity + engagement + freshness ranking with creator
 *               diversity, negative-signal aware (hidden posts, mutes);
 *   trending  — 72h engagement velocity blended with total engagement and
 *               freshness, flood-spam filtered;
 *   video     — reels/video posts ranked by freshness + engagement.
 *
 * Query: limit, cursor (offset for ranked modes / last-createdAt-ms for
 * following), exclude (comma-separated post ids already rendered — cross-page
 * repeat guard). Every response also records one "served in feed" impression
 * per post (Post.impressions + daily buckets) — separate from actual views.
 */
export const GET = handler(async (req: NextRequest) => {
  // Generous public-read budget (M22): 300 req/min/IP — abuse throttle, not a UX limit.
  const limited = await rateLimitShared("read:feed:" + getClientKey(req), 300, 60_000);
  if (limited) return limited;
  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode") ?? "foryou";
  if (!MODES.includes(modeParam as FeedMode)) return err(`Unknown feed mode — use one of: ${MODES.join(", ")}`, 400);
  const mode = modeParam as FeedMode;

  const limit = Math.max(1, Number(url.searchParams.get("limit")) || 10);
  const cursor = Number(url.searchParams.get("cursor")) || undefined;
  const exclude = (url.searchParams.get("exclude") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 64)
    .slice(0, 50);

  const viewer = await getSessionUser();

  const page = await feedPage(mode, viewer?.id ?? null, { cursor, limit, excludeIds: exclude });
  return ok({ mode, items: page.items, nextCursor: page.nextCursor });
});
