import ZAI from "z-ai-web-dev-sdk";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "scripts", "seed-assets");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Size values are constrained to the z-ai image generation SDK's union type.
type GenSize = "1024x1024" | "1344x768" | "768x1344" | "864x1152" | "1152x864" | "1440x720" | "720x1440";
type Job = { file: string; size: GenSize; prompt: string };

const jobs: Job[] = [
  // Avatars (missing ones from the first batch)
  { file: "avatar-ines.png", size: "1024x1024", prompt: "Editorial portrait photograph of a Latina woman photographer in her late 20s holding a vintage film camera, natural window light, neutral dark background, professional, high quality" },
  { file: "avatar-kofi.png", size: "1024x1024", prompt: "Editorial portrait photograph of a West African male software engineer in his 30s, warm smile, dark office with soft amber bokeh lights behind, professional headshot, high quality" },
  { file: "avatar-lena.png", size: "1024x1024", prompt: "Editorial portrait photograph of a Korean woman chef in her 30s wearing a charcoal apron, arms crossed, dark moody kitchen background with warm light, professional, high quality" },
  { file: "avatar-theo.png", size: "1024x1024", prompt: "Editorial portrait photograph of a creative male illustrator in his 20s with curly hair and ink-stained fingers, warm gallery lighting, dark background, professional, high quality" },
  { file: "avatar-priya.png", size: "1024x1024", prompt: "Editorial portrait photograph of an Indian woman UX designer in her 30s, confident expression, dark studio with subtle golden accent light, professional headshot, high quality" },
  { file: "avatar-marco.png", size: "1024x1024", prompt: "Editorial portrait photograph of a Mediterranean male marketing strategist in his 40s, blazer, dark studio background with warm key light, professional headshot, high quality" },
  // Project covers (landscape)
  { file: "cover-film.png", size: "1344x768", prompt: "Professional film editing suite, large monitor showing a cinematic color grading timeline with teal and orange footage, dark room lit by warm amber screen glow, editorial photography, high quality" },
  { file: "cover-doc.png", size: "1344x768", prompt: "Cinematic documentary still of a lone fisherman on a wooden boat at dawn, misty golden light over calm water, film grain, anamorphic look, high quality" },
  { file: "cover-brand.png", size: "1344x768", prompt: "Brand identity design flat lay on dark charcoal paper: embossed gold logo on business cards, letterhead, typography specimen sheets, warm studio lighting, editorial photography, high quality" },
  { file: "cover-arch.png", size: "1344x768", prompt: "Modern minimalist concrete pavilion with large glass facade reflecting golden sunset, surrounded by birch trees, architectural photography, high quality" },
  { file: "cover-interior.png", size: "1344x768", prompt: "Warm minimalist interior architectural render, oak wood staircase, soft daylight through tall window, linen textures, champagne gold accents, photorealistic, high quality" },
  { file: "cover-street.png", size: "1344x768", prompt: "Black and white street photography, rainy night crosswalk with silhouetted pedestrians and glowing shop reflections on wet asphalt, high contrast, editorial, high quality" },
  { file: "cover-product.png", size: "1344x768", prompt: "Professional product photography of a matte black ceramic coffee pour-over set on dark stone surface, dramatic side light, steam, warm gold reflections, high quality" },
  { file: "cover-dashboard.png", size: "1344x768", prompt: "Clean SaaS analytics dashboard interface on a dark theme with warm gold accent charts, presented as a sleek laptop mockup on a designer desk, high quality" },
  { file: "cover-dish.png", size: "1344x768", prompt: "Fine dining plated dish photography, seared scallops with saffron emulsion and micro herbs on dark ceramic plate, moody restaurant lighting, michelin star plating, high quality" },
  { file: "cover-illustration.png", size: "1344x768", prompt: "Children's book illustration spread, whimsical watercolor style of a small fox sailing a paper boat down a moonlit river, warm gold and deep teal palette, detailed, high quality" },
  { file: "cover-motion.png", size: "1344x768", prompt: "Abstract motion design style frames grid, elegant flowing gold ribbons and geometric shapes on obsidian black background, motion graphics aesthetic, high quality" },
  { file: "cover-campaign.png", size: "1344x768", prompt: "Urban billboard advertising campaign at dusk, bold minimal typography poster in champagne gold on black, city street context with warm lights, editorial photography, high quality" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(zai: Awaited<ReturnType<typeof ZAI.create>>, job: Job, attempt = 1): Promise<boolean> {
  if (fs.existsSync(path.join(OUT, job.file))) {
    console.log(`skip (exists): ${job.file}`);
    return true;
  }
  try {
    const res = await zai.images.generations.create({ prompt: job.prompt, size: job.size });
    const b64 = res.data?.[0]?.base64;
    if (!b64) throw new Error("empty response");
    fs.writeFileSync(path.join(OUT, job.file), Buffer.from(b64, "base64"));
    console.log(`OK: ${job.file}`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`FAIL(${attempt}): ${job.file} — ${msg.slice(0, 120)}`);
    if (attempt < 4) {
      const wait = attempt * 12000;
      console.log(`  retry in ${wait / 1000}s`);
      await sleep(wait);
      return generate(zai, job, attempt + 1);
    }
    return false;
  }
}

async function main() {
  const zai = await ZAI.create();
  let failed = 0;
  for (const job of jobs) {
    const ok = await generate(zai, job);
    if (!ok) failed += 1;
    await sleep(4000); // stay under rate limits
  }
  console.log(`DONE. failed=${failed} total=${jobs.length}`);
  if (failed > 0) process.exitCode = 2;
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
