/// <reference types="bun-types" />
/**
 * Media upload boundary — regression tests for the text-sniffing path.
 *
 * The original bug: saveUpload sniffed only the FIRST 16 bytes of the file
 * with a strict UTF-8 decoder. A text file whose first 16 bytes split a
 * multi-byte character (e.g. "# Jordan Reyes —" where the em-dash starts at
 * byte 16) failed the head decode and was rejected as "Unsupported or
 * unrecognized file type" — legitimate résumés/documents were refused. The
 * fix re-sniffs a larger (4KB) sample for the text path; binary formats all
 * have magic signatures that fit in the head, so the safety property is kept
 * (NUL bytes and invalid UTF-8 are still rejected on the sample AND on the
 * full buffer later in the pipeline).
 *
 * The tests attach uploads to the REAL demo account (MediaAsset.ownerId has a
 * FK to User) and DELETE the rows + stored objects in finally blocks — the
 * account's own media is selected by exact filename prefix, so nothing else
 * is touched.
 *
 * Run: bun test tests/media-upload.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";

import { saveUpload, sniffMime, sniffTextMime } from "../src/lib/media";
import { hashPassword } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { deleteObject } from "../src/lib/storage";

const QA_EMAIL = "qa-media-lib@beanfolio.test";
let qaUserId: string | null = null;

/**
 * Owner for direct saveUpload calls. Uses the seeded demo account when the
 * database has one; otherwise falls back to a dedicated, self-cleaning QA
 * account so the suite runs on ANY database (recycled sandboxes are not
 * always seeded). Only media created with the MARKER prefix is ever touched.
 */
async function testOwnerId(): Promise<string> {
  const demo = await db.user.findFirst({ where: { email: "demo@beanfolio.app" }, select: { id: true } });
  if (demo) return demo.id;
  const existing = await db.user.findFirst({ where: { email: QA_EMAIL }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.user.create({
    data: { email: QA_EMAIL, name: "QA Media Lib", passwordHash: await hashPassword("qa-media-lib-password-123") },
  });
  qaUserId = created.id;
  return created.id;
}

afterAll(async () => {
  if (!qaUserId) return;
  const rows = await db.mediaAsset.findMany({
    where: { ownerId: qaUserId, filename: { startsWith: MARKER } },
    select: { id: true, storagePath: true },
  });
  for (const r of rows) {
    await db.mediaAsset.delete({ where: { id: r.id } }).catch(() => {});
    await deleteObject(r.storagePath).catch(() => {});
  }
  await db.user.delete({ where: { id: qaUserId } }).catch(() => {});
});

const MARKER = "qa-media-upload-regression";
// (MARKER declared before testOwnerId's closure uses it at runtime)

function fileFrom(buf: Buffer, name: string): File {
  // copy into a standalone ArrayBuffer: Buffer's pooled .buffer is not an
  // ArrayBufferLike<ArrayBuffer> and ts-dom's BlobPart rejects it
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new File([ab], name) as unknown as File;
}

describe("media upload boundary — text sniffing", () => {
  test("16-byte head that splits a UTF-8 character is recognized as an unreliable sniff", () => {
    // "# Jordan Reyes —" = 16 bytes where byte 16 is the em-dash lead byte (0xe2)
    const head = Buffer.from("# Jordan Reyes \u2014", "utf-8").subarray(0, 16);
    expect(head.length).toBe(16);
    expect(head[15]).toBe(0xe2);
    // the strict head decode fails — this is the exact condition that used to
    // reject the whole upload
    let headDecodes = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head);
    } catch {
      headDecodes = false;
    }
    expect(headDecodes).toBe(false);
    expect(sniffTextMime(head)).toBe(false);
    // a 4KB sample of the same content decodes fine → the re-sniff path saves it
    const sample = Buffer.from("# Jordan Reyes \u2014 Motion Designer & Video Editor\n".repeat(120), "utf-8");
    expect(sniffTextMime(sample)).toBe(true);
    // sniffMime on the raw head reports nothing (no magic) — the caller must
    // fall back to the larger text sample instead of rejecting
    expect(sniffMime(head)).toBeNull();
  });

  test("saveUpload accepts a text file whose 16-byte head splits a UTF-8 character", async () => {
    const ownerId = await testOwnerId();
    const body = Buffer.from(
      "# Jordan Reyes \u2014 Motion Designer & Video Editor\n\nExperienced editor with 8 years in brand films and documentaries. Based in London, UK. Open to projects.\n".repeat(
        4
      ),
      "utf-8"
    );
    const name = `${MARKER}-utf8-split.md`;
    let storagePath: string | null = null;
    try {
      const media = await saveUpload(fileFrom(body, name), ownerId);
      storagePath = media.storagePath;
      expect(media.kind).toBe("DOCUMENT");
      expect(media.mime).toBe("text/markdown");
      expect(media.size).toBe(body.length);
    } finally {
      const rows = await db.mediaAsset.findMany({ where: { ownerId, filename: { startsWith: MARKER } }, select: { id: true, storagePath: true } });
      for (const r of rows) {
        await db.mediaAsset.delete({ where: { id: r.id } }).catch(() => {});
        await deleteObject(r.storagePath).catch(() => {});
      }
    }
  });

  test("saveUpload rejects binary garbage whose head merely looks like text", async () => {
    const ownerId = await testOwnerId();
    // no magic signature in the head, ASCII start, but NUL bytes deeper in the
    // file — the full-buffer text check must refuse it
    const body = Buffer.alloc(2048);
    body.write("looks harmless so far", 0, "ascii");
    body[1500] = 0x00; // NUL → not text
    await expect(saveUpload(fileFrom(body, `${MARKER}-garbage.dat`), ownerId)).rejects.toThrow(
      /Unsupported|unrecognized/
    );
    // nothing may have been stored under the marker
    const rows = await db.mediaAsset.findMany({ where: { ownerId, filename: { startsWith: MARKER } } });
    expect(rows.length).toBe(0);
  });
});
