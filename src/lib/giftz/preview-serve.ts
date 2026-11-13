/**
 * GIFTZ preview serving (contract §5.1) — shared by the catch-all preview
 * route and the root (directory-style) preview route.
 *
 * Security model:
 * - OWNER-ONLY: both callers must resolve an authenticated session user and
 *   an owner-scoped site row BEFORE calling `servePreviewFile` — this module
 *   never re-checks auth (it cannot: it receives resolved ids only).
 * - Sandboxed rendering: responses carry a strict CSP (`connect-src 'none'`,
 *   `default-src 'none'`) so previewed code can render and inline-interact
 *   but CANNOT fetch from the network, plus `Cache-Control: no-store` (the
 *   working tree changes constantly) and `X-Content-Type-Options: nosniff`.
 * - Proposal overlay: when `?proposalMessageId` names a SiteStudioMessage
 *   whose session belongs to the user AND targets this site, its kind-"files"
 *   proposal is applied on top of the working tree for THIS REQUEST ONLY —
 *   nothing is persisted. Invalid/foreign message ids are an honest 404.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { constrainProjectPath, isTextMime, mimeForPath, readProjectFile } from "./project-files";

export const PREVIEW_CSP =
  "default-src 'none'; img-src * data: blob:; style-src * data: 'unsafe-inline'; font-src * data:; script-src * data: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors *";

/** Plain-text 404 (never a JSON error page — the iframe renders it raw). */
export function previewNotFound(): NextResponse {
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

/**
 * Resolve the proposal overlay for THIS request: path → replacement utf8
 * content, or null (file removed by the proposal). Returns null when no
 * messageId is given or the proposal is not a files proposal; "invalid" when
 * the message does not exist or does not belong to this user + site.
 */
export async function loadProposalOverlay(
  userId: string,
  siteId: string,
  messageId: string | null
): Promise<Map<string, string | null> | null | "invalid"> {
  if (!messageId) return null;
  const message = await db.siteStudioMessage.findUnique({
    where: { id: messageId },
    include: { session: { select: { userId: true, targetSiteId: true } } },
  });
  if (!message || message.session.userId !== userId || message.session.targetSiteId !== siteId) {
    return "invalid";
  }
  let proposal: unknown = null;
  try {
    proposal = message.proposalJson ? JSON.parse(message.proposalJson) : null;
  } catch {
    return null;
  }
  if (!proposal || typeof proposal !== "object") return null;
  const kind = (proposal as { kind?: unknown }).kind;
  if (kind !== "files") return null;
  const changes = (proposal as { fileChanges?: unknown }).fileChanges;
  if (!Array.isArray(changes)) return null;

  const overlay = new Map<string, string | null>();
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const c = change as { path?: unknown; action?: unknown; content?: unknown; encoding?: unknown };
    if (typeof c.path !== "string") continue;
    let path: string;
    try {
      path = constrainProjectPath(c.path);
    } catch {
      continue; // unsafe proposal paths are skipped, never served
    }
    if (c.action === "removed") {
      overlay.set(path, null);
      continue;
    }
    if ((c.action === "added" || c.action === "modified") && typeof c.content === "string" && c.encoding !== "base64") {
      overlay.set(path, c.content);
    }
  }
  return overlay;
}

function textResponse(content: string, mime: string): NextResponse {
  const contentType = isTextMime(mime) ? `${mime}; charset=utf-8` : mime;
  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function binaryResponse(bytes: Buffer, mime: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": "no-store",
      "Content-Security-Policy": PREVIEW_CSP,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Serve one file from the working tree (plus the proposal overlay).
 * Directory-style requests (empty path or trailing slash) resolve to that
 * directory's index.html; an extensionless path also falls back to
 * `<path>/index.html` when the raw path itself is not a file.
 */
export async function servePreviewFile(
  siteId: string,
  rawPath: string,
  overlay: Map<string, string | null> | null
): Promise<NextResponse> {
  let path = rawPath;
  if (path === "" || path.endsWith("/")) path = `${path}index.html`;
  path = path.replace(/^\/+/, "");

  const tryCandidates: string[] = [];
  try {
    tryCandidates.push(constrainProjectPath(path));
  } catch {
    return previewNotFound();
  }
  // Extensionless LAST segment → also try the directory's index.html
  // (covers directory-style requests after trailing-slash normalization).
  const lastSegment = tryCandidates[0].split("/").pop() ?? "";
  if (!lastSegment.includes(".")) {
    try {
      tryCandidates.push(constrainProjectPath(`${path}/index.html`));
    } catch {
      // fall through with the single candidate
    }
  }

  for (const candidate of tryCandidates) {
    // Proposal deletions hide the file even if the working tree still has it.
    if (overlay?.get(candidate) === null) return previewNotFound();

    const overlayContent = overlay?.get(candidate);
    if (typeof overlayContent === "string") {
      return textResponse(overlayContent, mimeForPath(candidate));
    }

    const row = await readProjectFile(siteId, candidate);
    if (!row) continue;
    if (row.encoding === "base64") {
      return binaryResponse(Buffer.from(row.content, "base64"), mimeForPath(candidate));
    }
    return textResponse(row.content, mimeForPath(candidate));
  }
  return previewNotFound();
}
