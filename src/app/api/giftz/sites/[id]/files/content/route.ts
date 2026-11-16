import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBodySized, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeConfig, type SiteConfig } from "@/lib/site-config";
import { recordGiftzActivity } from "@/lib/giftz/project-activity";
import { snapshotProjectVersion } from "@/lib/giftz/project-versions";
import {
  ProjectFileError,
  assertProjectLimits,
  constrainProjectPath,
  deleteProjectFile,
  listProjectFiles,
  mimeForPath,
  readProjectFile,
  writeProjectFile,
} from "@/lib/giftz/project-files";
import { syncConfigFromSiteConfigFile } from "@/lib/giftz/project-compiler";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const CONFIG_PATH = "site.config.json";

// Body budget: 4MB decoded base64 → ~5.6MB base64 text, plus JSON overhead.
const PUT_BODY_MAX_BYTES = 6_500_000;

const putSchema = z.object({
  path: z.string().max(1000),
  content: z.string().max(6_000_000),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

type PutData = z.infer<typeof putSchema>;

/** Map ProjectFileError to its HTTP status (shared by the three verbs). */
function fileError(e: unknown): NextResponse | null {
  if (e instanceof ProjectFileError) return err(e.message, e.status);
  return null;
}

function serializeFile(r: {
  path: string;
  content?: string;
  encoding: string;
  source: string;
  sizeBytes?: number;
  updatedAt: Date;
}) {
  return {
    path: r.path,
    ...(r.content !== undefined ? { content: r.content } : {}),
    encoding: r.encoding,
    source: r.source,
    mime: mimeForPath(r.path),
    sizeBytes: r.sizeBytes,
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function loadOwnedSite(id: string, userId: string) {
  return db.giftzSite.findFirst({ where: { id, userId }, select: { id: true, userId: true } });
}

/**
 * GET /api/giftz/sites/[id]/files/content?path=<rel>[&raw=1]
 * One file's content. Binary (base64) rows respond 415 WITHOUT the content
 * unless `?raw=1` is passed (returns the base64 text) — editors get an
 * explicit binary notice instead of megabytes of encoded text.
 */
export const GET = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await loadOwnedSite(id, user.id);
  if (!site) return ERR.notFound();

  let path: string;
  try {
    path = constrainProjectPath(req.nextUrl.searchParams.get("path"));
  } catch (e) {
    return fileError(e) ?? ERR.notFound();
  }
  const row = await readProjectFile(id, path);
  if (!row) return ERR.notFound();

  const mime = mimeForPath(path);
  const raw = req.nextUrl.searchParams.get("raw") === "1";
  if (row.encoding === "base64" && !raw) {
    return NextResponse.json(
      {
        file: {
          path: row.path,
          encoding: "base64",
          source: row.source,
          mime,
          sizeBytes: row.sizeBytes,
          updatedAt: row.updatedAt.toISOString(),
        },
        binary: true,
      },
      { status: 415 }
    );
  }

  return ok({ file: serializeFile(row) });
});

/**
 * PUT /api/giftz/sites/[id]/files/content — write one file with source
 * "user" (the code editor's save). S2: writing `site.config.json` FIRST
 * validates it against the SiteConfig schema + media guard; an invalid
 * config is a 422 and NOTHING is written. Successful writes snapshot a
 * project version and record activity; rate-limited per account.
 */
export const PUT = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-file:${user.id}`, 120, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const site = await loadOwnedSite(id, user.id);
  if (!site) return ERR.notFound();

  const r = await parseBodySized(req, putSchema, PUT_BODY_MAX_BYTES);
  if (r.response) return r.response;
  const data: PutData = r.data;

  let path: string;
  try {
    path = constrainProjectPath(data.path);
  } catch (e) {
    return fileError(e) ?? err("Invalid file path", 400);
  }

  const encoding = data.encoding ?? "utf8";

  // --- S2: the content-model bridge file goes through config validation first
  if (path === CONFIG_PATH) {
    if (encoding === "base64") {
      return err("site.config.json is a text file — write it as utf8 text.", 400);
    }
    try {
      assertProjectLimits(await listProjectFiles(id), { path, content: data.content, encoding: "utf8" });
    } catch (e) {
      return fileError(e) ?? err("File rejected", 413);
    }
    const sync = await syncConfigFromSiteConfigFile(id, user.id, data.content);
    if (!sync.ok) {
      return err(sync.error, 422);
    }
    const row = await writeProjectFile(id, path, data.content, "utf8", "user");
    await snapshotProjectVersion(id, user.id, `Save ${path}`, "user");
    await recordGiftzActivity(id, user.id, "file.write", {
      path,
      sizeBytes: row.sizeBytes,
      configSynced: true,
    });
    const config: SiteConfig | null = normalizeConfig(data.content);
    return ok({ file: serializeFile(row), configSynced: true, config });
  }

  // --- regular file write with project limits enforced
  const existing = await listProjectFiles(id);
  try {
    assertProjectLimits(existing, { path, content: data.content, encoding });
  } catch (e) {
    return fileError(e) ?? err("File rejected", 413);
  }

  const before = existing.find((f) => f.path === path) ?? null;
  const changed =
    !before || before.content !== data.content || before.encoding !== encoding;
  const row = await writeProjectFile(id, path, data.content, encoding, "user");

  if (changed) {
    await snapshotProjectVersion(id, user.id, `Save ${path}`, "user");
  }
  await recordGiftzActivity(id, user.id, "file.write", {
    path,
    sizeBytes: row.sizeBytes,
    encoding,
    changed,
  });

  return ok({ file: serializeFile(row), configSynced: false });
});

/**
 * DELETE /api/giftz/sites/[id]/files/content?path=<rel> — remove one file.
 * The content-model bridge (site.config.json) cannot be deleted here — it is
 * regenerated from the config on every save; edit it or discard changes
 * instead.
 */
export const DELETE = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await loadOwnedSite(id, user.id);
  if (!site) return ERR.notFound();

  let path: string;
  try {
    path = constrainProjectPath(req.nextUrl.searchParams.get("path"));
  } catch (e) {
    return fileError(e) ?? ERR.notFound();
  }
  if (path === CONFIG_PATH) {
    return err(
      "site.config.json is the content-model bridge and cannot be deleted — edit it in the code editor or save from the visual editor instead.",
      400
    );
  }

  const deleted = await deleteProjectFile(id, path);
  if (!deleted) return ERR.notFound();

  await recordGiftzActivity(id, user.id, "file.delete", { path });
  return ok({ deleted: true });
});
