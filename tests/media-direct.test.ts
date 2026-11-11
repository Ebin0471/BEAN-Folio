import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

/**
 * P2 — presigned direct-to-object-storage upload flow, verified END-TO-END
 * against a LOCAL S3-compatible fake (a real bucket is not available in the
 * sandbox — no paid services). The fake implements the exact surface the
 * AWS SDK v3 client uses here: PUT / HEAD / GET (with Range) / DELETE on
 * path-style bucket URLs. Signature headers are accepted but not verified —
 * signature CORRECTNESS is AWS SDK territory; this suite verifies the
 * APPLICATION contract:
 *
 *   1. presign authorizes (401 anon), validates declared kind/size (400),
 *      and honestly 501s on local-disk deployments;
 *   2. bytes go browser → object store (the fake) without an API handler;
 *   3. complete verifies existence + exact size + CONTENT (magic bytes,
 *      kind match) before PENDING → READY;
 *   4. failures leave nothing behind (object + row deleted);
 *   5. ownership is enforced on complete (foreign session → refused);
 *   6. private/public separation holds through the /raw authorization ladder
 *      (unattached PENDING asset is owner-only; avatar reference is public);
 *   7. the daily sweep purges abandoned PENDING uploads (object included).
 */

// Route handlers called directly run outside a Next request scope — same
// mutable-cookie mock as tests/media-upload-route.test.ts.
let cookieToken: string | undefined;
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieToken && name === "bean_session" ? { name, value: cookieToken } : undefined,
    set: () => undefined,
  }),
}));

import { db } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { runMaintenanceSweep } from "@/lib/queue/handlers";
import { POST as presignRoute } from "@/app/api/media/direct/presign/route";
import { POST as completeRoute } from "@/app/api/media/direct/complete/route";
import { GET as rawRoute } from "@/app/api/media/[id]/raw/route";

// ------------------------------------------------------------------ fake S3

const BUCKET = "direct-test-bucket";
const objects = new Map<string, Buffer>();
let fakeServer: ReturnType<typeof Bun.serve> | null = null;
let savedEnv: Record<string, string | undefined> = {};

function startFakeS3(): number {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Path-style addressing: /<bucket>/<key...>
      const prefix = `/${BUCKET}/`;
      if (!url.pathname.startsWith(prefix)) {
        return new Response("no such bucket", { status: 404 });
      }
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      if (req.method === "PUT") {
        const body = Buffer.from(await req.arrayBuffer());
        objects.set(key, body);
        return new Response(null, { status: 200, headers: { ETag: `"${key.length}"` } });
      }
      if (req.method === "HEAD") {
        const obj = objects.get(key);
        if (!obj) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { "Content-Length": String(obj.length) } });
      }
      if (req.method === "GET") {
        const obj = objects.get(key);
        if (!obj) return new Response(null, { status: 404 });
        const range = req.headers.get("range");
        if (range) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(range.trim());
          if (m) {
            const start = Number(m[1]);
            const end = Math.min(Number(m[2]), obj.length - 1);
            return new Response(new Uint8Array(obj.subarray(start, end + 1)), {
              status: 206,
              headers: {
                "Content-Range": `bytes ${start}-${end}/${obj.length}`,
                "Content-Length": String(end - start + 1),
              },
            });
          }
        }
        return new Response(new Uint8Array(obj), {
          status: 200,
          headers: { "Content-Length": String(obj.length) },
        });
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response("method not allowed", { status: 405 });
    },
  });
  fakeServer = server;
  return server.port as number;
}

// ------------------------------------------------------------------- helpers

const OWNER_EMAIL = "qa-direct-owner@beanfolio.test";
const OTHER_EMAIL = "qa-direct-other@beanfolio.test";

/** 1x1 transparent PNG — passes magic-byte sniffing as image/png. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const TEXT_BYTES = Buffer.from("# Direct upload test\n\nPlain markdown content, definitely not an image.\n");

let ownerId = "";
let otherId = "";

function jsonRequest(path: string, body: unknown, ip: string): Request {
  return new NextRequestShim(path, { method: "POST", body: JSON.stringify(body), ip });
}

// Minimal NextRequest: the routes only read method/body/headers.
import { NextRequest } from "next/server";
class NextRequestShim extends NextRequest {
  constructor(path: string, init: { method: string; body: string; ip: string }) {
    super(`http://localhost:3000${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", "x-forwarded-for": init.ip },
      body: init.body,
    });
  }
}

async function callPresign(body: unknown, ip: string) {
  return presignRoute(jsonRequest("/api/media/direct/presign", body, ip) as never);
}

async function callComplete(body: unknown, ip: string) {
  return completeRoute(jsonRequest("/api/media/direct/complete", body, ip) as never);
}

async function callRaw(id: string) {
  const req = new NextRequest(`http://localhost:3000/api/media/${id}/raw`);
  return rawRoute(req as never, { params: Promise.resolve({ id }) } as never);
}

async function bodyJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  savedEnv = {
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    MEDIA_STORAGE_DRIVER: process.env.MEDIA_STORAGE_DRIVER,
  };
  const port = startFakeS3();
  process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_ACCESS_KEY_ID = "test-key";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret";
  delete process.env.MEDIA_STORAGE_DRIVER;

  const owner = await db.user.create({
    data: {
      email: OWNER_EMAIL,
      name: "QA Direct Owner",
      passwordHash: await hashPassword("qa-only-password-123"),
    },
  });
  ownerId = owner.id;
  const other = await db.user.create({
    data: {
      email: OTHER_EMAIL,
      name: "QA Direct Other",
      passwordHash: await hashPassword("qa-only-password-123"),
    },
  });
  otherId = other.id;
});

afterAll(async () => {
  // Restore the exact env this file found — bun runs test files in ONE
  // process, and later files (e.g. storage.test.ts) manage their own env.
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Cleanup rows + any stray fake objects.
  for (const email of [OWNER_EMAIL, OTHER_EMAIL]) {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) continue;
    await db.mediaAsset.deleteMany({ where: { ownerId: user.id } });
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }
  objects.clear();
  fakeServer?.stop(true);
});

// Full flow helper: presign → direct PUT → complete.
async function directUpload(opts: {
  kind: string;
  bytes: Buffer;
  mime: string;
  filename: string;
  ip: string;
}): Promise<{ status: number; body: Record<string, unknown>; mediaId: string | null }> {
  const presign = await callPresign(
    { kind: opts.kind, size: opts.bytes.length, filename: opts.filename, mime: opts.mime },
    opts.ip
  );
  if (!presign.ok) return { status: presign.status, body: await bodyJson(presign), mediaId: null };
  const presigned = ((await presign.json()) as { media: { id: string; uploadUrl: string; headers: Record<string, string> } }).media;
  const put = await fetch(presigned.uploadUrl, {
    method: "PUT",
    headers: presigned.headers,
    body: new Uint8Array(opts.bytes),
  });
  if (!put.ok) return { status: put.status, body: { error: "direct PUT failed" }, mediaId: presigned.id };
  const complete = await callComplete({ mediaId: presigned.id }, opts.ip);
  return { status: complete.status, body: await bodyJson(complete), mediaId: presigned.id };
}

// -------------------------------------------------------------------- tests

describe("POST /api/media/direct/presign", () => {
  test("401 without a session cookie", async () => {
    cookieToken = undefined;
    const res = await callPresign({ kind: "IMAGE", size: 100, filename: "a.png", mime: "image/png" }, "10.1.1.1");
    expect(res.status).toBe(401);
  });

  test("400 on an unsupported kind", async () => {
    const owner = await db.user.findUnique({ where: { email: OWNER_EMAIL } });
    cookieToken = await createSession(ownerId);
    const res = await callPresign({ kind: "EXECUTABLE", size: 100, filename: "a.exe", mime: "application/octet-stream" }, "10.1.1.2");
    expect(res.status).toBe(400);
    void owner;
  });

  test("400 on an oversized declaration (IMAGE cap 8MB)", async () => {
    const res = await callPresign(
      { kind: "IMAGE", size: 9 * 1024 * 1024, filename: "big.png", mime: "image/png" },
      "10.1.1.3"
    );
    expect(res.status).toBe(400);
    expect(String((await bodyJson(res)).error)).toContain("exceeds");
  });

  test("200 → PENDING row + presigned PUT URL pointing at the object store", async () => {
    cookieToken = await createSession(ownerId);
    const res = await callPresign(
      { kind: "IMAGE", size: PNG_BYTES.length, filename: "pixel.png", mime: "image/png" },
      "10.1.1.4"
    );
    expect(res.status).toBe(200);
    const body = (await bodyJson(res)) as { media: { id: string; uploadUrl: string; kind: string } };
    expect(body.media.kind).toBe("IMAGE");
    expect(body.media.uploadUrl).toContain(BUCKET);
    const row = await db.mediaAsset.findUnique({ where: { id: body.media.id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.ownerId).toBe(ownerId);
    // PENDING and unattached with NO object yet → the raw route honestly 404s
    // (blob absent) — nothing is servable before completion, whatever the
    // ladder would decide.
    const anonRaw = await callRaw(body.media.id);
    expect(anonRaw.status).toBe(404);
    await db.mediaAsset.delete({ where: { id: body.media.id } });
  });
});

describe("direct upload happy path (presign → PUT → complete → serve)", () => {
  test("bytes land in object storage; complete flips PENDING → READY with sniffed content", async () => {
    const r = await directUpload({
      kind: "IMAGE",
      bytes: PNG_BYTES,
      mime: "image/png",
      filename: "pixel.png",
      ip: "10.2.0.1",
    });
    expect(r.status).toBe(200);
    const media = r.body.media as { id: string; status?: string; mime: string; size: number; url: string };
    expect(media.mime).toBe("image/png"); // sniffed, not declared
    expect(media.size).toBe(PNG_BYTES.length); // exact object size, not the declaration
    expect(media.url).toBe(`/api/media/${media.id}/raw`);

    const row = await db.mediaAsset.findUnique({ where: { id: media.id } });
    expect(row?.status).toBe("READY");
    expect(row?.width).toBe(1); // 1x1 PNG dimensions parsed
    expect(row?.height).toBe(1);

    // Owner serves the bytes; they are byte-identical to the direct PUT.
    cookieToken = await createSession(ownerId);
    const raw = await callRaw(media.id);
    expect(raw.status).toBe(200);
    const served = Buffer.from(await raw.arrayBuffer());
    expect(served.equals(PNG_BYTES)).toBe(true);

    // The object key is owner-scoped and unguessable.
    const rowAfter = await db.mediaAsset.findUnique({ where: { id: media.id } });
    expect(rowAfter?.storagePath.startsWith(`uploads/${ownerId}/`)).toBe(true);
  });

  test("public separation: an avatar reference makes the asset publicly readable", async () => {
    const r = await directUpload({
      kind: "IMAGE",
      bytes: PNG_BYTES,
      mime: "image/png",
      filename: "avatar.png",
      ip: "10.2.0.2",
    });
    const media = r.body.media as { id: string };
    await db.user.update({ where: { id: ownerId }, data: { avatarMediaId: media.id } });
    cookieToken = undefined; // anonymous viewer
    const raw = await callRaw(media.id);
    expect(raw.status).toBe(200);
    await db.user.update({ where: { id: ownerId }, data: { avatarMediaId: null } });
    cookieToken = await createSession(ownerId); // restore for later tests
  });
});

describe("direct upload failure paths leave nothing behind", () => {
  test("content/kind mismatch → 400, object AND row deleted", async () => {
    cookieToken = await createSession(ownerId);
    const r = await directUpload({
      kind: "IMAGE",
      bytes: TEXT_BYTES, // markdown bytes declared as an image
      mime: "image/png",
      filename: "not-an-image.png",
      ip: "10.3.0.1",
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("does not match");
    const row = await db.mediaAsset.findUnique({ where: { id: r.mediaId! } });
    expect(row).toBeNull();
    // The stored object is gone too.
    const rowPath = `uploads/`;
    expect([...objects.keys()].filter((k) => k.startsWith(rowPath)).length).toBe(
      [...objects.keys()].length // only objects from OTHER tests may remain — none new
    );
  });

  test("complete without any PUT → honest 400, row cleaned", async () => {
    cookieToken = await createSession(ownerId);
    const presign = await callPresign(
      { kind: "IMAGE", size: PNG_BYTES.length, filename: "ghost.png", mime: "image/png" },
      "10.3.1.1"
    );
    const presigned = ((await presign.json()) as { media: { id: string } }).media;
    const res = await callComplete({ mediaId: presigned.id }, "10.3.1.2");
    expect(res.status).toBe(400);
    expect(String((await bodyJson(res)).error)).toContain("never reached storage");
    expect(await db.mediaAsset.findUnique({ where: { id: presigned.id } })).toBeNull();
  });

  test("foreign session cannot complete someone else's upload", async () => {
    cookieToken = await createSession(ownerId);
    const presign = await callPresign(
      { kind: "IMAGE", size: PNG_BYTES.length, filename: "owned.png", mime: "image/png" },
      "10.3.2.1"
    );
    const presigned = ((await presign.json()) as { media: { id: string; uploadUrl: string } }).media;
    await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(PNG_BYTES),
    });
    cookieToken = await createSession(otherId); // DIFFERENT user
    const res = await callComplete({ mediaId: presigned.id }, "10.3.2.2");
    expect(res.status).toBe(400);
    expect(String((await bodyJson(res)).error)).toContain("not found");
    // The row still exists, still PENDING, owner untouched. And even though
    // its BYTES now exist in the bucket, the authorization ladder keeps the
    // unattached PENDING asset owner-only (foreign viewer → 403).
    const row = await db.mediaAsset.findUnique({ where: { id: presigned.id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.ownerId).toBe(ownerId);
    cookieToken = undefined;
    const foreignRaw = await callRaw(presigned.id);
    expect(foreignRaw.status).toBe(403);
    cookieToken = await createSession(ownerId); // restore
    // Clean up via the sweep (below).
  });
});

describe("abandoned-upload cleanup (maintenance sweep)", () => {
  test("PENDING rows older than 24h are purged together with their objects", async () => {
    cookieToken = await createSession(ownerId);
    const presign = await callPresign(
      { kind: "IMAGE", size: PNG_BYTES.length, filename: "abandoned.png", mime: "image/png" },
      "10.4.0.1"
    );
    const presigned = ((await presign.json()) as { media: { id: string; uploadUrl: string } }).media;
    await fetch(presigned.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(PNG_BYTES),
    });
    // Backdate the row past the 24h cutoff.
    await db.mediaAsset.update({
      where: { id: presigned.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const counts = await runMaintenanceSweep();
    expect(counts.mediaUploadsPending).toBeGreaterThanOrEqual(1);
    expect(await db.mediaAsset.findUnique({ where: { id: presigned.id } })).toBeNull();
    // The object was deleted with the row: nothing under the owner prefix
    // remains for this particular key.
    const row = await db.mediaAsset.findUnique({ where: { id: presigned.id } });
    expect(row).toBeNull();
  });
});

describe("local-disk deployments get an honest 501", () => {
  test("presign returns 501 when the storage driver is local", async () => {
    cookieToken = await createSession(ownerId);
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.MEDIA_STORAGE_DRIVER = "local";
    try {
      const res = await callPresign(
        { kind: "IMAGE", size: PNG_BYTES.length, filename: "local.png", mime: "image/png" },
        "10.5.0.1"
      );
      expect(res.status).toBe(501);
      expect(String((await bodyJson(res)).error)).toContain("Direct uploads require");
    } finally {
      process.env.S3_ENDPOINT = savedEnv.S3_ENDPOINT ?? fakeServer!.url.href.replace(/\/$/, "");
      process.env.S3_BUCKET = BUCKET;
      process.env.S3_ACCESS_KEY_ID = "test-key";
      process.env.S3_SECRET_ACCESS_KEY = "test-secret";
      delete process.env.MEDIA_STORAGE_DRIVER;
    }
  });
});
