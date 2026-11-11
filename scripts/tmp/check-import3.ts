for (const m of ["@/lib/laxii/engine", "@/lib/laxii/conversations", "@/lib/laxii/pipeline/segment", "@/lib/laxii/providers/capabilities"]) {
  try { await import(m); console.log("OK  ", m); }
  catch (e) { console.log("FAIL", m, "-", e instanceof Error ? e.message.slice(0, 140) : e); }
}
