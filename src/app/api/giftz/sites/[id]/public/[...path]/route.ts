import { NextRequest, NextResponse } from "next/server";

import { handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { constrainProjectPath, isTextMime, mimeForPath } from "@/lib/giftz/project-files";
import { PREVIEW_CSP } from "@/lib/giftz/preview-serve";
import { getSessionUser } from "@/lib/auth";
import { isProfilePubliclyVisible } from "@/lib/visibility";

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

function publicHeaders(mime: string, cacheControl = "public, max-age=60"): Record<string, string> {
  return {
    "Content-Type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime,
    // Published artifacts are immutable per deployment — a short shared-cache
    // window keeps republish/rollback switches near-instant. M2: self-only
    // responses (private-profile owner previewing their own site) downgrade
    // to no-store so a shared cache can never serve a private site to the
    // next visitor within the cache window.
    "Cache-Control": cacheControl,
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
 * /site/<username>/g/<siteId>.
 *
 * M2 DEFENSE-IN-DEPTH (multi-tenant publishing prerequisite — spec Part F):
 * before any artifact byte leaves the server, ALL of these hold:
 * 1. the owner is ACTIVE (soft-deleted accounts never serve),
 * 2. the GIFTZ site is genuinely `status === "PUBLISHED"` (unpublishing
 *    revokes serving even if a LIVE row lingered),
 * 3. the owner's profile passes the `isProfilePubliclyVisible` ladder —
 *    PRIVATE/demo profiles serve ONLY to the session-authenticated owner
 *    (same self-exception as the JSON public endpoint), and only with
 *    `Cache-Control: no-store` so a shared cache can never leak the bytes,
 * 4. the selected deployment is genuinely LIVE and its artifact parses.
 * Previously the LIVE row alone was the gate — a private profile's published
 * artifact was reachable by anyone with the site id.
 *
 * Directory-style requests resolve to that directory's index.html; the same
 * strict CSP as the owner preview applies, with a short public cache window
 * instead of no-store for publicly visible sites.
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const { id, path: segments } = await params;

  const site = await db.giftzSite.findUnique({
    where: { id },
    select: {
      status: true,
      user: { select: { id: true, deletedAt: true, profileVisibility: true, isDemo: true } },
    },
  });
  // Soft-deleted accounts keep their rows (no cascade) — they must not serve.
  // Unpublished/never-published sites must not serve even if a LIVE row
  // somehow lingers (defense-in-depth; the pipeline already retires rows).
  if (!site || site.user.deletedAt || site.status !== "PUBLISHED") return notPublished();

  // Privacy ladder with the owner self-exception (mirrors the JSON endpoint).
  // The PUBLIC-visibility check is evaluated WITHOUT the self bypass so the
  // cache policy stays honest: a PRIVATE owner's self-served artifact is
  // always private,no-store (a shared cache must never hold those bytes).
  const viewer = await getSessionUser();
  const isSelf = viewer?.id === site.user.id;
  const publiclyVisible = isProfilePubliclyVisible(site.user, false);
  if (!publiclyVisible && !isSelf) return notPublished();
  const cacheControl = publiclyVisible ? "public, max-age=60" : "private, no-store";

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
        headers: publicHeaders(file.mime, cacheControl),
      });
    }
    return new NextResponse(file.content, {
      status: 200,
      headers: publicHeaders(file.mime, cacheControl),
    });
  }
  return fileNotFound();
});
