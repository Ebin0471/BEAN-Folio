import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { handler, ok, ERR, rateLimit } from "@/lib/api-helpers";
import { fullProjectInclude, toFullProject } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * fullProjectInclude from @/lib/serialize declares
 * `contributors: { orderBy: { createdAt: "asc" } }`, but the Contributor model has
 * no createdAt column — the literal also widens to `string`, breaking
 * ProjectInclude assignability. Override contributors locally (shared-file fix
 * noted in worklog).
 */
const exportProjectInclude = {
  ...fullProjectInclude,
  contributors: true,
} satisfies Prisma.ProjectInclude;

/**
 * POST /api/me/export — create an ExportJob and fill it synchronously with a
 * complete JSON export of the requesting user's OWN data (GDPR-style portability).
 *
 * Rate-limited (5/h per user): the export runs ~11 full-table scans inside the
 * request, so an unthrottled loop would let one account turn this endpoint into
 * a cheap database DoS.
 */
export const POST = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  if (!rateLimit(`me-export:${user.id}`, 5, 60 * 60_000)) {
    return ERR.rateLimited();
  }

  const job = await db.exportJob.create({
    data: { userId: user.id, status: "PENDING" },
  });

  try {
    const [
      professions,
      skills,
      projects,
      collections,
      saves,
      following,
      followers,
      inquiriesSent,
      inquiriesReceived,
      notifications,
      conversations,
    ] = await Promise.all([
      db.profileProfession.findMany({
        where: { userId: user.id },
        include: { profession: true },
      }),
      db.profileSkill.findMany({ where: { userId: user.id }, include: { skill: true } }),
      db.project.findMany({
        where: { ownerId: user.id },
        include: exportProjectInclude,
        orderBy: { createdAt: "desc" },
      }),
      db.collection.findMany({
        where: { ownerId: user.id },
        include: {
          items: { include: { project: { select: { id: true, title: true } } } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.savedProject.findMany({
        where: { userId: user.id },
        include: { project: { select: { id: true, title: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.follow.findMany({
        where: { followerId: user.id },
        include: { following: { select: { username: true, name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.follow.findMany({
        where: { followingId: user.id },
        include: { follower: { select: { username: true, name: true } } },
        orderBy: { createdAt: "desc" },
      }),
      db.inquiry.findMany({
        where: { senderId: user.id },
        include: {
          recipient: { select: { username: true, name: true } },
          project: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.inquiry.findMany({
        where: { recipientId: user.id },
        include: {
          sender: { select: { username: true, name: true } },
          project: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      db.aiConversation.findMany({
        where: { userId: user.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
    ]);

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        headline: user.headline,
        bio: user.bio,
        location: user.location,
        availability: user.availability,
        contactEmail: user.contactEmail,
        websiteUrl: user.websiteUrl,
        avatarUrl: user.avatarMediaId ? `/api/media/${user.avatarMediaId}/raw` : null,
        coverUrl: user.coverMediaId ? `/api/media/${user.coverMediaId}/raw` : null,
        profileVisibility: user.profileVisibility,
        aiConsent: user.aiConsent,
        onboarded: user.onboarded,
        createdAt: user.createdAt.toISOString(),
        // passwordHash intentionally excluded
      },
      profile: {
        professions: professions.map((p) => ({
          slug: p.profession.slug,
          label: p.profession.label,
          group: p.profession.group,
        })),
        skills: skills.map((s) => ({ slug: s.skill.slug, label: s.skill.label })),
      },
      projects: projects.map((p) => toFullProject(p)),
      collections: collections.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        isPublic: c.isPublic,
        createdAt: c.createdAt.toISOString(),
        items: c.items.map((i) => ({
          projectId: i.project.id,
          title: i.project.title,
          addedAt: i.addedAt.toISOString(),
        })),
      })),
      saves: saves.map((s) => ({
        projectId: s.project.id,
        title: s.project.title,
        savedAt: s.createdAt.toISOString(),
      })),
      follows: {
        following: following.map((f) => ({
          username: f.following.username,
          name: f.following.name,
          since: f.createdAt.toISOString(),
        })),
        followers: followers.map((f) => ({
          username: f.follower.username,
          name: f.follower.name,
          since: f.createdAt.toISOString(),
        })),
      },
      inquiries: {
        sent: inquiriesSent.map((i) => ({
          id: i.id,
          type: i.type,
          subject: i.subject,
          message: i.message,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
          to: i.recipient,
          project: i.project,
        })),
        received: inquiriesReceived.map((i) => ({
          id: i.id,
          type: i.type,
          subject: i.subject,
          message: i.message,
          status: i.status,
          createdAt: i.createdAt.toISOString(),
          from: i.sender,
          project: i.project,
        })),
      },
      notifications: notifications.map((n) => {
        let payload: unknown = {};
        try {
          payload = JSON.parse(n.payload);
        } catch {
          payload = {};
        }
        return {
          type: n.type,
          payload,
          readAt: n.readAt ? n.readAt.toISOString() : null,
          createdAt: n.createdAt.toISOString(),
        };
      }),
      ai: {
        conversations: conversations.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt.toISOString(),
          messages: c.messages.map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: m.createdAt.toISOString(),
          })),
        })),
      },
    };

    await db.exportJob.update({
      where: { id: job.id },
      data: {
        status: "READY",
        payload: JSON.stringify(exportPayload),
        completedAt: new Date(),
      },
    });

    await db.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: "data.export",
        targetType: "ExportJob",
        targetId: job.id,
      },
    });

    return ok({ job: { id: job.id, status: "READY" } });
  } catch (e) {
    await db.exportJob
      .update({ where: { id: job.id }, data: { status: "FAILED" } })
      .catch(() => undefined);
    throw e;
  }
});
