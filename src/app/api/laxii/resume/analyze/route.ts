import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, rateLimit, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";

import { resumeDataSchema, resumeFactsSchema } from "@/lib/laxii/resume-schema";
import { analyzeReadability, mapJobRequirements, parseJobDescription } from "@/lib/laxii/resume-analysis";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  conversationId: z.string().min(1),
  /** Optional pasted job description for the SEPARATE evidence map. */
  jobDescription: z.string().max(8000).optional(),
});

/**
 * POST /api/laxii/resume/analyze — M33.5-B deterministic reports.
 *
 * Fully deterministic (no AI, no aiGate): the same analysis is reproducible
 * for the same document + JD. Owner-scoped (404 for other users), rate
 * limited. Returns the versioned Document Readability Report and, when a
 * job description is supplied, the Job Requirement Evidence Map — two
 * different questions, never merged into an "ATS score".
 */
export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-resume-analyze:${user.id}`, 20, 60_000)) return ERR.rateLimited();

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const { conversationId, jobDescription } = r.data;

  const row = await db.laxiiResume.findFirst({
    where: { conversationId, userId: user.id },
  });
  if (!row) return ERR.notFound();

  let data;
  try {
    data = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  } catch {
    return err("The saved resume could not be read. Re-generate or re-save it first.", 400);
  }

  // Facts snapshot: tolerant parse (legacy rows) — analysis degrades to the
  // document content when the snapshot predates a schema field.
  const factsParsed = resumeFactsSchema.safeParse(JSON.parse(row.factsJson || "{}"));

  // Report A — Document Readability (the document model the exporters use).
  const readability = analyzeReadability({ data, template: row.template });

  // Report B — Job Requirement Evidence Map (only when a JD is supplied).
  let evidenceMap = null;
  let profile = null;
  if (jobDescription && jobDescription.trim()) {
    profile = parseJobDescription(jobDescription);
    evidenceMap = mapJobRequirements(jobDescription, factsParsed.success ? factsParsed.data : resumeFactsSchema.parse({ basics: { name: data.basics.name || "Candidate" } }), data, profile);
  }

  log.info("laxii.resume.analyze", {
    userId: user.id,
    conversationId,
    readabilityStatus: readability.status,
    checks: readability.checks.length,
    requirements: evidenceMap?.evidence.length ?? 0,
  });

  return ok({
    readability,
    ...(evidenceMap ? { evidenceMap } : {}),
    ...(profile ? { profile } : {}),
  });
});
