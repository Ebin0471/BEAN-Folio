import { NextRequest } from "next/server";
import { z } from "zod";

import { handler, ok, ERR, parseBody, rateLimitShared } from "@/lib/api-helpers";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { runProjectBuild, serializeBuild } from "@/lib/giftz/project-build";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const postSchema = z.object({
  // "publish" is reserved for the publish pipeline; ad-hoc builds are manual or AI-triggered.
  trigger: z.enum(["manual", "ai"]).optional(),
});

/**
 * GET /api/giftz/sites/[id]/builds — newest 20 builds of this project with
 * their honest summaries (no fabricated success: FAILED rows carry their
 * diagnostics through /builds/[buildId]).
 */
export const GET = handler(async (_req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!site) return ERR.notFound();

  const builds = await db.giftzBuild.findMany({
    where: { siteId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return ok({ builds: builds.map(serializeBuild) });
});

/**
 * POST /api/giftz/sites/[id]/builds — run a synchronous in-process build of
 * the project file tree and return the FULL result including diagnostics.
 * Rate-limited per account; builds are deterministic and AI-free.
 */
export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limited = await rateLimitShared(`giftz-build:${user.id}`, 20, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const site = await db.giftzSite.findFirst({ where: { id, userId: user.id } });
  if (!site) return ERR.notFound();

  const r = await parseBody(req, postSchema);
  if (r.response) return r.response;

  const build = await runProjectBuild(site, r.data.trigger ?? "manual");
  return ok({ build: serializeBuild(build) });
});
