// Schema parity gate: schema.prisma (SQLite, sandbox) and schema.postgres.prisma
// (production mirror) must describe the IDENTICAL data model. The Vercel build
// generates the Prisma client from the postgres mirror, so any drift here means
// production code references models the generated client does not have (the
// exact failure mode that stranded AgentArtifact / SiteStudioSession /
// SiteStudioMessage out of the mirror once already).
//
// Usage: bun scripts/check-schema-parity.ts   (exit 1 on drift)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function extractModels(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

function norm(body: string): string {
  return body
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const sqlite = extractModels(join(ROOT, "prisma/schema.prisma"));
const pg = extractModels(join(ROOT, "prisma/schema.postgres.prisma"));

const problems: string[] = [];
for (const name of Object.keys(sqlite)) {
  if (!(name in pg)) problems.push(`missing in postgres mirror: ${name}`);
  else if (norm(sqlite[name]) !== norm(pg[name])) problems.push(`model body differs: ${name}`);
}
for (const name of Object.keys(pg)) {
  if (!(name in sqlite)) problems.push(`extra model in postgres mirror: ${name}`);
}

if (problems.length > 0) {
  console.error(`SCHEMA PARITY FAILURE (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix: regenerate the mirror from schema.prisma (swap only the datasource block).");
  process.exit(1);
}

console.log(`SCHEMA PARITY OK — ${Object.keys(sqlite).length} models identical across sqlite + postgres mirror.`);
