# GIFTZ Effect Registry (Vanta)

Source: `VANTA_EFFECTS` in `src/lib/giftz/motion-engine.ts`. Verification test: `tests/giftz-motion-engine.test.ts > Vanta effect registry`.

**Verification method (M16 §3):** each effect's dist file must exist in the installed `node_modules/vanta/dist/` (registry test) AND its settings schema is derived from the actual `prototype.defaultOptions` extracted from that dist file — no invented options.

| id | Name | Engine | Performance | Mobile | Settings allowlist (beyond common controls) |
|---|---|---|---|---|---|
| FOG | Fog | three | moderate | reduced | highlightColor, midtoneColor, lowlightColor, baseColor, blurFactor (0.1-1), speed, zoom |
| NET | Network | three | light | supported | color, backgroundColor, points, maxDistance, spacing, showDots |
| WAVES | Waves | three | moderate | reduced | color, shininess, waveHeight, waveSpeed, zoom |
| GLOBE | Globe | three | heavy | reduced | color, color2, size, backgroundColor, showDots |
| BIRDS | Birds | three | heavy | avoid | color1, color2, backgroundColor, colorMode("varianceGradient"), birdSize, wingSpan, speedLimit, separation, alignment, cohesion, quantity |
| CELLS | Cells | three | moderate | reduced | color1, color2, backgroundColor, amplitudeFactor, ringFactor, rotationFactor, size, speed |
| DOTS | Dots | three | light | supported | color, color2, backgroundColor, size, spacing, showLines |
| RINGS | Rings | three | light | supported | backgroundColor, color |
| TOPOLOGY | Topology | three | light | supported | color, backgroundColor |
| TRUNK | Trunk | three | moderate | reduced | color, backgroundColor, spacing, chaos |
| CLOUDS | Clouds (shader) | three | heavy | avoid | backgroundColor, skyColor, cloudColor, cloudShadowColor, sunColor, sunGlareColor, sunlightColor, speed, mouseEase |
| CLOUDS2 | Clouds (textured) | three | heavy | avoid | backgroundColor, skyColor, cloudColor, lightColor, speed — **requires local texture** (compiler emits `assets/vendor/noise.png`) |
| RIPPLE | Ripple | three | moderate | reduced | color1, color2, backgroundColor, amplitudeFactor, ringFactor, rotationFactor, speed |

Common controls on every effect (VantaBase): `mouseControls`, `touchControls`, `gyroControls` (booleans), `minHeight`, `minWidth` (integers), `scale`, `scaleMobile` (0.2-8 / 0.2-16). Colors are `#rgb`/`#rrggbb` hex strings; the runtime converts to Vanta's numeric form.

## Deliberately NOT exposed

- **HALO** — the installed 0.5.24 dist carries no verifiable `defaultOptions` for it; per the spec ("Do not invent unsupported configuration options") it stays unexposed and documented here.
- **P5-based variants** — none of the installed effects require p5; the engine field is uniformly `three`, so no p5 runtime is ever bundled.

## Cleanup method (every effect)

`effect.destroy()` — removes the canvas, all window listeners (mousemove/touch/gyro/resize), cancels the render loop and disposes the scene graph (VantaBase.destroy, verified in the dist source). The generated runtime registers exactly one `destroy()` per site in its `pagehide` cleanup chain.
