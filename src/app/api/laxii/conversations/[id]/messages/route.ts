import { NextRequest } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { ok, err, ERR, handler, rateLimit, parseBody } from "@/lib/api-helpers";
import { sendMessage } from "@/lib/laxii/conversations";
import { LaxiiError } from "@/lib/laxii/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/laxii/conversations/:id/messages — send a conversational turn.
 *
 * The server plans the operation (explicit or AUTO-inferred), persists the
 * USER + ASSISTANT messages, and starts the real engine job through the
 * EXISTING pipeline (validation, ownership, rate limits, retries). The
 * response returns both messages; the client polls the assistant message.
 *
 * Rate limit: 20 turns / hour / account on top of the per-job engine limits
 * — real model inference (local GPU or PAID external APIs) is never free.
 */

const bodySchema = z.object({
  text: z.string().max(2000).default(""),
  operation: z
    .enum(["AUTO", "GENERATE", "EDIT", "VARIATIONS", "REMOVE_BG", "OUTPAINT", "UPSCALE", "BANNER"])
    .optional(),
  refAssetIds: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
  parentAssetId: z.string().trim().min(1).max(100).optional(),
  settings: z
    .object({
      provider: z.enum(["managed", "diffusers", "gemini", "openai", "auto"]).optional(),
      model: z.string().max(80).optional(),
      aspect: z.string().max(10).optional(),
      variations: z.number().int().min(1).max(4).optional(),
      format: z.enum(["PNG", "JPEG", "WEBP"]).optional(),
      bannerPreset: z.string().max(40).optional(),
      bannerWidth: z.number().int().min(16).max(4096).optional(),
      bannerHeight: z.number().int().min(16).max(4096).optional(),
      bannerStyle: z.string().max(60).optional(),
      upscaleFactor: z.union([z.literal(2), z.literal(4)]).optional(),
    })
    .optional(),
});

export const POST = handler(async (req: NextRequest, { params }: Ctx) => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`laxii-chat:${user.id}`, 20, 3_600_000)) return ERR.rateLimited();
  const { id } = await params;
  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;

  try {
    const result = await sendMessage(user.id, id, r.data);
    return ok(result, 201);
  } catch (e) {
    if (e instanceof LaxiiError) return err(e.message, 400);
    throw e;
  }
});
