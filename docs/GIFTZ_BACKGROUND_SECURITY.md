# GIFTZ Background Security (M16 §10)

Shared security model with the GSAP Motion Engine — the authoritative document is `docs/GIFTZ_MOTION_SECURITY.md`. This page records the Vanta-specific findings.

## CSP compatibility (verified)

The existing serving CSP is unchanged and compatible:

```
default-src 'none'; img-src * data: blob:; style-src * data: 'unsafe-inline';
font-src * data:; script-src * data: 'unsafe-inline'; connect-src 'none';
form-action 'none'; frame-ancestors *
```

- Local vendor scripts (`assets/vendor/three.min.js`, `assets/vendor/vanta.<effect>.min.js`, `assets/motion.js`) load under `script-src * data: 'unsafe-inline'` with relative URLs — no new origins required.
- `connect-src 'none'` is respected: the exposed Vanta effects perform **no runtime network fetches** (verified by scanning every exposed dist file for URL references). CLOUDS2's texture — the one effect with a texture dependency — is served from the locally generated `assets/vendor/noise.png` via `texturePath`; no remote script/texture is ever loaded.
- No `unsafe-eval` was added and none is needed: Vanta's dist files are plain UMD scripts; the runtime passes only primitive options.

## Iframe sandbox compatibility

- Builder preview: `sandbox="allow-scripts"` (originless) — WebGL contexts work inside originless sandboxed iframes; the preview route serves the same files the published site serves.
- Public viewer: `sandbox="allow-scripts allow-popups allow-forms"` — unchanged.
- The canvas is appended inside the sandboxed document; it cannot reach the parent, storage, or the network.

## Injection surface analysis

| Surface | Control |
|---|---|
| Effect settings | strict per-effect zod allowlists (primitives only; hex color grammar; no functions/objects) |
| Effect id | registry membership check |
| Target | fixed enums (`page`/`hero`/`section`) + sectionId existence check → compiler-emitted `data-gz-section` anchors only |
| Fallback value | CSS color/gradient string constrained by schema; injected via `style.background` (no markup) |
| texturePath | set by the runtime to the local generated asset; never user-configurable |
| Colors | hex → integer conversion in the runtime (no string interpolation into code) |

The AI cannot express an executable option: function-valued settings are unrepresentable in the schema and stripped before the program JSON is generated.

## Vendor integrity

Both libraries are pinned exact (`vanta@0.5.24`, `three@0.134.0`) in `package.json` + lockfile; the compiler copies the dist files from the repo's own `node_modules` at compile time. There is no runtime download path — a compromised CDN could not reach generated sites.

## Limitations (documented, not silently bypassed)

1. Static analysis cannot prove runtime WebGL behavior — browser verification remains mandatory (delivery report records the actual browser results).
2. Vanta pauses rendering when the target is off-screen via its internal `isOnScreen()` check; full `visibilitychange` throttling beyond that is engine-internal (documented, not modified — modifying the vendored file was rejected to keep the provenance chain clean).
3. HALO remains unexposed pending verifiable default options (see the effect registry).
