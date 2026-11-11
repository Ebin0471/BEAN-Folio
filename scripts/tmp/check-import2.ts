for (const m of ["@/lib/laxii/jobs", "@/lib/laxii/service", "@/lib/laxii/router", "@/lib/laxii/banner-pipeline", "@/lib/laxii/intent", "@/lib/laxii/styles"]) {
  try { await import(m); console.log("OK  ", m); }
  catch (e) { console.log("FAIL", m, "-", e instanceof Error ? e.message.slice(0, 120) : e); }
}
