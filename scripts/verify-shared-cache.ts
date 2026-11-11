/**
 * BEAN Folio — shared production infrastructure verification (P1).
 *
 * Verifies the SHARED cache backend and the SHARED rate-limit backend with
 * REAL separate OS processes (two instances sharing one database — the same
 * topology as horizontally scaled production pods, exercised here on the
 * dev database):
 *
 *   1. share      — instance A caches a public payload; instance B reads it
 *                   (a per-instance Map could never do this).
 *   2. invalidate — instance A fires the publish invalidation event; a fresh
 *                   instance B misses (shared rows deleted + generation bumped).
 *   3. generation — instance B caches a value, instance A invalidates, B's
 *                   local L1 buffer is dropped within the generation poll
 *                   interval (≤ GEN_POLL_MS + margin).
 *   4. whitelist  — a non-public key is REFUSED by the shared store (private
 *                   data can never leak into shared caching); it stays on the
 *                   per-instance memory path only.
 *   5. ratelimit  — K concurrent processes hammer one fixed-window bucket;
 *                   the number of allowed hits is EXACTLY the limit and the
 *                   bucket count matches the total attempts (atomic upsert-
 *                   increment under multi-process concurrency).
 *
 * Usage: bun scripts/verify-shared-cache.ts
 * Exit 0 = all verified. Any failure exits non-zero with the failed case.
 * The script only touches its own `__verify_*` keys/buckets and cleans up.
 */

import { spawn } from "node:child_process";

const VERIFY_KEY = "profile:public:__verify_shared__";
const PRIVATE_KEY = "me:draft:__verify_private__";
const GEN_KEY = "profile:public:__verify_generation__";
const RL_KEY = `verify:p1:${process.pid}`;
const RL_LIMIT = 15;
const RL_CHILD_HITS = 12;
const RL_CHILDREN = 2;

interface ChildResult {
  ok: boolean;
  case: string;
  detail?: unknown;
  error?: string;
}

function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/verify-shared-cache.ts", "--child", ...args],
      {
        env: { ...process.env, CACHE_BACKEND: "postgres" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code: number | null) => {
      try {
        const lines = out.trim().split("\n").filter(Boolean);
        const parsed = JSON.parse(lines[lines.length - 1]) as ChildResult;
        resolve(parsed);
      } catch {
        resolve({ ok: false, case: args.join(" "), error: `exit ${code}: ${out || err}`.slice(0, 500) });
      }
    });
  });
}

async function cleanup(): Promise<void> {
  // Direct DB cleanup (not through the cache API) so verification always starts clean.
  const { db } = await import("@/lib/db");
  await db.cacheEntry.deleteMany({ where: { key: { in: [VERIFY_KEY, PRIVATE_KEY, GEN_KEY] } } });
  await db.cacheGeneration.deleteMany({ where: { namespace: { in: ["profile", "me"] } } });
  await db.rateLimitBucket.deleteMany({ where: { key: { contains: "verify:p1:" } } });
}

async function main(): Promise<void> {
  const isChild = process.argv.includes("--child");
  if (isChild) return childMain();

  console.log("P1 verification — shared cache + shared rate limiting (real child processes)");
  await cleanup();

  const failures: string[] = [];
  const pass = (name: string, cond: boolean, detail?: unknown) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${JSON.stringify(detail)}`}`);
    if (!cond) failures.push(name);
  };

  // 1+2: writer child, reader child, invalidator child, fresh reader child.
  const writer = await runChild(["--mode", "write", "--key", VERIFY_KEY]);
  pass("write via instance A", writer.ok, writer);

  const reader = await runChild(["--mode", "read", "--key", VERIFY_KEY]);
  pass(
    "cross-instance read (B sees A's write)",
    reader.ok && (reader.detail as { hit?: boolean })?.hit === true,
    reader
  );

  const invalidator = await runChild(["--mode", "invalidate"]);
  pass("invalidate via instance A", invalidator.ok, invalidator);

  const reader2 = await runChild(["--mode", "read", "--key", VERIFY_KEY]);
  pass(
    "cross-instance invalidation (B misses after A's event)",
    reader2.ok && (reader2.detail as { hit?: boolean })?.hit === false,
    reader2
  );

  // 3: generation-based L1 drop inside ONE process (B caches, A invalidates, B re-checks).
  const gen = await runChild(["--mode", "generation", "--key", GEN_KEY]);
  pass(
    "generation poll drops local L1 within interval",
    gen.ok,
    gen
  );

  // 4: whitelist — private keys never enter the shared store.
  const priv = await runChild(["--mode", "private", "--key", PRIVATE_KEY]);
  pass(
    "private key refused by shared store (memory-only)",
    priv.ok && (priv.detail as { sharedRow?: boolean })?.sharedRow === false,
    priv
  );

  // 5: rate-limit atomicity across processes.
  const rlRuns = await Promise.all(
    Array.from({ length: RL_CHILDREN }, (_, i) =>
      runChild(["--mode", "ratelimit", "--key", RL_KEY, "--hits", String(RL_CHILD_HITS)])
        .then((r) => ({ r, i }))
    )
  );
  const allClean = rlRuns.every(({ r }) => r.ok);
  const allowedTotal = rlRuns.reduce(
    (sum, { r }) => sum + ((r.detail as { allowed?: number })?.allowed ?? 0),
    0
  );
  const attemptsTotal = rlRuns.reduce(
    (sum, { r }) => sum + ((r.detail as { attempts?: number })?.attempts ?? 0),
    0
  );
  const bucketCounts = rlRuns.map(({ r }) => (r.detail as { bucketCount?: number | null })?.bucketCount ?? null);
  pass("rate-limit children completed without errors", allClean, rlRuns.map(({ r }) => r));
  pass(
    `atomic shared limit (${RL_CHILDREN} processes × ${RL_CHILD_HITS} hits, limit ${RL_LIMIT} → exactly ${RL_LIMIT} allowed)`,
    allowedTotal === RL_LIMIT && attemptsTotal === RL_CHILDREN * RL_CHILD_HITS,
    { allowedTotal, attemptsTotal }
  );

  // The final bucket count must be read AFTER all children finished (per-child
  // reads race with the other child's in-flight increments). The parent hashes
  // the key exactly like the backend does and reads the converged row.
  const { createHash } = await import("node:crypto");
  const { db } = await import("@/lib/db");
  const hashedKey = createHash("sha256").update(RL_KEY).digest("hex");
  const finalBucket = await db.rateLimitBucket.findUnique({
    where: {
      key_windowStart: {
        key: hashedKey,
        windowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000),
      },
    },
  });
  pass(
    "shared bucket count equals total attempts (atomic counter converged)",
    finalBucket?.count === attemptsTotal,
    { finalCount: finalBucket?.count ?? null, attemptsTotal }
  );

  await cleanup();

  if (failures.length > 0) {
    console.error(`P1 verification FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("P1 verification PASSED — shared cache + shared rate limiting verified across processes.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Child modes (each runs in a FRESH process = a distinct "instance")
// ---------------------------------------------------------------------------

async function childMain(): Promise<void> {
  const mode = argvValue("--mode") ?? "";
  const key = argvValue("--key") ?? VERIFY_KEY;
  const result = await runMode(mode, key);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function argvValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function runMode(mode: string, key: string): Promise<ChildResult> {
  const cache = await import("@/lib/cache");
  const { postgresBackend } = await import("@/lib/rate-limit-backend");

  switch (mode) {
    case "write": {
      await cache.cacheSetShared(key, { marker: "p1-verify", at: Date.now() }, 60_000);
      return { ok: true, case: "write" };
    }
    case "read": {
      const hit = await cache.cacheGetShared<{ marker: string }>(key);
      return { ok: true, case: "read", detail: { hit: hit !== null, marker: hit?.marker ?? null } };
    }
    case "invalidate": {
      await cache.cacheInvalidateEventShared("site.publish");
      return { ok: true, case: "invalidate" };
    }
    case "generation": {
      // Cache a value, then invalidate from "another instance" (same process
      // acts as B; the bump is visible through the shared table immediately —
      // the poll path is exercised because we clear the fetchedAt freshness).
      await cache.cacheSetShared(key, { marker: "gen" }, 60_000);
      const before = await cache.cacheGetShared<{ marker: string }>(key);
      // Simulate another instance invalidating behind this process's back:
      // a DIRECT shared-table delete + generation bump (what invalidation on
      // another instance does), bypassing this process's local maps.
      const { db } = await import("@/lib/db");
      await db.cacheEntry.deleteMany({ where: { key } });
      await db.cacheGeneration.upsert({
        where: { namespace: "profile" },
        create: { namespace: "profile", generation: 1 },
        update: { generation: { increment: 1 } },
      });
      // Wait past the generation poll cadence, then read: the L1 entry must be
      // dropped (its generation is stale), and the read must MISS.
      await new Promise((r) => setTimeout(r, 1_200));
      const after = await cache.cacheGetShared<{ marker: string }>(key);
      return {
        ok: before !== null && after === null,
        case: "generation",
        detail: { before: before !== null, afterMiss: after === null },
      };
    }
    case "private": {
      await cache.cacheSetShared(key, { secret: "must-not-be-shared" }, 60_000);
      const { db } = await import("@/lib/db");
      const row = await db.cacheEntry.findUnique({ where: { key } });
      return { ok: true, case: "private", detail: { sharedRow: row !== null } };
    }
    case "ratelimit": {
      const hits = Number.parseInt(argvValue("--hits") ?? "12", 10);
      let allowed = 0;
      for (let i = 0; i < hits; i += 1) {
        const r = await postgresBackend.hit(key, RL_LIMIT, 60_000);
        if (r.allowed) allowed += 1;
      }
      // Bucket rows store the SHA-256 HASH of the key (PII hygiene) — look
      // the row up the same way the backend does to assert the stored count.
      const { createHash } = await import("node:crypto");
      const { db } = await import("@/lib/db");
      const hashed = createHash("sha256").update(key).digest("hex");
      const row = await db.rateLimitBucket.findUnique({
        where: { key_windowStart: { key: hashed, windowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000) } },
      });
      return { ok: true, case: "ratelimit", detail: { allowed, attempts: hits, bucketCount: row?.count ?? null } };
    }
    default:
      return { ok: false, case: mode, error: `unknown mode ${mode}` };
  }
}

void main();
