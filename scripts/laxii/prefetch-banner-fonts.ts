/**
 * LAXII banner typography — provisioned font prefetch (M33.4-B).
 *
 * Downloads the pinned, licence-audited font set used for SERVER-SIDE
 * deterministic typography rendering into `data/laxii-fonts/` (tracked in
 * git — the sandbox must not depend on network at generation time), then
 * installs the files into the per-user fontconfig directory and refreshes
 * the cache so librsvg/Pango (sharp's SVG rasterizer) can resolve the real
 * families by name.
 *
 * Licence policy: every provisioned family carries its own SIL Open Font
 * License 1.1 text (downloaded next to the font file, tracked in git).
 * Fontsource-style tooling licences do NOT cover the font files — each
 * family's own OFL.txt is the licence of record (Guide §5 Stage-Typography
 * rule 7). OFL permits embedding, bundling and server-side rendering with
 * attribution; the licence files ship alongside the binaries.
 *
 * The runtime NEVER downloads at generation time: `ensureBannerFontsInstalled`
 * (src/lib/laxii/font-assets.ts) only copies already-tracked files into the
 * fontconfig dir when they are missing.
 *
 * Idempotent: files already present with the pinned sha256 are kept.
 *
 * Run: bun scripts/laxii/prefetch-banner-fonts.ts
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_FONTS_ROOT = path.resolve(process.cwd(), "data", "laxii-fonts");
const RAW_BASE = "https://raw.githubusercontent.com/google/fonts/main";

/** Pinned set — sha256 of every tracked binary (verified by this script). */
const PINNED: { dir: string; file: string; sha256: string; url: string; licenceUrl: string }[] = [
  { dir: "fraunces", file: "font.ttf", sha256: "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb", url: `${RAW_BASE}/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf`, licenceUrl: `${RAW_BASE}/ofl/fraunces/OFL.txt` },
  { dir: "inter", file: "font.ttf", sha256: "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031", url: `${RAW_BASE}/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf`, licenceUrl: `${RAW_BASE}/ofl/inter/OFL.txt` },
  { dir: "anton", file: "font.ttf", sha256: "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab", url: `${RAW_BASE}/ofl/anton/Anton-Regular.ttf`, licenceUrl: `${RAW_BASE}/ofl/anton/OFL.txt` },
  { dir: "oswald", file: "font.ttf", sha256: "5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817", url: `${RAW_BASE}/ofl/oswald/Oswald%5Bwght%5D.ttf`, licenceUrl: `${RAW_BASE}/ofl/oswald/OFL.txt` },
  { dir: "lato", file: "font.ttf", sha256: "d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251", url: `${RAW_BASE}/ofl/lato/Lato-Regular.ttf`, licenceUrl: `${RAW_BASE}/ofl/lato/OFL.txt` },
  { dir: "lato", file: "bold.ttf", sha256: "8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1", url: `${RAW_BASE}/ofl/lato/Lato-Bold.ttf`, licenceUrl: `${RAW_BASE}/ofl/lato/OFL.txt` },
  { dir: "lato", file: "black.ttf", sha256: "808c62839c62dbce7de689af7603666fc7f8b81e0df537d8a5212c87580d4337", url: `${RAW_BASE}/ofl/lato/Lato-Black.ttf`, licenceUrl: `${RAW_BASE}/ofl/lato/OFL.txt` },
  { dir: "merriweather", file: "font.ttf", sha256: "d0ed0e359e396af7ad05e73dffd11a3a4c326ea0d0283c56bd9361cb2cc86a96", url: `${RAW_BASE}/ofl/merriweather/Merriweather%5Bopsz%2Cwdth%2Cwght%5D.ttf`, licenceUrl: `${RAW_BASE}/ofl/merriweather/OFL.txt` },
  { dir: "caveat", file: "font.ttf", sha256: "0bdb6b660482d31531b3945849fba5916b3ef8695da7024a9e6b9ee3c4157988", url: `${RAW_BASE}/ofl/caveat/Caveat%5Bwght%5D.ttf`, licenceUrl: `${RAW_BASE}/ofl/caveat/OFL.txt` },
  { dir: "pacifico", file: "font.ttf", sha256: "5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701", url: `${RAW_BASE}/ofl/pacifico/Pacifico-Regular.ttf`, licenceUrl: `${RAW_BASE}/ofl/pacifico/OFL.txt` },
  { dir: "kalam", file: "font.ttf", sha256: "57cecb63d4608019371954274ae1d8c397764debd5b19d4a33c1efa4dc923c0b", url: `${RAW_BASE}/ofl/kalam/Kalam-Regular.ttf`, licenceUrl: `${RAW_BASE}/ofl/kalam/OFL.txt` },
];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  let ok = 0;
  let missing = 0;
  for (const entry of PINNED) {
    const file = path.join(REPO_FONTS_ROOT, entry.dir, entry.file);
    const licence = path.join(REPO_FONTS_ROOT, entry.dir, "OFL.txt");
    if (existsSync(file)) {
      const actual = sha256(readFileSync(file));
      if (actual !== entry.sha256) {
        console.error(`SHA MISMATCH for ${entry.dir}/${entry.file}: expected ${entry.sha256}, got ${actual} — refusing.`);
        process.exit(1);
      }
      ok += 1;
    } else {
      console.log(`downloading ${entry.dir}/${entry.file} …`);
      const res = await fetch(entry.url);
      if (!res.ok) {
        console.error(`DOWNLOAD FAILED for ${entry.dir}: HTTP ${res.status} from ${entry.url}`);
        missing += 1;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha256(buf) !== entry.sha256) {
        console.error(`downloaded bytes do not match the pinned sha256 for ${entry.dir} — refusing to install.`);
        process.exit(1);
      }
      mkdirSync(path.dirname(file), { recursive: true });
      (await import("node:fs")).writeFileSync(file, buf);
      ok += 1;
    }
    if (!existsSync(licence) || statSync(licence).size < 200) {
      console.error(`licence text missing for ${entry.dir} (${entry.licenceUrl}) — every family ships its own OFL.txt.`);
      process.exit(1);
    }
  }
  console.log(`pinned font set verified: ${ok}/${PINNED.length} binaries sha256-checked, OFL texts present.`);
  if (missing > 0) {
    console.error(`${missing} downloads failed — install the missing files manually and re-run.`);
    process.exit(1);
  }
}

main();
