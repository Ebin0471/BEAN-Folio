/**
 * Tiny local server for the round-trip PoC harness (port 3102, loopback).
 * Serves the harness, the sample GIFTZ page/style, and the PINNED grapesjs
 * dist bundle straight from node_modules. Never exposed publicly.
 */
import { serve } from "bun";

const ROOT = new URL(".", import.meta.url).pathname;
const GRAPES = new URL("../../../node_modules/grapesjs/dist/grapes.min.js", import.meta.url).pathname;

serve({
  port: 3102,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") return new Response(Bun.file(`${ROOT}harness.html`));
    if (path === "/sample-page.html") return new Response(Bun.file(`${ROOT}sample-page.html`));
    if (path === "/sample-style.css") return new Response(Bun.file(`${ROOT}sample-style.css`));
    if (path === "/grapes.min.js") return new Response(Bun.file(GRAPES));
    return new Response("not found", { status: 404 });
  },
});
console.log("round-trip PoC harness: http://localhost:3102 (loopback only)");
