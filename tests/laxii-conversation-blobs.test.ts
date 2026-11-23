/**
 * LAXII conversation deletion — storage blob hygiene regression (GZ-SCALE M2/A2).
 *
 * Reproduces the leak: deleting a conversation cascaded
 * LaxiiMessage → LaxiiImageVersion rows but left the underlying MediaAsset
 * rows AND their storage bytes (multi-MB PNGs per generation) on disk / in
 * the bucket FOREVER — every generated image became a permanent orphan.
 *
 * The fix deletes orphaned assets (rows + bytes) while KEEPING any asset
 * still referenced by another aggregate (other conversations, project media,
 * project covers, posts, site materials, agent artifacts).
 *
 * Real database (isolated test DB — run-tests.sh guard) + real local storage
 * in a throwaway MEDIA_LOCAL_ROOT.
 *
 * Run: DATABASE_URL=file:<isolated custom.db> bun test tests/laxii-conversation-blobs.test.ts
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

process.env.MEDIA_STORAGE_DRIVER = "local";
const mediaRoot = mkdtempSync(join(tmpdir(), "bean-laxii-blobs-"));
process.env.MEDIA_LOCAL_ROOT = mediaRoot;

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { putObject } from "@/lib/storage";
import { deleteConversation } from "@/lib/laxii/conversations";

const suffix = Date.now().toString(36);
const createdUserIds: string[] = [];

afterAll(async () => {
  // Cascades wipe conversations/messages/versions/assets created here.
  // EVERY user created in this suite is removed — the repo-wide invariant
  // test (auth.test.ts) requires zero malformed hash rows among live users.
  for (const id of createdUserIds) {
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  rmSync(mediaRoot, { recursive: true, force: true });
});

async function createFixtureUser(email: string): Promise<{ id: string }> {
  const user = await db.user.create({
    data: { email, passwordHash: await hashPassword("fixture-password"), name: "Blob Hygiene" },
  });
  createdUserIds.push(user.id);
  return user;
}

async function seedConversationWithAsset(ownerId: string): Promise<{ conversationId: string; assetId: string; storagePath: string }> {
  const conversation = await db.laxiiConversation.create({ data: { userId: ownerId, title: "blob test" } });
  const message = await db.laxiiMessage.create({
    data: { conversationId: conversation.id, role: "ASSISTANT", text: "generated" },
  });
  const storagePath = join("uploads", ownerId, `blob-test-${suffix}-${Math.random().toString(36).slice(2)}.png`);
  const absPath = join(mediaRoot, storagePath);
  mkdirSync(join(mediaRoot, "uploads", ownerId), { recursive: true });
  writeFileSync(absPath, Buffer.from("pretend-png-bytes"));
  const asset = await db.mediaAsset.create({
    data: {
      ownerId,
      kind: "IMAGE",
      filename: "blob-test.png",
      mime: "image/png",
      size: 16,
      storagePath,
      status: "READY",
    },
  });
  await db.laxiiImageVersion.create({
    data: { messageId: message.id, conversationId: conversation.id, mediaId: asset.id },
  });
  return { conversationId: conversation.id, assetId: asset.id, storagePath };
}

describe("deleteConversation blob hygiene", () => {
  test("deleting a conversation removes orphaned asset rows AND the storage bytes", async () => {
    const user = await createFixtureUser(`blob-hygiene-${suffix}@test.local`);
    const { conversationId, storagePath } = await seedConversationWithAsset(user.id);

    // Blob exists before deletion.
    expect(existsSync(join(mediaRoot, storagePath))).toBe(true);

    const result = await deleteConversation(user.id, conversationId);
    expect(result).toBe(true);

    // Conversation + version rows cascaded away…
    expect(await db.laxiiConversation.count({ where: { id: conversationId } })).toBe(0);
    // …AND the asset row…
    expect(await db.mediaAsset.count({ where: { storagePath } })).toBe(0);
    // …AND the bytes on disk (THE regression: these used to leak forever).
    expect(existsSync(join(mediaRoot, storagePath))).toBe(false);
  });

  test("an asset still referenced by another aggregate is KEPT (rows + bytes)", async () => {
    const user = await createFixtureUser(`blob-keep-${suffix}@test.local`);
    const project = await db.project.create({ data: { ownerId: user.id, title: "Keeper" } });
    const { conversationId, assetId, storagePath } = await seedConversationWithAsset(user.id);
    await db.projectMedia.create({ data: { projectId: project.id, mediaId: assetId } });

    const result = await deleteConversation(user.id, conversationId);
    expect(result).toBe(true);

    // Conversation is gone, but the referenced asset survives intact.
    expect(await db.laxiiConversation.count({ where: { id: conversationId } })).toBe(0);
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    expect(asset).not.toBeNull();
    expect(asset!.storagePath).toBe(storagePath);
    expect(existsSync(join(mediaRoot, storagePath))).toBe(true);
    expect(await db.projectMedia.count({ where: { mediaId: assetId } })).toBe(1);
  });

  test("an asset shared with ANOTHER conversation is kept (cross-conversation reference)", async () => {
    const user = await createFixtureUser(`blob-share-${suffix}@test.local`);
    const first = await seedConversationWithAsset(user.id);
    const secondConversation = await db.laxiiConversation.create({
      data: { userId: user.id, title: "second" },
    });
    const secondMessage = await db.laxiiMessage.create({
      data: { conversationId: secondConversation.id, role: "ASSISTANT", text: "ref" },
    });
    await db.laxiiImageVersion.create({
      data: { messageId: secondMessage.id, conversationId: secondConversation.id, mediaId: first.assetId },
    });

    await deleteConversation(user.id, first.conversationId);

    // Still referenced by the second conversation → asset + bytes survive.
    const asset = await db.mediaAsset.findUnique({ where: { id: first.assetId } });
    expect(asset).not.toBeNull();
    expect(existsSync(join(mediaRoot, first.storagePath))).toBe(true);
  });

  test("ownership guard: another user cannot delete a conversation", async () => {
    const owner = await createFixtureUser(`blob-owner-${suffix}@test.local`);
    const attacker = await createFixtureUser(`blob-attacker-${suffix}@test.local`);
    const { conversationId } = await seedConversationWithAsset(owner.id);

    const result = await deleteConversation(attacker.id, conversationId);
    expect(result).toBeNull();
    expect(await db.laxiiConversation.count({ where: { id: conversationId } })).toBe(1);
  });
});
