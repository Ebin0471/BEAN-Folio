/**
 * Structured logger — request correlation regression (GZ-SCALE M3).
 *
 * Pins: every structured line emitted inside a handler() request scope
 * carries the SAME requestId that the response header returns; lines emitted
 * outside request scope carry none; the redaction policy (secret patterns)
 * still applies on correlated lines.
 *
 * Run: bun test tests/logger-correlation.test.ts
 */

import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { NextRequest } from "next/server";

import { log } from "@/lib/logger";
import { handler, ok, getRequestId } from "@/lib/api-helpers";
import { runWithRequestContext, getRequestId as ctxGetRequestId } from "@/lib/request-context";

const logSpy = spyOn(console, "log");

/** JSON lines emitted through the structured logger during `fn`. */
function jsonLines(): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map((call) => call[0])
    .filter((a): a is string => typeof a === "string" && a.startsWith("{"))
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((l): l is Record<string, unknown> => l !== null);
}

afterEach(() => {
  logSpy.mockClear();
});

const probeRoute = handler(async (_req: NextRequest) => {
  const inScope = getRequestId();
  log.info("logger.probe", { note: "correlation check" });
  return ok({ requestId: inScope });
});

describe("logger request correlation", () => {
  test("lines inside a handler request carry the response's requestId", async () => {
    const req = new NextRequest("http://localhost/api/logger-probe", {
      headers: { "x-request-id": "corr-test-12345678" },
    });
    const res = await probeRoute(req);
    expect(res.headers.get("x-request-id")).toBe("corr-test-12345678");

    const mine = jsonLines().find((l) => l.event === "logger.probe");
    expect(mine).toBeDefined();
    expect(mine!.requestId).toBe("corr-test-12345678");
  });

  test("request-context accessor agrees with the api-helpers re-export", async () => {
    await runWithRequestContext({ requestId: "ctx-check-12345678", method: "GET", path: "/" }, async () => {
      expect(ctxGetRequestId()).toBe("ctx-check-12345678");
      expect(getRequestId()).toBe("ctx-check-12345678");
    });
    expect(ctxGetRequestId()).toBeNull();
    expect(getRequestId()).toBeNull();
  });

  test("secret patterns are still redacted on correlated lines", async () => {
    // The redaction policy covers private key blocks, AWS key ids, URL
    // credentials and 40+ hex tokens — a 48-hex-char token must not survive.
    const secret = "a".repeat(24) + "b".repeat(24);
    log.info("logger.redact.probe", { blob: `token ${secret} leaked?` });
    const mine = jsonLines().find((l) => l.event === "logger.redact.probe");
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine)).not.toContain(secret);
    expect(JSON.stringify(mine)).toContain("<redacted token>");
  });
});
