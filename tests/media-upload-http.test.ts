/// <reference types="bun-types" />
/**
 * POST /api/media/upload — LIVE HTTP regression suite.
 *
 * Unlike tests/media-upload-route.test.ts (which calls the route handler
 * directly and proves the handler contract), this suite drives REAL HTTP
 * requests against a RUNNING dev server and pins the failure that repeatedly
 * hit BEAN Folio: the static /api/media/upload segment going missing from the
 * working tree (sandbox recycle materialization bug), so the dynamic
 * /api/media/[id] route — which exports no POST — captured the request and
 * every upload in the app died with 405 Method Not Allowed.
 *
 * Wire contract pinned here:
 *   POST  /api/media/upload must NEVER be 405:
 *     - anonymous               → 401 (route exists and is guarded)
 *     - authenticated, no file  → 400
 *     - authenticated, valid PNG→ 200, MediaAsset persisted (READY), raw
 *                                 bytes served back byte-for-byte
 *     - authenticated, garbage  → 400 (UploadError), nothing stored
 *   OPTIONS advertises POST. 405 for genuinely unsupported methods (PUT) on
 *   the dedicated route is CORRECT — the bug was POST itself answering 405.
 *
 * Avatar + cover flows tested independently end-to-end over HTTP:
 *   upload → PATCH /api/me/profile {avatarMediaId|coverMediaId} → value
 *   survives fresh GET requests ("refresh") → raw bytes become publicly
 *   readable (profile imagery is public by definition) → reverted to the
 *   pre-test state, rows + objects removed.
 *
 * Tests run against a DEDICATED QA account (never the demo or real user
 * accounts) and clean up everything they create.
 *
 * Requires a healthy dev server:  ./ensure-dev.sh
 * Run:  bun test tests/media-upload-http.test.ts
 * Env:  BASE_URL (default http://localhost:3000)
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import { createSession, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteObject } from "@/lib/storage";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const QA_EMAIL = "qa-upload-http@beanfolio.test";
const TEST_IP = "198.51.100.90";

/** 1x1 transparent PNG — passes magic-byte sniffing as image/png. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=",
  "base64"
);

let qaUserId = "";
let cookie = "";
let uploadedId = "";

function pngFile(name = "pixel.png"): File {
  const ab = new ArrayBuffer(PNG_BYTES.length);
  new Uint8Array(ab).set(PNG_BYTES);
  return new File([ab], name, { type: "image/png" }) as unknown as File;
}

function garbageFile(): File {
  const bytes = new Uint8Array(256); // all NUL — neither text nor any known magic
  return new File([bytes.buffer], "junk.bin", { type: "application/octet-stream" }) as unknown as File;
}

async function postUpload(file: File | null, withCookie = true) {
  const form = new FormData();
  if (file) form.append("file", file);
  return fetch(`${BASE}/api/media/upload`, {
    method: "POST",
    headers: { ...(withCookie ? { cookie } : {}), "x-forwarded-for": TEST_IP },
    body: form,
  });
}

async function profile(method: "GET" | "PATCH", body?: unknown) {
  return fetch(`${BASE}/api/me/profile`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Remove one media row + its stored object (test-created assets only). */
async function removeMedia(id: string) {
  const row = await db.mediaAsset.findUnique({ where: { id }, select: { id: true, storagePath: true } });
  if (!row) return;
  await db.mediaAsset.delete({ where: { id: row.id } }).catch(() => {});
  await deleteObject(row.storagePath).catch(() => {});
}

beforeAll(async () => {
  const ready = await fetch(`${BASE}/api/ready`)
    .then((r) => r.json() as Promise<{ ok?: boolean }>)
    .catch(() => null);
  if (!ready?.ok) {
    throw new Error(`dev server not healthy at ${BASE} — run ./ensure-dev.sh first`);
  }
  const existing = await db.user.findUnique({ where: { email: QA_EMAIL } });
  const user =
    existing ??
    (await db.user.create({
      data: { email: QA_EMAIL, name: "QA Upload HTTP", passwordHash: await hashPassword("qa-http-password-123") },
    }));
  qaUserId = user.id;
  cookie = `bean_session=${await createSession(qaUserId)}`;
});

afterAll(async () => {
  if (!qaUserId) return;
  // Revert profile references first, then remove test media, sessions, user.
  await db.user
    .update({ where: { id: qaUserId }, data: { avatarMediaId: null, coverMediaId: null } })
    .catch(() => {});
  const media = await db.mediaAsset.findMany({ where: { ownerId: qaUserId }, select: { id: true } });
  for (const m of media) await removeMedia(m.id);
  await db.session.deleteMany({ where: { userId: qaUserId } }).catch(() => {});
  await db.user.delete({ where: { id: qaUserId } }).catch(() => {});
  cookie = "";
  uploadedId = "";
});

describe("POST /api/media/upload — live HTTP boundary (the 405 pin)", () => {
  test("anonymous POST is 401, NOT 405 — the historical regression", async () => {
    const res = await postUpload(pngFile(), false);
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(405);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("OPTIONS advertises POST on the dedicated route", async () => {
    const res = await fetch(`${BASE}/api/media/upload`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect((res.headers.get("allow") ?? "").toUpperCase()).toContain("POST");
  });

  test("PUT on the dedicated route → 405 (correct unsupported-method behavior)", async () => {
    const res = await fetch(`${BASE}/api/media/upload`, { method: "PUT", headers: { cookie } });
    expect(res.status).toBe(405);
    // Next.js 16 answers 405 without an `Allow` header on the method-mismatch
    // path; OPTIONS (tested above) does advertise POST. Status alone is the
    // stable cross-version contract here.
  });

  test("authenticated POST without a `file` part → 400", async () => {
    const res = await postUpload(null);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Missing file|multipart/);
  });

  test("valid PNG → 200 contract, row persisted READY, raw bytes byte-for-byte", async () => {
    const res = await postUpload(pngFile());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      media?: { id: string; kind: string; mime: string; size: number; url: string };
    };
    expect(body.media).toBeDefined();
    expect(body.media!.kind).toBe("IMAGE");
    expect(body.media!.mime).toBe("image/png");
    expect(body.media!.size).toBe(PNG_BYTES.length);
    expect(body.media!.url).toBe(`/api/media/${body.media!.id}/raw`);
    uploadedId = body.media!.id;

    // Row really persisted, owned by the QA session user, READY status.
    const row = await db.mediaAsset.findUnique({ where: { id: uploadedId } });
    expect(row).not.toBeNull();
    expect(row!.ownerId).toBe(qaUserId);
    expect(row!.status).toBe("READY");

    // Owner metadata endpoint still resolves (dynamic [id] route unaffected).
    const meta = await fetch(`${BASE}/api/media/${uploadedId}`, { headers: { cookie } });
    expect(meta.status).toBe(200);

    // Raw URL returns the exact image bytes.
    const raw = await fetch(`${BASE}${body.media!.url}`, { headers: { cookie } });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(bytes.length).toBe(PNG_BYTES.length);
    expect(Buffer.from(bytes).equals(PNG_BYTES)).toBe(true);
  });

  test("unattached raw bytes are owner-only (403 anonymous) until referenced", async () => {
    const res = await fetch(`${BASE}/api/media/${uploadedId}/raw`);
    expect(res.status).toBe(403);
  });

  test("garbage upload → 400 (UploadError), nothing stored", async () => {
    const res = await postUpload(garbageFile());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Unsupported|unrecognized/);
    const rows = await db.mediaAsset.findMany({ where: { ownerId: qaUserId, filename: "junk.bin" } });
    expect(rows.length).toBe(0);
  });

  test("AVATAR flow — upload → link → survives refresh → publicly readable → reverted", async () => {
    const up = await postUpload(pngFile("avatar.png"));
    expect(up.status).toBe(200);
    const { media } = (await up.json()) as { media: { id: string; url: string } };

    const patch = await profile("PATCH", { avatarMediaId: media.id });
    expect(patch.status).toBe(200);
    const linked = (await patch.json()) as { user?: { avatarUrl?: string | null } };
    expect(linked.user?.avatarUrl).toBe(`/api/media/${media.id}/raw`);

    // "Refresh": two independent fresh GETs must both see the reference.
    for (let i = 0; i < 2; i++) {
      const me = await profile("GET");
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user?: { avatarUrl?: string | null } };
      expect(body.user?.avatarUrl).toBe(`/api/media/${media.id}/raw`);
    }

    // Profile imagery is public by definition — anonymous fetch works now.
    const pub = await fetch(`${BASE}${media.url}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");

    // Revert to the pre-test state.
    const revert = await profile("PATCH", { avatarMediaId: null });
    expect(revert.status).toBe(200);
    const after = (await revert.json()) as { user?: { avatarUrl?: string | null } };
    expect(after.user?.avatarUrl).toBeNull();
    await removeMedia(media.id);
  });

  test("COVER flow — upload → link → survives refresh → publicly readable → reverted", async () => {
    const up = await postUpload(pngFile("cover.png"));
    expect(up.status).toBe(200);
    const { media } = (await up.json()) as { media: { id: string; url: string } };

    const patch = await profile("PATCH", { coverMediaId: media.id });
    expect(patch.status).toBe(200);
    const linked = (await patch.json()) as { user?: { coverUrl?: string | null } };
    expect(linked.user?.coverUrl).toBe(`/api/media/${media.id}/raw`);

    // "Refresh": independent fresh GET sees the persisted reference.
    const me = await profile("GET");
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user?: { coverUrl?: string | null } };
    expect(body.user?.coverUrl).toBe(`/api/media/${media.id}/raw`);

    const pub = await fetch(`${BASE}${media.url}`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");

    const revert = await profile("PATCH", { coverMediaId: null });
    expect(revert.status).toBe(200);
    const after = (await revert.json()) as { user?: { coverUrl?: string | null } };
    expect(after.user?.coverUrl).toBeNull();
    await removeMedia(media.id);
  });
});
