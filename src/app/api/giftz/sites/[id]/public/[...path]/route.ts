import { NextRequest, NextResponse } from "next/server";

import { handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { constrainProjectPath, isTextMime, mimeForPath } from "@/lib/giftz/project-files";
import { PREVIEW_CSP } from "@/lib/giftz/preview-serve";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; path: string[] }> };

interface ArtifactFile {
  path: string;
  mime: string;
  encoding: "utf8" | "base64";
  content: string;
}

/**
 * Parse a deployment artifact ({ files: [{ path, mime, encoding, content }] })
 * into a path-keyed map. Malformed/empty artifacts honestly serve nothing.
 */
function parseArtifact(filesJson: string | null): Map<string, ArtifactFile> | null {
  if (!filesJson) return null;
  try {
    const parsed = JSON.parse(filesJson) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    const map = new Map<string, ArtifactFile>();
    for (const f of parsed.files) {
      if (!f || typeof f !== "object") continue;
      const file = f as { path?: unknown; mime?: unknown; encoding?: unknown; content?: unknown };
      if (typeof file.path !== "string" || typeof file.content !== "string") continue;
      map.set(file.path, {
        path: file.path,
        mime: typeof file.mime === "string" && file.mime ? file.mime : mimeForPath(file.path),
        encoding: file.encoding === "base64" ? "base64" : "utf8",
        content: file.content,
      });
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

function publicHeaders(mime: string): Record<string, string> {
  return {
    "Content-Type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime,
    // Published artifacts are immutable per deployment — a short shared-cache
    // window keeps republish/rollback switches near-instant.
    "Cache-Control": "public, max-age=60",
    // Same sandboxing model as the owner-only preview: the site can render and
    // inline-interact but CANNOT fetch from the network (connect-src 'none').
    "Content-Security-Policy": PREVIEW_CSP,
    "X-Content-Type-Options": "nosniff",
  };
}

/** 404 for a missing file inside a live deployment — plain text (the iframe renders it raw). */
function fileNotFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 404 JSON when the site has no LIVE deployment (unpublished / unknown site). */
function notPublished(): NextResponse {
  return NextResponse.json({ error: "not-published" }, {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * GET /api/giftz/sites/[id]/public/[...path] — PUBLIC serving of the newest
 * LIVE deployment's built artifact (contract §5.2). This is the only
 * unauthenticated GIFTZ route: visitors hit it through the iframe on
 * /site/<username>/g/<siteId>. No auth, no cookies — the deployment row IS
 * the authorization (only the publish pipeline creates LIVE rows, and only
 * from a SUCCEEDED build's artifact).
 *
 * Directory-style requests resolve to that directory's index.html; the same
 * strict CSP as the owner preview applies, with a short public cache window
 * instead of no-store.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id, path: segments } = await params;

  const site = await db.giftzSite.findUnique({
    where: { id },
    select: { user: { select: { deletedAt: true } } },
  });
  // Soft-deleted accounts keep their rows (no cascade) — they must not serve.
  if (!site || site.user.deletedAt) return notPublished();

  const deployment = await db.giftzDeployment.findFirst({
    where: { siteId: id, status: "LIVE" },
    orderBy: { createdAt: "desc" },
  });
  const files = parseArtifact(deployment?.filesJson ?? null);
  if (!deployment || !files) return notPublished();

  let joined = "";
  try {
    joined = (segments ?? []).map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return fileNotFound();
  }
  if (joined === "" || joined.endsWith("/")) joined = `${joined}index.html`;
  joined = joined.replace(/^\/+/, "");

  const candidates: string[] = [];
  try {
    candidates.push(constrainProjectPath(joined));
  } catch {
    return fileNotFound();
  }
  // Extensionless last segment → also try the directory's index.html.
  const lastSegment = candidates[0].split("/").pop() ?? "";
  if (!lastSegment.includes(".")) {
    try {
      candidates.push(constrainProjectPath(`${joined}/index.html`));
    } catch {
      // fall through with the single candidate
    }
  }

  for (const candidate of candidates) {
    const file = files.get(candidate);
    if (!file) continue;
    if (file.encoding === "base64") {
      return new NextResponse(new Uint8Array(Buffer.from(file.content, "base64")), {
        status: 200,
        headers: publicHeaders(file.mime),
      });
    }
    return new NextResponse(file.content, {
      status: 200,
      headers: publicHeaders(file.mime),
    });
  }
  return fileNotFound();
});
