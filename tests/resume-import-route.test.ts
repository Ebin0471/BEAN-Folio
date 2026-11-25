/// <reference types="bun-types" />
/**
 * M33.5-A — structured import ROUTE contract (HTTP boundary).
 *
 * Pins spec §11.1 at the wire level:
 *  - anonymous requests → 401;
 *  - a renamed/corrupted upload (signature mismatch) → 400 with a precise
 *    message, BEFORE any parser runs;
 *  - unsupported extensions → 400;
 *  - a real TXT upload returns extracted text + a schema-versioned proposal;
 *  - the parse endpoint persists NOTHING: the LaxiiResume count for the user
 *    is identical before/after (privacy contract §4.1).
 *
 * Run: bun test tests/resume-import-route.test.ts   (isolated QA DB)
 */
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { NextRequest } from "next/server";

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
import { POST as importRoute } from "@/app/api/laxii/resume/import/route";
import { POST as parseRoute } from "@/app/api/laxii/resume/parse/route";

const STAMP = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const EMAIL = `laxii-import-${STAMP}@test.beanfolio.local`;

const SAMPLE_TXT = `Ravi Kumar
ravi.kumar@example.com

EXPERIENCE
Developer
Acme
2020 – Present
Worked on services.`;

function postFile(route: (req: NextRequest) => Promise<Response>, name: string, mime: string, body: Buffer | string): Promise<Response> {
  const form = new FormData();
  const blob = new Blob([typeof body === "string" ? body : new Uint8Array(body)], { type: mime });
  form.append("file", blob, name);
  const req = new NextRequest("http://localhost/api/laxii/resume/import", {
    method: "POST",
    body: form,
  });
  return route(req) as unknown as Promise<Response>;
}

let userId: string;
let resumeCountBefore: number;

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword("import-route-pass"), name: "Import Route" },
  });
  userId = user.id;
  resumeCountBefore = await db.laxiiResume.count({ where: { userId } });
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
});

describe("POST /api/laxii/resume/import — route contract", () => {
  test("anonymous requests are 401", async () => {
    cookieToken = undefined;
    const res = await postFile(importRoute, "resume.txt", "text/plain", SAMPLE_TXT);
    expect(res.status).toBe(401);
  });

  test("a renamed text file claiming to be a PDF is rejected before parsing", async () => {
    cookieToken = await createSession(userId);
    const res = await postFile(importRoute, "resume.pdf", "application/pdf", "not a real pdf");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not a valid PDF");
  });

  test("unsupported extensions are rejected with the precise message", async () => {
    cookieToken = await createSession(userId);
    const res = await postFile(importRoute, "photo.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Unsupported file type");
  });

  test("a real TXT upload returns text + a versioned proposal and persists nothing", async () => {
    cookieToken = await createSession(userId);
    const res = await postFile(importRoute, "resume.txt", "text/plain", SAMPLE_TXT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      text: string;
      truncated: boolean;
      source: string;
      proposal: { schemaVersion: number; source: { method: string }; basics: { email: { value: string } | null }; work: { value: { company: string } }[]; warnings: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.text).toContain("ravi.kumar@example.com");
    expect(body.truncated).toBe(false);
    expect(body.source).toBe("plain-text");
    expect(body.proposal.schemaVersion).toBe(1);
    expect(body.proposal.source.method).toBe("plain-text");
    expect(body.proposal.basics.email?.value).toBe("ravi.kumar@example.com");
    expect(body.proposal.work.length).toBe(1);
    expect(body.proposal.work[0].value.company).toBe("Acme");
    // Privacy contract: the import endpoint persists nothing.
    const resumeCountAfter = await db.laxiiResume.count({ where: { userId } });
    expect(resumeCountAfter).toBe(resumeCountBefore);
  });

  test("the legacy parse route rejects the same renamed-PDF impostor", async () => {
    cookieToken = await createSession(userId);
    const res = await postFile(parseRoute, "resume.pdf", "application/pdf", "still not a pdf");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not a valid PDF");
  });
});
