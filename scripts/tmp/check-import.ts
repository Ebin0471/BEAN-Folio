try {
  const m = await import("@/lib/laxii/types");
  console.log("types loaded, has LaxiiError:", "LaxiiError" in m);
} catch (e) {
  console.log("types import failed:", e instanceof Error ? e.message : e);
}
try {
  const m2 = await import("@/lib/laxii/conversations");
  console.log("conversations loaded OK, exports:", Object.keys(m2).length);
} catch (e) {
  console.log("conversations import failed:", e instanceof Error ? e.message.slice(0, 200) : e);
}
try {
  const m3 = await import("@/lib/laxii/pipeline/segment");
  console.log("segment loaded OK");
} catch (e) {
  console.log("segment import failed:", e instanceof Error ? e.message.slice(0, 200) : e);
}
