import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR } from "@/lib/api-helpers";
import { toPublicPerson } from "@/lib/serialize";
import type { InquiryDTO } from "@/lib/types";

export const dynamic = "force-dynamic";

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

export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();

  const [incomingRows, outgoingRows] = await Promise.all([
    db.inquiry.findMany({
      where: { recipientId: user.id },
      include: inquiryInclude,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    db.inquiry.findMany({
      where: { senderId: user.id },
      include: inquiryInclude,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return ok({
    incoming: incomingRows.map((row) => toInquiryDTO(row, user.id)),
    outgoing: outgoingRows.map((row) => toInquiryDTO(row, user.id)),
  });
});
