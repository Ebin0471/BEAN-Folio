/**
 * GIFTZ file-batch parse failure probe (GZ-BENCH diagnostic).
 *
 * Reproduces the executeBatchPrompt response shape against the real managed
 * provider and answers, with raw evidence, WHY a response can fail
 * parseJsonFromText + batchOutputSchema:
 *   1. Is the response truncated (provider output cap)?
 *   2. Is the JSON invalid (control characters, unescaped quotes)?
 *   3. Does the response wrap the JSON in prose/fences that defeat slicing?
 *   4. Does passing max_tokens through the SDK body change the output length?
 *
 * Read-only diagnostic — no DB writes, no site changes. Run with the same
 * env as the app (bun auto-loads .env):  bun scripts/diagnostics/probe-giftz-batch.ts
 */

import ZAI from "z-ai-web-dev-sdk";

type ZaiChat = {
  chat: { completions: { create: (p: unknown) => Promise<{ choices?: { message?: { content?: string } }[] }> } };
};

const SYSTEM = [
  "You are the CODE GIFTZ file-writing engine.",
  "Return ONLY a raw JSON object: { \"files\": [ { \"path\": string, \"content\": string } ] }.",
  "Every requested file must appear with its COMPLETE final content.",
].join(" ");

// A realistic 4-page-site stylesheet, sized like the benchmark failure.
function bigCss(targetChars: number): string {
  const block = [
    ":root { --bg: #14100c; --ink: #f4ede2; --brass: #c9a45c; }",
    "body { margin: 0; font-family: Georgia, serif; background: var(--bg); color: var(--ink); }",
    ".nav { display: flex; gap: 2rem; padding: 1.25rem 6vw; border-bottom: 1px solid #2a2118; }",
    ".hero { padding: 18vh 6vw; background: radial-gradient(1200px 600px at 20% 10%, #241b12, transparent); }",
    ".card { border: 1px solid #2a2118; border-radius: 12px; padding: 1.5rem; }",
  ].join("\n");
  return Array.from({ length: Math.ceil(targetChars / block.length) }, (_, i) => `${block}\n/* section ${i} */\n`).join("").slice(0, targetChars);
}

async function callOnce(label: string, prompt: string, extra: Record<string, unknown>): Promise<void> {
  const createFn = (ZAI as unknown as { create: () => Promise<ZaiChat> }).create;
  const zai = await createFn();
  const t0 = Date.now();
  const res = (await Promise.race([
    zai.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      thinking: { type: "enabled" },
      ...extra,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("probe-call-timeout-180s")), 180_000)
    ),
  ])) as { choices?: { message?: { content?: string } }[] };
  const text = res.choices?.[0]?.message?.content ?? "";
  const elapsed = ((Date.now() - t0) / 1000) | 0;

  // Same slicing as parseJsonFromText (first { .. last }).
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const sliced = first >= 0 && last > first ? text.slice(first, last + 1) : null;
  let parseError = "no braces found";
  let parsed: unknown = null;
  if (sliced) {
    try {
      parsed = JSON.parse(sliced);
      parseError = "OK";
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
      // Pinpoint the failure position when the engine reports one.
      const pos = Number((e instanceof Error && /position (\d+)/.exec(e.message))?.[1] ?? -1);
      if (pos >= 0 && sliced) {
        parseError += ` | context@pos: ${JSON.stringify(sliced.slice(Math.max(0, pos - 80), pos + 80))}`;
      }
    }
  }

  const files = (parsed as { files?: { path: string; content: string }[] } | null)?.files;
  console.log(`--- ${label} ---`);
  console.log(`raw length: ${text.length} chars, elapsed: ${elapsed}s`);
  console.log(`starts-with-prose: ${first > 200}, ends-with-prose: ${text.length - last > 200}`);
  console.log(`sliced length: ${sliced?.length ?? 0}, JSON.parse: ${parseError.slice(0, 300)}`);
  console.log(`files parsed: ${files ? files.length : 0}${files ? ` (${files.map((f) => `${f.path}:${f.content.length}ch`).join(", ")})` : ""}`);
}

async function main(): Promise<void> {
  const css = bigCss(9_000);
  const prompt = [
    "Write the following 2 files for the project:",
    "1. assets/styles.css — complete stylesheet for a 4-page architecture site.",
    "2. about.html — complete HTML page linking assets/styles.css and assets/site.js.",
    "Current tree: index.html, assets/styles.css (exists).",
    "",
    "Return this exact JSON shape (all strings must be valid JSON — newlines escaped):",
    '{ "files": [ { "path": "assets/styles.css", "content": "..." }, { "path": "about.html", "content": "..." } ] }',
    "",
    `Requested stylesheet must contain at least ${Math.ceil(css.length / 1000)}k characters of layout rules.`,
  ].join("\n");

  const mode = process.argv[2] ?? "baseline";
  if (mode === "baseline") {
    await callOnce("baseline (no max_tokens)", prompt, {});
  } else if (mode === "maxtok") {
    await callOnce("max_tokens=32000", prompt, { max_tokens: 32000 });
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE-ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
