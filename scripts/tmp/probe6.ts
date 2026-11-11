import ZAI from "z-ai-web-dev-sdk";
async function main() {
  const zai = await (ZAI as unknown as { create: () => Promise<{ images: { generations: { create: (x: unknown) => Promise<unknown> } } }> }).create();
  const variants: [string, string][] = [
    ["with 'honest cuts'", "A premium dark banner scene. Subject: a documentary film editor — rhythm, restraint, and honest cuts. One dominant focal element."],
    ["with 'precise edits'", "A premium dark banner scene. Subject: a documentary film editor — rhythm, restraint, and precise edits. One dominant focal element."],
  ];
  for (const [label, prompt] of variants) {
    try {
      const r = await zai.images.generations.create({ prompt, size: "2016x864" });
      console.log(label, "OK:", (r as { data?: unknown[] })?.data?.length);
    } catch (e) {
      console.log(label, "REJECTED");
    }
    await new Promise((r2) => setTimeout(r2, 30000));
  }
  process.exit(0);
}
main();
