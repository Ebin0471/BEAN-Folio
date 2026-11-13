import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordGiftzActivity } from "@/lib/giftz/project-activity";
import { ProjectFileError, constrainProjectPath, mimeForPath, readProjectFile } from "@/lib/giftz/project-files";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const renameSchema = z.object({
  from: z.string().max(1000),
  to: z.string().max(1000),
});

/**
 * POST /api/giftz/sites/[id]/files/rename — move one file to a new path.
 * The file's content, encoding and `source` badge are preserved exactly;
 * refuses when the target path already exists (409). The content-model
 * bridge (site.config.json) cannot be moved away — it is regenerated from
 * the saved config and lives at a fixed path.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const r = await parseBody(req, renameSchema);
  if (r.response) return r.response;

  let from: string;
  let to: string;
  try {
    from = constrainProjectPath(r.data.from);
    to = constrainProjectPath(r.data.to);
  } catch (e) {
    if (e instanceof ProjectFileError) return err(e.message, e.status);
    return err("Invalid file path", 400);
  }

  if (from === to) {
    return err("The new path is the same as the current one.", 400);
  }
  if (from === "site.config.json") {
    return err(
      "site.config.json is the content-model bridge and cannot be renamed — edit it in the code editor instead.",
      400
    );
  }

  const row = await readProjectFile(id, from);
  if (!row) return ERR.notFound();
  const target = await readProjectFile(id, to);
  if (target) {
    return err(`A file already exists at '${to}'.`, 409);
  }

  const moved = await db.$transaction([
    db.giftzProjectFile.update({
      where: { id: row.id },
      data: { path: to, updatedAt: new Date() },
    }),
  ]);

  await recordGiftzActivity(id, user.id, "file.write", { rename: { from, to } });

  return ok({
    file: {
      path: moved[0].path,
      content: moved[0].content,
      encoding: moved[0].encoding,
      source: moved[0].source,
      mime: mimeForPath(moved[0].path),
      sizeBytes: moved[0].sizeBytes,
      updatedAt: moved[0].updatedAt.toISOString(),
    },
  });
});
