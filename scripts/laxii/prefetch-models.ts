/**
 * LAXII — prefetch the local subject-segmentation model weights into the
 * project-local cache so jobs never need network at generation time.
 *
 *   bun ./scripts/laxii/prefetch-models.ts
 *
 * Model: Xenova/modnet (portrait matting) — Apache-2.0 (upstream MODNet,
 * ZHKKKe/MODNet, Apache-2.0; ONNX port apache-2.0). This is the ONLY model
 * LAXII ships a download path for; every weight is license-verified.
 */
import path from "path";
import fs from "fs";
import { env, AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";

const CACHE = path.resolve(process.cwd(), "data", "laxii-models");

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  env.cacheDir = CACHE;
  env.localModelPath = CACHE;
  console.log("model cache:", CACHE);

  const model = await AutoModel.from_pretrained("Xenova/modnet", { dtype: "fp32" });
  await AutoProcessor.from_pretrained("Xenova/modnet");
  console.log("model + processor cached OK");

  // Smoke test: matte a tiny synthetic image to prove the runtime works.
  const probe = await RawImage.read(
    path.resolve(process.cwd(), "scripts/laxii/segmentation-probe.png")
  ).catch(() => null);
  if (probe) {
    const processor = await AutoProcessor.from_pretrained("Xenova/modnet");
    const { pixel_values } = await processor(probe);
    const { output } = await model({ input: pixel_values });
    console.log("probe matte output dims:", output.dims?.join("x") ?? "ok");
  }
  console.log("DONE");
}

main().catch((e) => {
  console.error("PREFETCH FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
