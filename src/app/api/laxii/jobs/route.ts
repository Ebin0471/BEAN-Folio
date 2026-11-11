import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, parseBody, handler, rateLimit } from "@/lib/api-helpers";
import { createJob, listJobs, MAX_VARIATIONS } from "@/lib/laxii/service";
import { LaxiiError } from "@/lib/laxii/types";

export const dynamic = "force-dynamic";

/**
 * LAXII job endpoints. Every route requires an authenticated session; jobs
 * are strictly owner-scoped. Rate limit: 12 jobs / hour / account — real
 * model inference is expensive and this keeps the engine fair.
 */

const createSchema = z.object({
  kind: z.enum(["AVATAR", "BANNER", "BACKGROUND", "UPSCALE", "EDIT"]),
  style: z.string().max(60).optional(),
  instructions: z.string().max(600).optional(),
  variations: z.number().int().min(1).max(MAX_VARIATIONS).optional(),
  sourceAssetId: z.string().trim().min(1).max(100).optional(),
  identityMode: z.enum(["PRESERVE", "AI_GUIDED"]).optional(),
  subject: z
    .object({
      x: z.number().min(0).max(100),
      y: z.number().min(0).max(100),
      w: z.number().min(0).max(100),
      h: z.number().min(0).max(100),
    })
    .optional(),
  size: z
    .object({
      width: z.number().int().min(16).max(4096),
      height: z.number().int().min(16).max(4096),
    })
    .optional(),
  format: z.enum(["PNG", "JPEG", "WEBP"]).optional(),
  quality: z.number().int().min(60).max(100).optional(),
  factor: z.union([z.literal(2), z.literal(4)]).optional(),
  provider: z.enum(["managed", "diffusers", "auto"]).optional(),
});

export const POST = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-create:${user.id}`, 12, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, createSchema);
  if (r.response) return r.response;

  try {
    const job = await createJob(user.id, r.data);
    return ok({ job: serializeJob(job) }, 201);
  } catch (e) {
    if (e instanceof LaxiiError) return err(e.message, 400);
    throw e;
  }
});

export const GET = handler(async (req: NextRequest) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = Number(limitRaw ?? "12");
  const jobs = await listJobs(user.id, Number.isFinite(limit) ? limit : 12);
  return ok({ jobs: jobs.map(serializeJob) });
});

// Job rows are owner-private; the serialized shape parses the JSON columns
// for client convenience. Dates become ISO strings.
function serializeJob(job: {
  id: string;
  kind: string;
  provider: string;
  style: string | null;
  status: string;
  stage: string | null;
  progress: number;
  paramsJson: string;
  resultsJson: string | null;
  error: string | null;
  attempt: number;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: job.id,
    kind: job.kind,
    provider: job.provider,
    style: job.style,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    params: safeParse(job.paramsJson),
    results: safeParse(job.resultsJson ?? "") ?? [],
    error: job.error,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
  };
}

function safeParse(json: string): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
