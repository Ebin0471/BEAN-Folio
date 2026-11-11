import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

/**
 * P3 — public portfolio performance + safety unit tests.
 *
 *  - getPublicProfileMeta serves ONLY publicly-visible profiles (demo
 *    fixtures and PRIVATE profiles resolve to null → the document emits
 *    noindex generic metadata; drafts can never leak through metadata).
 *  - The media serving route assigns cache classes by AUTHORIZATION REASON:
 *    viewer-independent public references → `public` (CDN-cacheable),
 *    owner-only access → `private` (never stored by a shared cache).
 */

let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { putObject, deleteObject } from "@/lib/storage";
import { getPublicProfileMeta } from "@/lib/public-profile";
import { GET as rawRoute } from "@/app/api/media/[id]/raw/route";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const EMAILS = {
  pub: "qa-p3-public@beanfolio.test",
  priv: "qa-p3-private@beanfolio.test",
  demo: "qa-p3-demo@beanfolio.test",
};
let ids: Record<string, string> = {};
let mediaId = "";

beforeAll(async () => {
  ids.pub = (
    await db.user.create({
      data: {
        email: EMAILS.pub,
        name: "P3 Public",
        username: "qa-p3-public",
        passwordHash: await hashPassword("qa-only-password-123"),
        bio: "Public portfolio for metadata tests.",
        profileVisibility: "PUBLIC",
      },
    })
  ).id;
  ids.priv = (
    await db.user.create({
      data: {
        email: EMAILS.priv,
        name: "P3 Private",
        username: "qa-p3-private",
        passwordHash: await hashPassword("qa-only-password-123"),
        profileVisibility: "PRIVATE",
      },
    })
  ).id;
  ids.demo = (
    await db.user.create({
      data: {
        email: EMAILS.demo,
        name: "P3 Demo",
        username: "qa-p3-demo",
        passwordHash: await hashPassword("qa-only-password-123"),
        isDemo: true,
      },
    })
  ).id;
});

afterAll(async () => {
  for (const id of Object.values(ids)) {
    await db.session.deleteMany({ where: { userId: id } }).catch(() => {});
    await db.user.delete({ where: { id } }).catch(() => {});
  }
  if (mediaId) {
    const row = await db.mediaAsset.findUnique({ where: { id: mediaId } });
    if (row) {
      await db.mediaAsset.delete({ where: { id: mediaId } }).catch(() => {});
      await deleteObject(row.storagePath).catch(() => {});
    }
  }
});

describe("P3 — getPublicProfileMeta visibility ladder", () => {
  test("PUBLIC profile → real metadata (name, headline, bio)", async () => {
    const meta = await getPublicProfileMeta("qa-p3-public");
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe("P3 Public");
    expect(meta?.bio).toBe("Public portfolio for metadata tests.");
    expect(meta?.username).toBe("qa-p3-public");
  });

  test("PRIVATE profile → null (never leaks through metadata)", async () => {
    const meta = await getPublicProfileMeta("qa-p3-private");
    expect(meta).toBeNull();
  });

  test("demo fixture → null (fixtures never appear publicly)", async () => {
    const meta = await getPublicProfileMeta("qa-p3-demo");
    expect(meta).toBeNull();
  });

  test("unknown username → null", async () => {
    expect(await getPublicProfileMeta("no-such-user-xyz")).toBeNull();
  });
});

describe("P3 — media cache classes (public vs private)", () => {
  test("avatar-referenced asset → public cache-control; unattached → private", async () => {
    const storagePath = `uploads/${ids.pub}/qa-p3-test.png`;
    await putObject(storagePath, PNG, "image/png");
    mediaId = (
      await db.mediaAsset.create({
        data: {
          ownerId: ids.pub,
          kind: "IMAGE",
          filename: "qa-p3.png",
          mime: "image/png",
          size: PNG.length,
          status: "READY",
          storagePath,
        },
      })
    ).id;

    const callRaw = async (id: string) => {
      const req = new NextRequest(`http://localhost:3000/api/media/${id}/raw`);
      return rawRoute(req as never, { params: Promise.resolve({ id }) } as never);
    };

    // Unattached: owner-only → private caching.
    cookieToken = await createSession(ids.pub);
    const ownerRes = await callRaw(mediaId);
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get("cache-control")).toBe("private, max-age=3600");

    // Avatar reference: viewer-independent public imagery → public caching.
    await db.user.update({ where: { id: ids.pub }, data: { avatarMediaId: mediaId } });
    cookieToken = undefined;
    const anonRes = await callRaw(mediaId);
    expect(anonRes.status).toBe(200);
    expect(anonRes.headers.get("cache-control")).toContain("public");

    await db.user.update({ where: { id: ids.pub }, data: { avatarMediaId: null } });
  });
});
