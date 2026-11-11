import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, parseBody } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import type { InquiryDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["ACCEPTED", "DECLINED"]),
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

export const PATCH = handler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> => {
    const user = await getSessionUser();
    if (!user) return ERR.unauthorized();

    const { id } = await params;

    const r = await parseBody(req, patchSchema);
    if (r.response) return r.response;

    // Recipient only — anything else is a 404 (no existence leak).
    const inquiry = await db.inquiry.findUnique({ where: { id } });
    if (!inquiry || inquiry.recipientId !== user.id) return ERR.notFound();

    const updated = await db.inquiry.update({
      where: { id },
      data: { status: r.data.status, respondedAt: new Date() },
    });

    await db.notification.create({
      data: {
        userId: inquiry.senderId,
        type: "INQUIRY_RESPONSE",
        payload: JSON.stringify({ actor: user.name, status: r.data.status }),
      },
    });

    const row = await db.inquiry.findUnique({ where: { id: updated.id }, include: inquiryInclude });
    if (!row) return ERR.server();
    return ok({ inquiry: toInquiryDTO(row, user.id) });
  }
);
