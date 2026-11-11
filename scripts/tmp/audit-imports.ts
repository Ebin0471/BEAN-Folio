import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import path from "path";

const roots = ["src/lib/laxii", "src/lib/ai-design", "src/app/api/laxii", "src/app/api/ai", "tests"];
const files: string[] = [];
function walk(dir: string) {
  try {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e) && !e.endsWith(".d.ts")) files.push(p);
    }
  } catch {}
}
roots.forEach(walk);

function exportsOf(modPath: string): Set<string> {
  const abs = modPath.startsWith("@/") ? path.join(process.cwd(), "src", modPath.slice(2)) : path.resolve(path.dirname(CURRENT), modPath);
  for (const cand of [abs, abs + ".ts", abs + ".tsx", path.join(abs, "index.ts")]) {
    if (existsSync(cand) && !existsSync(cand) === false) {
      try {
        const src = readFileSync(cand, "utf8");
        const names = new Set<string>();
        for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_]+)/g)) names.add(m[1]);
        for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(",").forEach((s) => names.add(s.trim().split(/\s+as\s+/).pop()!.trim()));
        return names;
      } catch {}
    }
  }
  return new Set();
}

let CURRENT = "";
let issues = 0;
for (const f of files) {
  CURRENT = f;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const spec = m[2];
    if (!spec.startsWith(".") && !spec.startsWith("@/lib/laxii") && !spec.startsWith("@/lib/ai-design") && !spec.startsWith("@/lib/intelligence")) continue;
    const names = m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const exp = exportsOf(spec);
    for (const n of names) {
      if (exp.size && !exp.has(n)) { console.log(`${f}: "${n}" NOT exported by ${spec}`); issues++; }
    }
  }
}
console.log(`--- ${issues} potentially missing named imports`);
