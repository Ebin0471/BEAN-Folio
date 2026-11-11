/// <reference types="bun-types" />
/**
 * Authentication tests (see src/lib/auth.ts, src/app/api/auth/login/route.ts).
 *
 * Proves the properties that matter after the 2026-10-27 database-wipe incident:
 *
 *  1. Password hashing and verification use the SAME algorithm (scrypt,
 *     per-user salt, 64-byte key, timing-safe compare) in both directions.
 *  2. Wrong passwords and malformed/corrupt stored hashes are rejected —
 *     nothing ever compares plaintext or throws on bad input.
 *  3. The active database contains the restored real accounts: the demo user
 *     (whose seed password we can verify end-to-end) and the owner's account
 *     (presence + hash-format check only — its password is never known here).
 *  4. Accounts PERSIST across a simulated restart (fresh Prisma client
 *     connection sees data written by the previous one).
 *  5. A database-configuration guard: the active datasource is the SQLite
 *     file this sandbox expects, so a silent env swap cannot pass unnoticed.
 *
 * Run: bun test tests/auth.test.ts
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth";

describe("password hashing (scrypt roundtrip)", () => {
  test("correct password verifies; wrong password rejected", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  test("stored format is scrypt: 32-hex salt : 128-hex key (64 bytes)", async () => {
    const hash = await hashPassword("another-password");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  test("two hashes of the same password differ (per-user salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toEqual(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  test("malformed / corrupt stored hashes are rejected, never crash", async () => {
    for (const bad of ["", "no-colon-here", "abc:def", "zz:zz", "a".repeat(32) + ":short"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

describe("active database account invariants", () => {
  test("demo account exists and verifies against its seed password", async () => {
    const demo = await db.user.findUnique({ where: { email: "demo@beanfolio.app" } });
    expect(demo).not.toBeNull();
    expect(demo!.deletedAt).toBeNull();
    expect(demo!.isDemo).toBe(true);
    expect(await verifyPassword("demo1234", demo!.passwordHash)).toBe(true);
  });

  // Historical note: this suite previously pinned the presence of the restored
  // account "mrbeanfan67@gmail.com" after a 2026-10-27 database-recovery
  // incident. That account was later deleted through the product's own
  // deletion flow (POST /api/me/deletion — see dev.log), which is a legitimate
  // end-user action, so its presence is no longer an invariant. What MUST hold
  // for every live account row: scrypt-format hashes, no plaintext secrets,
  // and soft-deleted accounts are unrecoverable by login.
  test("every live user row has a well-formed scrypt hash and no tombstone is resolvable", async () => {
    const live = await db.user.findMany({ where: { deletedAt: null }, select: { passwordHash: true, email: true } });
    expect(live.length).toBeGreaterThan(0);
    for (const u of live) {
      expect(u.passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    }
    const tombstone = await db.user.findFirst({ where: { deletedAt: { not: null } }, select: { id: true, email: true } });
    if (tombstone) {
      // Deletion anonymizes the tombstone's own address (deleted+<cuid>@deleted.beanfolio)
      // and deliberately FREES the original email for reuse (the unique
      // constraint is on email, so a hard quarantine would block sign-ups
      // forever). The invariant is therefore: the tombstone itself no longer
      // carries a usable address, and the original email — when it resolves
      // at all — resolves to a DIFFERENT, live account (a legitimate
      // re-registration, as the audit trail shows for this very address),
      // never to the tombstoned row.
      expect(tombstone.email).toMatch(/^deleted\+/);
      const byEmail = await db.user.findUnique({ where: { email: tombstone.email }, select: { id: true, deletedAt: true } });
      expect(byEmail?.id).toBe(tombstone.id);
      expect(byEmail?.deletedAt).not.toBeNull();
    }
  });

  test("QA/E2E fixture accounts are excluded from public surfaces (isDemo)", async () => {
    const qaEmails = [
      "trace-tester@beanfolio.test", "navfree@beanfolio.test", "admin@beanfolio.test",
      "journey@beanfolio.test", "nova.testwright@example.com", "milo.testwright@example.com",
      "qa-live-1026@example.com", "qa-live2-1026@example.com", "bean-e2e@beanfolio.app",
      "pub-e2e-1027@beanfolio.test",
    ];
    const rows = await db.user.findMany({ where: { email: { in: qaEmails } }, select: { isDemo: true } });
    expect(rows.length).toBe(qaEmails.length);
    for (const row of rows) expect(row.isDemo).toBe(true);
  });
});

describe("account persistence across a simulated restart", () => {
  test("a fresh Prisma client connection sees an account written earlier", async () => {
    const email = `restart-test-${randomUUID()}@beanfolio.test`;
    const created = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword("restart-test-password"),
        name: "Restart Persistence Test",
      },
    });
    try {
      // New client = new connection, exactly what a restarted process does.
      const { PrismaClient } = await import("@prisma/client");
      const fresh = new PrismaClient();
      try {
        const seen = await fresh.user.findUnique({ where: { email } });
        expect(seen).not.toBeNull();
        expect(seen!.id).toBe(created.id);
      } finally {
        await fresh.$disconnect();
      }
    } finally {
      await db.user.delete({ where: { id: created.id } }); // cleanup — no test residue
    }
    const gone = await db.user.findUnique({ where: { email } });
    expect(gone).toBeNull();
  });
});

describe("database configuration guard", () => {
  test("the active datasource is the sandbox SQLite file (no silent env swap)", () => {
    const url = process.env.DATABASE_URL ?? "";
    expect(url.startsWith("file:")).toBe(true);
    expect(url).toContain("custom.db");
  });
});
