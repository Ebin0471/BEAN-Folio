/**
 * GIFTZ Structured 3D Scene Engine (GZ-3).
 *
 * A controlled 3D-generation capability layered onto the existing GIFTZ
 * motion architecture — the same design as the GSAP motion engine and the
 * Vanta background engine: STRUCTURED, registry-validated data (site.config.json
 * `scene3d`) compiled by a deterministic compiler into:
 *   - the local pinned three.js vendor file (assets/vendor/three.min.js —
 *     already the Vanta substrate, r134, MIT, no new dependency),
 *   - one generated runtime (assets/scene3d.js) = a fixed, audited
 *     interpreter plus the sanitized scene program embedded as JSON.
 *
 * Safety model (mirrors motion-engine.ts):
 *   - scene data is validated by zod + explicit range bounds; unknown kinds,
 *     out-of-range values and unknown section targets are rejected or
 *     reported — never executed loosely;
 *   - the runtime never evals, never fetches, loads only the local vendor
 *     file and always leaves the page content fully usable when WebGL is
 *     unavailable, the scene fails to initialize, or the visitor prefers
 *     reduced motion (?motion=static forces the static fallback);
 *   - the canvas is decorative (pointer-events: none) — it can never block
 *     clicks or forms; pointer interactions listen on the window;
 *   - everything is disposed on pagehide (rAF, listeners, geometries,
 *     materials, renderer, GPU context).
 *
 * This module is pure (no fs, no db) and is imported by motion-engine.ts,
 * lib/site-config and the server-only exporter — it must not import them.
 */

import { z } from "zod";

// ---------------------------------------------------------------- paths

export const SCENE3D_RUNTIME_PATH = "assets/scene3d.js";

// ---------------------------------------------------------------- primitives

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a #rgb or #rrggbb hex color");

/** Component vector — degrees for rotation, world units for position. */
const vec3Schema = z.object({
  x: z.number().min(-40).max(40),
  y: z.number().min(-40).max(40),
  z: z.number().min(-40).max(40),
});
export type Scene3dVec3 = z.infer<typeof vec3Schema>;

const ZERO: Scene3dVec3 = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------------- objects

export const SCENE3D_OBJECT_KINDS = [
  "box",
  "sphere",
  "torus",
  "cone",
  "cylinder",
  "icosahedron",
  "torusKnot",
  "dodecahedron",
  "ring",
  "plane",
] as const;
export type Scene3dObjectKind = (typeof SCENE3D_OBJECT_KINDS)[number];

const objectAnimationSchema = z
  .object({
    kind: z.enum(["none", "rotate", "float", "pulse", "orbit"]).default("none"),
    /** Cycles/second-ish scalar — 0.05 (very slow) .. 3 (fast). */
    speed: z.number().min(0.05).max(3).optional(),
    /** Orbit radius in world units (orbit animation only). */
    radius: z.number().min(0.2).max(12).optional(),
    /** Rotation/spin axis (rotate animation only). */
    axis: z.enum(["x", "y", "z"]).optional(),
  })
  .strict();

const objectMaterialSchema = z
  .object({
    kind: z.enum(["basic", "standard"]).default("standard"),
    color: hexColor.optional(),
    metalness: z.number().min(0).max(1).optional(),
    roughness: z.number().min(0).max(1).optional(),
    opacity: z.number().min(0.05).max(1).optional(),
    wireframe: z.boolean().optional(),
  })
  .strict();

export const scene3dObjectSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "object id must be kebab-case"),
    kind: z.enum(SCENE3D_OBJECT_KINDS),
    position: vec3Schema.optional(),
    /** Degrees — converted to radians by the runtime. */
    rotation: vec3Schema.optional(),
    /** Uniform scale (0.05 .. 12). */
    scale: z.number().min(0.05).max(12).optional(),
    material: objectMaterialSchema.optional(),
    animation: objectAnimationSchema.optional(),
  })
  .strict();
export type Scene3dObjectSpec = z.infer<typeof scene3dObjectSchema>;

// ---------------------------------------------------------------- lights

export const SCENE3D_LIGHT_KINDS = ["ambient", "directional", "point"] as const;
export type Scene3dLightKind = (typeof SCENE3D_LIGHT_KINDS)[number];

const lightSchema = z
  .object({
    kind: z.enum(SCENE3D_LIGHT_KINDS),
    color: hexColor.optional(),
    intensity: z.number().min(0).max(3).optional(),
    position: vec3Schema.optional(),
  })
  .strict();
export type Scene3dLightSpec = z.infer<typeof lightSchema>;

// ---------------------------------------------------------------- camera / interactions / scroll

const cameraSchema = z
  .object({
    /** Vertical field of view in degrees (20..100). */
    fov: z.number().min(20).max(100).optional(),
    position: vec3Schema.optional(),
    lookAt: vec3Schema.optional(),
  })
  .strict();
export type Scene3dCameraSpec = z.infer<typeof cameraSchema>;

const interactionsSchema = z
  .object({
    /** Pointer-driven camera parallax / scene rotation (window-level listeners). */
    pointer: z.enum(["none", "parallax", "rotate"]).optional(),
    /** Hovered-object feedback (raycast against the scene's own objects). */
    hover: z.enum(["none", "scale", "spin"]).optional(),
  })
  .strict();
export type Scene3dInteractionsSpec = z.infer<typeof interactionsSchema>;

const scrollSchema = z
  .object({
    /** Scroll-linked camera movement — progress is derived from the host's position in the viewport. */
    mode: z.enum(["none", "cameraDolly", "cameraOrbit"]).optional(),
    /** 0..1 — how far the camera moves across the full scroll progress. */
    strength: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Scene3dScrollSpec = z.infer<typeof scrollSchema>;

const qualitySchema = z
  .object({
    mobile: z.enum(["full", "reduced", "off"]).optional(),
    /** Cap on devicePixelRatio used by the renderer (1..2). */
    maxPixelRatio: z.number().min(1).max(2).optional(),
  })
  .strict();
export type Scene3dQualitySpec = z.infer<typeof qualitySchema>;

// ---------------------------------------------------------------- scene + block

export const scene3dTargetSchema = z
  .object({
    kind: z.enum(["page", "hero", "section"]).default("hero"),
    sectionId: z.string().max(64).optional(),
  })
  .strict();
export type Scene3dTarget = z.infer<typeof scene3dTargetSchema>;

export const scene3dSceneSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "scene id must be kebab-case"),
    /** Where the scene mounts. Resolution mirrors backgroundEffects targets. */
    target: scene3dTargetSchema,
    camera: cameraSchema.optional(),
    objects: z.array(scene3dObjectSchema).min(1).max(24),
    lights: z.array(lightSchema).max(4).optional(),
    interactions: interactionsSchema.optional(),
    scroll: scrollSchema.optional(),
    quality: qualitySchema.optional(),
    /** Painted on the host ONLY when the scene cannot run (WebGL off, init failure). */
    fallback: z
      .object({
        kind: z.enum(["color", "gradient"]).default("color"),
        value: hexColor,
      })
      .strict()
      .optional(),
  })
  .strict();
export type Scene3dSceneSpec = z.infer<typeof scene3dSceneSchema>;

export const scene3dBlockSchema = z
  .object({
    enabled: z.boolean().default(false),
    respectReducedMotion: z.boolean().default(true),
    scenes: z.array(scene3dSceneSchema).max(3).default([]),
  })
  .strict();
export type Scene3dBlock = z.infer<typeof scene3dBlockSchema>;

export function defaultScene3dBlock(): Scene3dBlock {
  return scene3dBlockSchema.parse({});
}

// ---------------------------------------------------------------- compiled program

export interface Scene3dSceneProgram {
  id: string;
  selector: string;
  camera: {
    fov: number;
    position: Scene3dVec3;
    lookAt: Scene3dVec3 | null;
  };
  objects: Scene3dObjectSpec[];
  lights: Scene3dLightSpec[];
  interactions: Required<Pick<Scene3dInteractionsSpec, "pointer" | "hover">>;
  scroll: { mode: "none" | "cameraDolly" | "cameraOrbit"; strength: number };
  quality: { mobile: "full" | "reduced" | "off"; maxPixelRatio: number };
  fallback: { kind: "color" | "gradient"; value: string } | null;
  background: "transparent";
}

export interface Scene3dProgram {
  respectReducedMotion: boolean;
  scenes: Scene3dSceneProgram[];
}

export interface Scene3dIssue {
  path: string;
  message: string;
}

export interface Scene3dValidationOutcome<T> {
  ok: boolean;
  issues: Scene3dIssue[];
  value: T | null;
}

/**
 * Validate + sanitize a scene3d block. Mirrors validateBackgroundEffects:
 * unknown section targets and duplicate ids are reported; per-scene shape
 * enforcement happens here so callers never receive malformed scenes.
 */
export function validateScene3dBlock(
  block: Scene3dBlock,
  sectionIds: Set<string>
): Scene3dValidationOutcome<Scene3dBlock> {
  const issues: Scene3dIssue[] = [];
  if (!block.enabled) return { ok: true, issues, value: block };

  const seenSceneIds = new Set<string>();
  const scenes = block.scenes.filter((scene) => {
    if (seenSceneIds.has(scene.id)) {
      issues.push({ path: `scenes.${scene.id}`, message: "duplicate scene id" });
      return false;
    }
    seenSceneIds.add(scene.id);
    if (scene.target.kind === "section") {
      if (!scene.target.sectionId || !sectionIds.has(scene.target.sectionId)) {
        issues.push({
          path: `scenes.${scene.id}.target`,
          message: "target.kind 'section' requires an existing sectionId",
        });
        return false;
      }
    }
    const seenObjectIds = new Set<string>();
    for (const object of scene.objects) {
      if (seenObjectIds.has(object.id)) {
        issues.push({ path: `scenes.${scene.id}.objects.${object.id}`, message: "duplicate object id" });
        return false;
      }
      seenObjectIds.add(object.id);
    }
    return true;
  });

  return { ok: issues.length === 0, issues, value: { ...block, scenes } };
}

/**
 * Resolve a scene target to a concrete CSS selector — the same resolution
 * order as the Vanta background engine (page → .bs-bg-host; hero → the first
 * hero section; section → its data-gz-section anchor).
 */
export function resolveScene3dSelector(
  target: Scene3dTarget,
  sectionIds: Set<string>
): { selector: string | null; issue: string | null } {
  if (target.kind === "page") return { selector: ".bs-bg-host", issue: null };
  if (target.kind === "section") {
    if (target.sectionId && sectionIds.has(target.sectionId)) {
      return { selector: `[data-gz-section="${target.sectionId}"]`, issue: null };
    }
    return { selector: null, issue: "target.kind 'section' requires an existing sectionId" };
  }
  // hero — the first hero section of the site, or the page host as fallback.
  return { selector: "[data-gz-hero]", issue: null };
}

/**
 * Compile the site config's scene3d block into a runtime program. Entries
 * referencing unknown targets are dropped and reported in `issues` — never
 * silently executed.
 */
export function compileScene3dBlock(
  block: Scene3dBlock | undefined,
  sectionIds: Set<string>,
  heroSectionIds: Set<string>
): { scenes: Scene3dSceneProgram[]; issues: Scene3dIssue[] } {
  const issues: Scene3dIssue[] = [];
  if (!block?.enabled || block.scenes.length === 0) return { scenes: [], issues };

  const validation = validateScene3dBlock(block, sectionIds);
  issues.push(...validation.issues.map((i) => ({ path: `scene3d.${i.path}`, message: i.message })));
  if (!validation.value) return { scenes: [], issues };

  const scenes: Scene3dSceneProgram[] = [];
  for (const scene of validation.value.scenes) {
    let selector: string | null = null;
    if (scene.target.kind === "page") {
      selector = ".bs-bg-host";
    } else if (scene.target.kind === "section") {
      if (scene.target.sectionId && sectionIds.has(scene.target.sectionId)) {
        selector = `[data-gz-section="${scene.target.sectionId}"]`;
      } else {
        issues.push({ path: `scene3d.scenes.${scene.id}.target`, message: "section target does not exist" });
        continue;
      }
    } else {
      const heroId = [...heroSectionIds][0];
      selector = heroId ? `[data-gz-section="${heroId}"]` : ".bs-bg-host";
    }
    scenes.push({
      id: scene.id,
      selector,
      camera: {
        fov: scene.camera?.fov ?? 55,
        position: scene.camera?.position ?? { x: 0, y: 0, z: 6 },
        lookAt: scene.camera?.lookAt ?? null,
      },
      objects: scene.objects,
      lights: scene.lights ?? [
        { kind: "ambient", color: "#ffffff", intensity: 0.9 },
        { kind: "directional", color: "#ffffff", intensity: 0.8, position: { x: 3, y: 4, z: 5 } },
      ],
      interactions: {
        pointer: scene.interactions?.pointer ?? "parallax",
        hover: scene.interactions?.hover ?? "none",
      },
      scroll: {
        mode: scene.scroll?.mode ?? "none",
        strength: scene.scroll?.strength ?? 0.5,
      },
      quality: {
        mobile: scene.quality?.mobile ?? "reduced",
        maxPixelRatio: scene.quality?.maxPixelRatio ?? 1.5,
      },
      fallback: scene.fallback ?? null,
      background: "transparent",
    });
  }
  return { scenes, issues };
}

// ---------------------------------------------------------------- runtime generator

const GEOMETRY_TABLE: Record<Scene3dObjectKind, string> = {
  box: "new THREE.BoxGeometry(1.4, 1.4, 1.4)",
  sphere: "new THREE.SphereGeometry(0.9, 24, 16)",
  torus: "new THREE.TorusGeometry(0.85, 0.32, 16, 40)",
  cone: "new THREE.ConeGeometry(0.9, 1.6, 24)",
  cylinder: "new THREE.CylinderGeometry(0.7, 0.7, 1.6, 24)",
  icosahedron: "new THREE.IcosahedronGeometry(0.95, 0)",
  torusKnot: "new THREE.TorusKnotGeometry(0.7, 0.24, 64, 12)",
  dodecahedron: "new THREE.DodecahedronGeometry(0.9, 0)",
  ring: "new THREE.RingGeometry(0.5, 1.0, 32)",
  plane: "new THREE.PlaneGeometry(2.4, 1.6)",
};

function geometryExpression(kind: Scene3dObjectKind): string {
  return GEOMETRY_TABLE[kind] ?? GEOMETRY_TABLE.box;
}

/**
 * Build the generated `assets/scene3d.js` — a fixed, audited three.js
 * interpreter plus the sanitized scene program embedded as JSON. No eval, no
 * network, no CDN; the canvas is decorative and everything is disposed on
 * pagehide.
 */
export function buildScene3dRuntime(program: Scene3dProgram): string {
  const configJson = JSON.stringify({
    respectReducedMotion: program.respectReducedMotion,
    scenes: program.scenes,
  }).replace(/</g, "\\u003c");
  const geometryLiteral = scene3dRuntimeGeometryLiteral();

  return `/* GIFTZ 3D Scene Engine runtime — generated file (interpreter v1).
 * Fixed audited three.js interpreter; the scene program below is sanitized,
 * schema-validated data. No eval, no network, no CDN. The canvas is purely
 * decorative (pointer-events none) and the page content stays fully usable
 * when JS is disabled, three.js fails to load, WebGL is unavailable, or the
 * visitor prefers reduced motion (?motion=static forces the static fallback).
 */
(function () {
  "use strict";
  var CFG = ${configJson};
  var scenesCfg = CFG.scenes || [];
  if (!scenesCfg.length || !window.THREE) return;

  var params = new URLSearchParams(window.location.search);
  var forced = params.get("motion");
  var osReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reduced = (CFG.respectReducedMotion !== false) && (osReduced || forced === "static");
  if (forced === "on") reduced = false;
  if (reduced) return;

  function hasWebGL() {
    try {
      var canvas = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
    } catch (e) { return false; }
  }
  if (!hasWebGL()) { fallbackAll(); return; }

  var instances = [];
  var cleanups = [];

  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function deg2rad(d) { return (d * Math.PI) / 180; }
  function hostOf(selector) {
    try { return document.querySelector(selector); } catch (e) { return null; }
  }

  function paintFallback(host, fallback) {
    if (!host || !fallback || !fallback.value) return;
    host.style.background = fallback.kind === "gradient"
      ? "linear-gradient(135deg, " + fallback.value + ", rgba(0,0,0,0))"
      : fallback.value;
  }
  function fallbackAll() {
    for (var i = 0; i < scenesCfg.length; i++) {
      var host = hostOf(scenesCfg[i].selector);
      if (host) paintFallback(host, scenesCfg[i].fallback);
    }
  }

  function initScene(cfg) {
    var host = hostOf(cfg.selector);
    if (!host) return;

    var isMobile = window.innerWidth < 768;
    if (cfg.quality.mobile === "off" && isMobile) return;

    var canvas = document.createElement("canvas");
    canvas.className = "gz-scene3d-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block;";
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.insertBefore(canvas, host.firstChild);

    var width = Math.max(1, host.clientWidth);
    var height = Math.max(1, host.clientHeight);
    var antialias = !(isMobile && cfg.quality.mobile === "reduced");
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: antialias, powerPreference: "low-power" });
    } catch (e) {
      canvas.remove();
      paintFallback(host, cfg.fallback);
      return;
    }
    var pixelRatioCap = isMobile && cfg.quality.mobile === "reduced" ? 1 : cfg.quality.maxPixelRatio;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.setSize(width, height, false);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(cfg.camera.fov, width / height, 0.1, 100);
    var camBase = {
      x: num(cfg.camera.position.x, 0),
      y: num(cfg.camera.position.y, 0),
      z: num(cfg.camera.position.z, 6),
    };
    camera.position.set(camBase.x, camBase.y, camBase.z);
    if (cfg.camera.lookAt) {
      camera.lookAt(num(cfg.camera.lookAt.x, 0), num(cfg.camera.lookAt.y, 0), num(cfg.camera.lookAt.z, 0));
    }

    // Lights
    var disposed = [];
    (cfg.lights || []).forEach(function (l) {
      var color = new THREE.Color(l.color || "#ffffff");
      var intensity = num(l.intensity, l.kind === "ambient" ? 0.9 : 0.8);
      var light;
      if (l.kind === "ambient") light = new THREE.AmbientLight(color, intensity);
      else if (l.kind === "directional") light = new THREE.DirectionalLight(color, intensity);
      else light = new THREE.PointLight(color, intensity);
      if (l.kind !== "ambient" && l.position) light.position.set(num(l.position.x, 0), num(l.position.y, 0), num(l.position.z, 0));
      scene.add(light);
    });

    // Objects
    var group = new THREE.Group();
    scene.add(group);
    var entries = [];
    (cfg.objects || []).slice(0, 24).forEach(function (spec) {
      var geometryTable = ${geometryLiteral};
      var geometry;
      try { geometry = (geometryTable[spec.kind] || geometryTable.box)(); }
      catch (e) { return; }
      var mat = spec.material || {};
      var params = { color: new THREE.Color(mat.color || "#e5c878"), wireframe: !!mat.wireframe };
      var material;
      if (mat.kind === "basic") {
        material = new THREE.MeshBasicMaterial(params);
      } else {
        material = new THREE.MeshStandardMaterial({
          color: params.color,
          wireframe: params.wireframe,
          metalness: num(mat.metalness, 0.15),
          roughness: num(mat.roughness, 0.55),
          transparent: mat.opacity !== undefined && mat.opacity < 1,
          opacity: num(mat.opacity, 1),
        });
      }
      var mesh = new THREE.Mesh(geometry, material);
      var p = spec.position || { x: 0, y: 0, z: 0 };
      mesh.position.set(num(p.x, 0), num(p.y, 0), num(p.z, 0));
      var r = spec.rotation || { x: 0, y: 0, z: 0 };
      mesh.rotation.set(deg2rad(num(r.x, 0)), deg2rad(num(r.y, 0)), deg2rad(num(r.z, 0)));
      var s = num(spec.scale, 1);
      mesh.scale.setScalar(s);
      group.add(mesh);
      entries.push({ spec: spec, mesh: mesh, material: material, geometry: geometry, baseScale: s, baseY: mesh.position.y, hoverT: 0 });
      disposed.push(geometry, material);
    });

    // Pointer + hover state (window-level listeners; the canvas is pointer-events:none)
    var pointer = { x: 0, y: 0, active: false };
    var raycaster = null, pointerNdc = { x: 0, y: 0 }, hovered = null;
    if (cfg.interactions.pointer !== "none" || cfg.interactions.hover !== "none") {
      raycaster = new THREE.Raycaster();
      var onPointerMove = function (event) {
        pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
        pointer.active = true;
        var rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        }
      };
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      cleanups.push(function () { window.removeEventListener("pointermove", onPointerMove); });
    }

    // Scroll progress across the host's position in the viewport (0..1).
    var scrollProgress = 0;
    function measureScroll() {
      if (cfg.scroll.mode === "none") return;
      var rect = host.getBoundingClientRect();
      var vh = window.innerHeight || 1;
      var total = rect.height + vh;
      scrollProgress = clamp((vh - rect.top) / total, 0, 1);
    }
    window.addEventListener("scroll", measureScroll, { passive: true });
    cleanups.push(function () { window.removeEventListener("scroll", measureScroll); });

    // Pause rendering when the host is off-screen (IntersectionObserver).
    var visible = true;
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) { visible = es[0] && es[0].isIntersecting; }, { threshold: 0.02 });
      io.observe(host);
      cleanups.push(function () { io.disconnect(); });
    }

    var onResize = function () {
      var w = Math.max(1, host.clientWidth);
      var h = Math.max(1, host.clientHeight);
      if (w !== width || h !== height) {
        width = w; height = h;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
      }
    };
    window.addEventListener("resize", onResize);
    cleanups.push(function () { window.removeEventListener("resize", onResize); });

    var instRef = { canvas: canvas, renderer: renderer, disposed: disposed, raf: 0 };
    instances.push(instRef);

    var last = performance.now();
    var raf = 0;
    function tick(now) {
      raf = requestAnimationFrame(tick);
      instRef.raf = raf;
      if (!visible) return;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // object animations
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        var anim = en.spec.animation || { kind: "none" };
        var speed = num(anim.speed, 0.6);
        if (anim.kind === "rotate") {
          var axis = anim.axis || "y";
          en.mesh.rotation[axis] += speed * dt * 1.6;
        } else if (anim.kind === "float") {
          en.mesh.position.y = en.baseY + Math.sin(now / 1000 * speed + i) * 0.22;
        } else if (anim.kind === "pulse") {
          var s = en.baseScale * (1 + Math.sin(now / 1000 * speed + i) * 0.07);
          en.mesh.scale.setScalar(s);
        } else if (anim.kind === "orbit") {
          var radius = num(anim.radius, 2.2);
          var angle = now / 1000 * speed + (i / Math.max(1, entries.length)) * Math.PI * 2;
          en.mesh.position.x = Math.cos(angle) * radius;
          en.mesh.position.z = Math.sin(angle) * radius;
        }
        // hover feedback
        if (cfg.interactions.hover !== "none" && raycaster) {
          var target = hovered === en.mesh ? 1 : 0;
          en.hoverT += (target - en.hoverT) * Math.min(1, dt * 8);
          if (cfg.interactions.hover === "scale" && en.hoverT > 0.001) {
            en.mesh.scale.setScalar(en.baseScale * (1 + en.hoverT * 0.18));
          } else if (cfg.interactions.hover === "spin" && en.hoverT > 0.001) {
            en.mesh.rotation.y += en.hoverT * dt * 2.4;
          }
        }
      }

      // pointer interactions
      if (pointer.active && cfg.interactions.pointer === "parallax") {
        camera.position.x += (camBase.x + pointer.x * 0.55 - camera.position.x) * Math.min(1, dt * 4);
        camera.position.y += (camBase.y + pointer.y * 0.35 - camera.position.y) * Math.min(1, dt * 4);
      } else if (pointer.active && cfg.interactions.pointer === "rotate") {
        group.rotation.y += (pointer.x * 0.5 - group.rotation.y) * Math.min(1, dt * 4);
        group.rotation.x += (-pointer.y * 0.3 - group.rotation.x) * Math.min(1, dt * 4);
      }

      // scroll-linked camera movement
      if (cfg.scroll.mode === "cameraDolly") {
        camera.position.z = camBase.z + scrollProgress * cfg.scroll.strength * 4;
      } else if (cfg.scroll.mode === "cameraOrbit") {
        var theta = scrollProgress * cfg.scroll.strength * Math.PI * 2;
        var radius2 = Math.max(0.1, Math.sqrt(camBase.x * camBase.x + camBase.z * camBase.z));
        camera.position.x = Math.sin(theta) * radius2;
        camera.position.z = Math.cos(theta) * radius2;
        camera.position.y = camBase.y;
      }
      if (cfg.camera.lookAt) {
        camera.lookAt(num(cfg.camera.lookAt.x, 0), num(cfg.camera.lookAt.y, 0), num(cfg.camera.lookAt.z, 0));
      }

      // hover raycast (once per frame, not per object)
      if (cfg.interactions.hover !== "none" && raycaster) {
        raycaster.setFromCamera(pointerNdc, camera);
        var hits = raycaster.intersectObjects(group.children, false);
        var hit = hits && hits[0] ? hits[0].object : null;
        hovered = hit;
      }

      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
  }

  for (var i = 0; i < scenesCfg.length; i++) {
    try { initScene(scenesCfg[i]); } catch (e) {
      console.warn("[GIFTZ] 3D scene init failed — content stays fully usable.", e);
      try { paintFallback(hostOf(scenesCfg[i].selector), scenesCfg[i].fallback); } catch (e2) {}
    }
  }

  function cleanup() {
    cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
    cleanups = [];
    for (var j = 0; j < instances.length; j++) {
      var inst = instances[j];
      try { if (inst.raf) cancelAnimationFrame(inst.raf); } catch (e) {}
      try { inst.renderer.setAnimationLoop(null); } catch (e) {}
      for (var k = 0; k < inst.disposed.length; k++) {
        try { if (inst.disposed[k] && inst.disposed[k].dispose) inst.disposed[k].dispose(); } catch (e) {}
      }
      try { inst.renderer.dispose(); } catch (e) {}
      try { inst.canvas.remove(); } catch (e) {}
    }
    instances = [];
  }
  window.addEventListener("pagehide", cleanup, { once: true });
})();
`;
}

/**
 * The geometry table is inlined into the generated runtime as a literal map
 * of three.js constructor calls (data, not code from user input).
 */
function scene3dRuntimeGeometryLiteral(): string {
  return `{\n${(Object.keys(GEOMETRY_TABLE) as Scene3dObjectKind[])
    .map((kind) => `    ${kind}: function () { return ${GEOMETRY_TABLE[kind]}; }`)
    .join(",\n")}\n  }`;
}

// ---------------------------------------------------------------- capability doc

export function scene3dCapabilityDoc(): string {
  return `STRUCTURED 3D SCENE ENGINE (scene3d in site.config.json)
- Enable with scene3d.enabled=true; add up to 3 scenes to scene3d.scenes.
- Each scene: { id (kebab-case), target: { kind: "page"|"hero"|"section", sectionId? },
  camera: { fov, position {x,y,z}, lookAt {x,y,z} },
  objects: [{ id, kind: box|sphere|torus|cone|cylinder|icosahedron|torusKnot|dodecahedron|ring|plane,
              position {x,y,z}, rotation {x,y,z} (degrees), scale, material { kind basic|standard, color "#rrggbb",
              metalness, roughness, opacity, wireframe },
              animation { kind none|rotate|float|pulse|orbit, speed, radius, axis } }] (1..24),
  lights: [{ kind ambient|directional|point, color, intensity, position }] (0..4),
  interactions: { pointer none|parallax|rotate, hover none|scale|spin },
  scroll: { mode none|cameraDolly|cameraOrbit, strength 0..1 },
  quality: { mobile full|reduced|off, maxPixelRatio 1..2 },
  fallback: { kind color|gradient, value "#rrggbb" } }.
- Colors are hex strings; positions are world units; rotations are degrees.
- The three.js vendor file and the audited runtime (assets/scene3d.js) are generated automatically on config save — NEVER hand-write three.js imports, NEVER reference CDNs, NEVER use eval, NEVER plan to create assets/vendor/* files.
- Scenes are decorative overlays: content stays readable without them (reduced motion, no WebGL and mobile "off" render nothing and never break the page).`;
}
