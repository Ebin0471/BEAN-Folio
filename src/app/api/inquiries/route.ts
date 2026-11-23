import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { requiresEmailVerification } from "@/lib/identity";
import { handler, ok, err, ERR, parseBody, rateLimit } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import type { InquiryDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    recipientUsername: z.string().trim().min(1).max(40).optional(),
    projectId: z.string().trim().min(1).optional(),
    type: z.enum(["INQUIRY", "COLLABORATION", "INVITE"]),
    subject: z.string().trim().min(1).max(140),
    message: z.string().trim().min(1).max(2000),
  })
  .refine((v) => Boolean(v.recipientUsername || v.projectId), {
    message: "Provide a recipientUsername or a projectId",
    path: ["recipientUsername"],
  });

const inquiryInclude = {
  sender: {
    include: {
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
    },
  },
  recipient: {
    include: {
      professions: { include: { profession: true } },
      skills: { include: { skill: true } },
    },
  },
  project: { select: { id: true, title: true } },
} satisfies Prisma.InquiryInclude;

type InquiryRow = Prisma.InquiryGetPayload<{ include: typeof inquiryInclude }>;

/** Counterparty = the OTHER party from the requester's perspective. */
function toInquiryDTO(row: InquiryRow, meId: string): InquiryDTO {
  const other = row.senderId === meId ? row.recipient : row.sender;
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    project: row.project ? { id: row.project.id, title: row.project.title } : null,
    counterparty: toPublicPerson(other),
  };
}

export const POST = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  // M31 trust gate: identity-aware accounts must verify their email before
  // trust-sensitive actions (external outreach / invitations / candidate
  // contact). Legacy accounts (primaryIdentity = null) and demo fixtures are
  // outside the gate — existing behavior is exactly preserved.
  if (requiresEmailVerification(user)) {
    return err("Verify your email address before performing this action", 403, "EMAIL_VERIFICATION_REQUIRED");
  }

  if (!rateLimit(`inq:${user.id}`, 10, 3_600_000)) return ERR.rateLimited();

  const r = await parseBody(req, bodySchema);
  if (r.response) return r.response;
  const body = r.data;

  // Resolve the recipient: either explicit username, or the owner of the referenced project.
  let recipientId: string | null = null;
  if (body.projectId) {
    const project = await db.project.findUnique({ where: { id: body.projectId } });
    if (!project) return ERR.notFound();
    recipientId = project.ownerId;
  } else if (body.recipientUsername) {
    const recipient = await db.user.findUnique({
      where: { username: body.recipientUsername.toLowerCase() },
    });
    if (!recipient || recipient.deletedAt) return ERR.notFound();
    recipientId = recipient.id;
  }
  if (!recipientId) return ERR.notFound();

  if (recipientId === user.id) {
    return err("You cannot send an inquiry to yourself", 400);
  }

  // Blocked in either direction → refuse.
  const block = await db.block.findFirst({
    where: {
      OR: [
        { blockerId: user.id, blockedId: recipientId },
        { blockerId: recipientId, blockedId: user.id },
      ],
    },
  });
  if (block) return ERR.forbidden();

  const created = await db.inquiry.create({
    data: {
      senderId: user.id,
      recipientId,
      projectId: body.projectId ?? null,
      type: body.type,
      subject: body.subject,
      message: body.message,
    },
  });

  const recipient = await db.user.findUnique({ where: { id: recipientId } });
  if (recipient) {
    await db.notification.create({
      data: {
        userId: recipient.id,
        type: "INQUIRY",
        payload: JSON.stringify({
          actor: user.name,
          actorUsername: user.username ?? "",
          subject: body.subject,
          inquiryType: body.type,
        }),
      },
    });
  }

  const row = await db.inquiry.findUnique({ where: { id: created.id }, include: inquiryInclude });
  if (!row) return ERR.server();
  return ok({ inquiry: toInquiryDTO(row, user.id) }, 200);
});
