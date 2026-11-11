import ZAI from "z-ai-web-dev-sdk";
async function main() {
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (p: unknown) => Promise<unknown> } } }> }).create();
  const t0 = Date.now();
  try {
    const r = await zai.images.generations.create({ prompt: "A minimal dark charcoal banner with subtle champagne-gold diagonal light streaks, premium, no text", size: "2016x864" });
    console.log("OK in", Date.now() - t0, "ms; keys:", Object.keys((r ?? {}) as object).join(","));
    console.log("data len:", (r as { data?: unknown[] })?.data?.length);
  } catch (e) {
    console.log("FAILED in", Date.now() - t0, "ms:", e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack) console.log(e.stack.split("\n").slice(0, 6).join("\n"));
  }
  process.exit(0);
}
main();
