/**
 * GZ-BENCH-1 regression: explicit output budget for file-generation calls.
 *
 * Baseline evidence (run 2026-11-22-baseline, benchmark A turn2): the
 * provider's DEFAULT output cap truncated a file-batch JSON mid-string
 * ("Unterminated string" at ~10.5k chars, verified live with
 * scripts/tmp/probe-giftz-batch.ts). All three recovery attempts reproduced
 * the same cut, so a batch containing assets/styles.css was declared "no
 * usable content" and the turn failed. With an explicit max_tokens the
 * identical call returned 31.9k chars of parseable JSON.
 *
 * These tests pin (a) the gateway actually forwards max_tokens to the
 * provider body, (b) the file pipeline passes the budget on its
 * plan/batch/repair calls with an adequate timeout, and (c) the prompt
 * pins that prevent the related broken-reference failure class.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Capture the exact body the gateway sends to the provider SDK.
// ---------------------------------------------------------------------------

const capturedBodies: Array<Record<string, unknown>> = [];

mock.module("z-ai-web-dev-sdk", () => {
  const ZAIFake = {
    create: async () => ({
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            capturedBodies.push(body);
            return {
              choices: [{ message: { content: "{\"ok\":true}" } }],
            };
          },
        },
      },
    }),
  };
  return { default: ZAIFake, ZAI: ZAIFake };
});

const { gatewayComplete } = await import("../src/lib/intelligence/gateway");

function lastBody(): Record<string, unknown> {
  const body = capturedBodies[capturedBodies.length - 1];
  if (!body) throw new Error("no provider call captured");
  return body;
}

describe("gateway max_tokens forwarding (GZ-BENCH-1 fix)", () => {
  test("maxTokens reaches the provider body as max_tokens", async () => {
    await gatewayComplete({
      capability: "text",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      agent: "SYSTEM",
      feature: "bench-budget-test",
      maxTokens: 32000,
    });
    expect(lastBody()["max_tokens"]).toBe(32000);
    expect((lastBody()["thinking"] as { type: string }).type).toBe("disabled");
  });

  test("without maxTokens the body carries no max_tokens key (existing calls unchanged)", async () => {
    await gatewayComplete({
      capability: "text",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      agent: "SYSTEM",
      feature: "bench-budget-test",
    });
    expect("max_tokens" in lastBody()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source pins — the file pipeline must USE the budget where output is large.
// ---------------------------------------------------------------------------

const agentSource = await import("node:fs").then((fs) =>
  fs.promises.readFile(new URL("../src/lib/giftz/project-agent.ts", import.meta.url), "utf8")
);

describe("file pipeline uses the explicit output budget", () => {
  test("the batch executor passes the file-generation budget and an adequate timeout", () => {
    expect(agentSource).toContain("const AI_FILEGEN_MAX_TOKENS = 32_000;");
    expect(agentSource).toContain("const AI_FILEGEN_TIMEOUT_MS = 240_000;");
    // The batch call site (inside attemptExecuteBatch) opts in:
    expect(agentSource).toMatch(/timeoutMs: AI_FILEGEN_TIMEOUT_MS,\s*\n\s*maxTokens: AI_FILEGEN_MAX_TOKENS/);
  });

  test("the build-repair round opts into the same budget", () => {
    // Both file-content call sites (execute + repair) appear with the budget.
    const sites = agentSource.match(/maxTokens: AI_FILEGEN_MAX_TOKENS/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  test("plan calls carry a compact budget (plans are small JSON)", () => {
    const sites = agentSource.match(/maxTokens: AI_PLAN_MAX_TOKENS/g) ?? [];
    expect(sites.length).toBe(2);
    expect(agentSource).toContain("const AI_PLAN_MAX_TOKENS = 8_000;");
  });

  test("batch + repair prompts pin exact project-relative reference paths", () => {
    // The C benchmark failure (product.html referencing a bare "styles.css")
    // is prevented at the prompt level for both content-producing calls.
    expect(agentSource).toContain("Internal links and asset references must use the EXACT project-relative paths");
    const pins = agentSource.match(/EXACT project-relative paths/g) ?? [];
    expect(pins.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The truncation failure mode itself — why the budget is required at all.
// ---------------------------------------------------------------------------

describe("parseJsonFromText cannot recover a truncated batch (documented failure mode)", () => {
  test("a JSON response cut mid-string parses to null", async () => {
    const { parseJsonFromText } = await import("../src/lib/ai");
    const truncated = '{"files":[{"path":"assets/styles.css","content":"body { margin: 0; /* cut off here';
    expect(parseJsonFromText(truncated)).toBeNull();
  });

  test("a complete response parses (the post-fix behavior)", async () => {
    const { parseJsonFromText } = await import("../src/lib/ai");
    const complete = '{"files":[{"path":"assets/styles.css","content":"body { margin: 0; }"}]}';
    expect(parseJsonFromText<{ files: { path: string }[] }>(complete)?.files[0]?.path).toBe("assets/styles.css");
  });
});
