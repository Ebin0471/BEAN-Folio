import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  storageDriver,
  s3Config,
  buildStorageKey,
  resolveLocalPath,
  putObject,
  getObject,
  deleteObject,
  uploadDir,
} from "../src/lib/storage";

/**
 * Storage boundary tests (hermetic — no network, no real bucket):
 *  - driver selection from env (local default, S3 when fully configured,
 *    MEDIA_STORAGE_DRIVER=local override)
 *  - S3 config parsing (all-or-nothing)
 *  - key building (owner-scoped, unguessable, sanitized)
 *  - local-driver put/get/delete roundtrip in a temp media dir
 *  - path-traversal guard (a tampered storagePath can never escape /uploads)
 */

const ENV_SNAPSHOT: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in ENV_SNAPSHOT)) ENV_SNAPSHOT[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const S3_COMPLETE = {
  S3_ENDPOINT: "https://s3.example.test",
  S3_BUCKET: "bean-media-test",
  S3_ACCESS_KEY_ID: "AKIA_TEST_KEY",
  S3_SECRET_ACCESS_KEY: "s3cr3t-test-secret",
  S3_REGION: "us-east-1",
};

afterAll(() => {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("storage driver selection", () => {
  test("defaults to local when no S3 vars are set", () => {
    setEnv({
      S3_ENDPOINT: undefined, S3_BUCKET: undefined,
      S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined,
      MEDIA_STORAGE_DRIVER: undefined,
    });
    expect(storageDriver()).toBe("local");
  });

  test("uses s3 when all required vars are present", () => {
    setEnv({ ...S3_COMPLETE, MEDIA_STORAGE_DRIVER: undefined });
    expect(storageDriver()).toBe("s3");
  });

  test("MEDIA_STORAGE_DRIVER=local forces local even with S3 vars", () => {
    setEnv({ ...S3_COMPLETE, MEDIA_STORAGE_DRIVER: "local" });
    expect(storageDriver()).toBe("local");
  });

  test("partial S3 config is rejected (all-or-nothing) → local", () => {
    setEnv({ ...S3_COMPLETE, S3_SECRET_ACCESS_KEY: undefined, MEDIA_STORAGE_DRIVER: undefined });
    expect(storageDriver()).toBe("local");
    expect(s3Config()).toBeNull();
  });

  test("s3Config parses defaults (region=auto, path-style on)", () => {
    setEnv({
      S3_ENDPOINT: "https://x.y", S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s",
      S3_REGION: undefined, S3_FORCE_PATH_STYLE: undefined,
    });
    const cfg = s3Config();
    expect(cfg).not.toBeNull();
    expect(cfg!.region).toBe("auto");
    expect(cfg!.forcePathStyle).toBe(true);
  });
});

describe("storage keys", () => {
  test("owner-scoped, unguessable, correct extension", () => {
    const key = buildStorageKey("cmOwner123", "png");
    expect(key).toMatch(/^uploads\/cmOwner123\/[0-9a-z]{8,}[0-9a-f]{16}\.png$/);
    const key2 = buildStorageKey("cmOwner123", "png");
    expect(key2).not.toBe(key); // unguessable
  });

  test("sanitizes hostile ownerId / extension segments", () => {
    const key = buildStorageKey("../../evil", ".p n g");
    expect(key.startsWith("uploads/evil/")).toBe(true);
    expect(key.endsWith(".png")).toBe(true);
    expect(key).not.toContain("..");
  });
});

describe("local path resolution", () => {
  test("allows paths inside the uploads dir (legacy flat + owner-scoped)", () => {
    const mediaDir = uploadDir();
    expect(resolveLocalPath("uploads/seed-a.png")).toBe(path.resolve(mediaDir, "seed-a.png"));
    expect(resolveLocalPath("uploads/u1/abc.png")).toBe(path.resolve(mediaDir, "u1/abc.png"));
  });

  test("rejects traversal outside the uploads dir", () => {
    expect(() => resolveLocalPath("uploads/../../.env")).toThrow("Invalid storage path");
    expect(() => resolveLocalPath("uploads/../package.json")).toThrow("Invalid storage path");
    expect(() => resolveLocalPath("/etc/passwd")).toThrow("Invalid storage path");
    expect(() => resolveLocalPath(".env")).toThrow("Invalid storage path");
  });
});

describe("local driver roundtrip (temp media dir)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "bean-storage-"));

  beforeAll(() => {
    // Runs immediately before these tests (after earlier describes mutated env)
    setEnv({
      MEDIA_LOCAL_ROOT: tmp,
      MEDIA_STORAGE_DRIVER: undefined,
      ...Object.fromEntries(Object.entries(S3_COMPLETE).map(([k]) => [k, undefined])),
    });
  });

  const key = "uploads/test-owner/roundtrip.bin";
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

  test("put → get returns identical bytes; file lands under <root>/uploads", async () => {
    await putObject(key, payload, "image/png");
    const back = await getObject(key);
    expect(Buffer.compare(back, payload)).toBe(0);
    expect(existsSync(path.join(tmp, key))).toBe(true);
  });

  test("delete removes the object; subsequent get throws", async () => {
    await deleteObject(key);
    expect(existsSync(path.join(tmp, key))).toBe(false);
    expect(getObject(key)).rejects.toThrow();
  });

  test("delete is idempotent for missing objects", async () => {
    await deleteObject("uploads/test-owner/never-existed.bin");
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
});
