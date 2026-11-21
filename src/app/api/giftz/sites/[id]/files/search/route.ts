import { NextRequest } from "next/server";

import { handler, ok, err, ERR } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { listProjectFiles } from "@/lib/giftz/project-files";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Result caps — a bounded, honest search over the project's text rows. */
const MAX_RESULTS = 40;
const MAX_FILES_SCANNED = 300;
const MAX_FILE_BYTES = 262_144; // 256KB — matches the per-file text cap
const MAX_LINE_LENGTH = 160;

interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * GET /api/giftz/sites/[id]/files/search?q=… — project-wide text search
 * across the site's UTF-8 project files. Owner-scoped; results are bounded
 * (≤40 matches, ≤300 files scanned, per-file scan cap) and each match carries
 * path + 1-based line + a bounded single-line excerpt. Case-insensitive.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 1 || q.length > 120) {
    return err("The search query must be 1-120 characters.", 400);
  }
  const needle = q.toLowerCase();

  const rows = await listProjectFiles(id);
  const matches: SearchMatch[] = [];
  let scanned = 0;
  for (const row of rows) {
    if (matches.length >= MAX_RESULTS) break;
    if (scanned >= MAX_FILES_SCANNED) break;
    if (row.encoding !== "utf8" || row.sizeBytes > MAX_FILE_BYTES) continue;
    scanned += 1;
    const lines = row.content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.toLowerCase().includes(needle)) {
        matches.push({
          path: row.path,
          line: i + 1,
          text: line.trim().slice(0, MAX_LINE_LENGTH),
        });
        if (matches.length >= MAX_RESULTS) break;
      }
    }
  }

  return ok({
    query: q,
    matches,
    truncated: matches.length >= MAX_RESULTS,
    filesScanned: scanned,
  });
});
