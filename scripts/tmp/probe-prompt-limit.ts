import ZAI from "z-ai-web-dev-sdk";

type ZaiImages = { images: { generations: { create: (p: unknown) => Promise<unknown> } } };

async function main() {
  const createFn = (ZAI as unknown as { create: () => Promise<ZaiImages> }).create;
  const zai = await createFn();
  for (const len of [4000, 6000, 8000, 12000, 16000]) {
    const prompt = ("Premium portfolio banner scene, warm charcoal background with brass accents, professional editorial composition. " + "Detailed art direction: realistic materials, coherent lighting, balanced layout across the wide canvas. ").repeat(Math.ceil(len / 170)).slice(0, len);
    const t0 = Date.now();
    try {
      const r = (await zai.images.generations.create({ prompt, size: "1024x1024" } as never)) as { data?: unknown[] };
      console.log(`len=${len}: OK (${((Date.now() - t0) / 1000) | 0}s, images=${r.data?.length})`);
    } catch (e) {
      console.log(`len=${len}: FAILED (${((Date.now() - t0) / 1000) | 0}s) — ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    }
  }
  process.exit(0);
}
main();
