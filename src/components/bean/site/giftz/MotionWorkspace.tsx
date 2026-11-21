"use client";

/**
 * GIFTZ Motion workspace (M15 §7 + M16 §5) — the animation configuration
 * editor mounted as the GIFTZ canvas "Motion" tab.
 *
 * Smallest appropriate extension of the existing GIFTZ interface: a viewer +
 * editor for the site's motion.gsap (GSAP preset registry) and
 * backgroundEffects (Vanta effect registry) blocks, plus the REAL file-based
 * preview (owner-only preview route, same-origin-free sandboxed iframe) with
 * a reduced-motion preview toggle (?motion=static — the generated runtime's
 * own override, the same switch a visitor's OS preference triggers).
 *
 * Saving routes through the existing PUT /api/giftz/sites/[id] contract:
 * the deterministic compiler (sync rule S1) then re-emits assets/motion.js,
 * the local vendor files and the <script> tags — this editor never writes
 * animation code by hand, and user/ai-authored files keep their provenance.
 */

import { useMemo, useState } from "react";
import { Boxes, RefreshCw, Save, Sparkles, Trash2, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GSAP_EASING_IDS,
  GSAP_MOTION_PRESETS,
  VANTA_EFFECTS,
  getGsapMotionPreset,
  type GsapAnimationSpec,
  type GsapMotionBlock,
  type GsapTargetElement,
} from "@/lib/giftz/motion-engine";
import {
  SCENE3D_OBJECT_KINDS,
  defaultScene3dBlock,
  type Scene3dBlock,
  type Scene3dObjectSpec,
  type Scene3dSceneSpec,
} from "@/lib/giftz/scene3d";
import type { SiteConfig } from "@/lib/site-config";

interface MotionWorkspaceProps {
  siteId: string;
  config: SiteConfig | null;
  saving: boolean;
  onSave: (config: SiteConfig) => Promise<void>;
  refreshToken: number;
}

const TARGET_ELEMENTS: GsapTargetElement[] = [
  "container", "heading", "text", "cards", "images", "buttons", "nav", "svg", "stats", "children",
];

const DEFAULT_ANIMATION: GsapAnimationSpec = {
  id: "new-animation",
  preset: "fade-up",
  target: { kind: "section", sectionId: "", element: "container" },
  trigger: { type: "scroll", start: "top 85%", end: "+=100%", once: true },
  options: {},
  responsive: { mobile: "full" },
  reducedMotion: "static",
  enabled: true,
};

function kebabId(base: string, taken: Set<string>): string {
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "animation";
  let id = root;
  let n = 2;
  while (taken.has(id)) id = `${root}-${n++}`;
  return id;
}

export function MotionWorkspace({ siteId, config, saving, onSave, refreshToken }: MotionWorkspaceProps) {
  const gsapBlock: GsapMotionBlock = config?.motion.gsap ?? { enabled: false, respectReducedMotion: true, animations: [] };
  const background = config?.backgroundEffects ?? null;
  const scene3dBlock: Scene3dBlock = config?.scene3d ?? defaultScene3dBlock();
  const [draftGsap, setDraftGsap] = useState<GsapMotionBlock>(gsapBlock);
  const [draftBg, setDraftBg] = useState(background);
  const [draftScene3d, setDraftScene3d] = useState<Scene3dBlock>(scene3dBlock);
  const [dirty, setDirty] = useState(false);
  const [reducedPreview, setReducedPreview] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedScene, setExpandedScene] = useState<string | null>(null);

  // Re-hydrate drafts when the site changes or files were re-synced elsewhere.
  const configKey = `${siteId}:${refreshToken}`;
  useMemo(() => {
    setDraftGsap(config?.motion.gsap ?? { enabled: false, respectReducedMotion: true, animations: [] });
    setDraftBg(config?.backgroundEffects ?? null);
    setDraftScene3d(config?.scene3d ?? defaultScene3dBlock());
    setDirty(false);
  }, [configKey]);

  const sectionOptions = useMemo(
    () => (config?.pages ?? []).flatMap((page) => page.sections.map((s) => ({ id: s.id, type: s.type, page: page.name }))),
    [config]
  );

  const markDirty = () => setDirty(true);

  const updateAnimation = (id: string, patch: Partial<GsapAnimationSpec>) => {
    setDraftGsap((block) => ({
      ...block,
      animations: block.animations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
    markDirty();
  };

  const updateOption = (id: string, key: string, raw: string) => {
    setDraftGsap((block) => ({
      ...block,
      animations: block.animations.map((a) => {
        if (a.id !== id) return a;
        if (raw.trim() === "") {
          const { [key]: _removed, ...rest } = a.options as Record<string, unknown>;
          return { ...a, options: rest };
        }
        const parsed = Number(raw);
        return { ...a, options: { ...(a.options as Record<string, unknown>), [key]: Number.isFinite(parsed) && raw.trim() !== "" ? parsed : raw } };
      }),
    }));
    markDirty();
  };

  const addAnimation = () => {
    const taken = new Set(draftGsap.animations.map((a) => a.id));
    const firstSection = sectionOptions[0]?.id ?? "";
    const next: GsapAnimationSpec = {
      ...DEFAULT_ANIMATION,
      id: kebabId("hero-motion", taken),
      target: { kind: "section", sectionId: firstSection, element: "container" },
    };
    setDraftGsap((block) => ({ ...block, animations: [...block.animations, next] }));
    setExpanded(next.id);
    markDirty();
  };

  const removeAnimation = (id: string) => {
    setDraftGsap((block) => ({ ...block, animations: block.animations.filter((a) => a.id !== id) }));
    markDirty();
  };

  // ---- scene3d helpers (GZ-3) -------------------------------------------
  const updateScene = (id: string, patch: Partial<Scene3dSceneSpec>) => {
    setDraftScene3d((block) => ({
      ...block,
      scenes: block.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
    markDirty();
  };

  const addScene = () => {
    if (draftScene3d.scenes.length >= 3) return;
    const taken = new Set(draftScene3d.scenes.map((s) => s.id));
    const next: Scene3dSceneSpec = {
      id: kebabId("scene-3d", taken),
      target: { kind: "hero" },
      camera: { fov: 55, position: { x: 0, y: 0, z: 6 } },
      objects: [
        {
          id: "primary-shape",
          kind: "icosahedron",
          position: { x: 0, y: 0, z: 0 },
          scale: 1,
          material: { kind: "standard", color: "#e5c878", metalness: 0.2, roughness: 0.5 },
          animation: { kind: "rotate", speed: 0.4, axis: "y" },
        },
        {
          id: "satellite-shape",
          kind: "torus",
          position: { x: 2.2, y: 0.4, z: -0.6 },
          scale: 0.8,
          material: { kind: "standard", color: "#8a6d3b", metalness: 0.3, roughness: 0.6 },
          animation: { kind: "orbit", speed: 0.3, radius: 2.2 },
        },
      ],
      interactions: { pointer: "parallax", hover: "scale" },
      scroll: { mode: "cameraDolly", strength: 0.5 },
      quality: { mobile: "reduced", maxPixelRatio: 1.5 },
    };
    setDraftScene3d((block) => ({ ...block, scenes: [...block.scenes, next] }));
    setExpandedScene(next.id);
    markDirty();
  };

  const removeScene = (id: string) => {
    setDraftScene3d((block) => ({ ...block, scenes: block.scenes.filter((s) => s.id !== id) }));
    markDirty();
  };

  const updateObject = (sceneId: string, objectId: string, patch: Partial<Scene3dObjectSpec>) => {
    setDraftScene3d((block) => ({
      ...block,
      scenes: block.scenes.map((s) =>
        s.id === sceneId
          ? { ...s, objects: s.objects.map((o) => (o.id === objectId ? { ...o, ...patch } : o)) }
          : s
      ),
    }));
    markDirty();
  };

  const addObject = (scene: Scene3dSceneSpec) => {
    if (scene.objects.length >= 24) return;
    const taken = new Set(scene.objects.map((o) => o.id));
    const next: Scene3dObjectSpec = {
      id: kebabId("shape", taken),
      kind: "sphere",
      position: { x: -1.8, y: 0.2, z: 0 },
      scale: 0.9,
      material: { kind: "standard", color: "#c9a55c", metalness: 0.2, roughness: 0.55 },
      animation: { kind: "float", speed: 0.5 },
    };
    updateScene(scene.id, { objects: [...scene.objects, next] });
    markDirty();
  };

  const removeObject = (sceneId: string, objectId: string) => {
    updateScene(sceneId, {
      objects: (draftScene3d.scenes.find((s) => s.id === sceneId)?.objects ?? []).filter((o) => o.id !== objectId),
    });
    markDirty();
  };

  const sceneNumber = (
    value: number | undefined,
    fallback: number,
    min: number,
    max: number,
    onCommit: (n: number) => void,
    label: string
  ) => (
    <div>
      <Label className="text-[10px]">{label}</Label>
      <Input
        className="h-7 text-[11px]"
        type="number"
        min={min}
        max={max}
        step="any"
        value={typeof value === "number" ? value : fallback}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
        aria-label={label}
      />
    </div>
  );

  const save = async () => {
    if (!config) return;
    setError(null);
    const candidate: SiteConfig = {
      ...config,
      motion: { ...config.motion, gsap: draftGsap },
      backgroundEffects: draftBg ?? undefined,
      scene3d: draftScene3d,
    };
    try {
      await onSave(candidate);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving the motion configuration failed.");
    }
  };

  const previewSrc = `/api/giftz/sites/${encodeURIComponent(siteId)}/preview/index.html?nonce=${previewNonce}${reducedPreview ? "&motion=static" : ""}`;

  if (!config) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Motion configuration belongs to a SAVED generated website — generate and save one in Chat first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[11px] text-muted-foreground">
            GSAP presets + Vanta backgrounds — validated against the motion-engine registry; the compiler generates the runtime and local vendor files.
          </p>
          {dirty ? <Badge variant="outline" className="shrink-0 text-[10px]">unsaved</Badge> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => setPreviewNonce((n) => n + 1)}
            title="Reload the motion preview"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Reload
          </Button>
          <Button size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" onClick={() => void save()} disabled={saving || !dirty}>
            <Save className="size-3.5" aria-hidden /> {saving ? "Saving…" : "Save motion"}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:overflow-hidden">
        {/* editors */}
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto lg:pr-1">
          {/* GSAP engine */}
          <section className="rounded-lg border border-border/60 bg-card p-3" aria-label="GSAP motion engine">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden />
                <h3 className="text-[13px] font-semibold">GSAP motion engine</h3>
                <Switch
                  checked={draftGsap.enabled}
                  onCheckedChange={(v) => {
                    setDraftGsap((b) => ({ ...b, enabled: v }));
                    markDirty();
                  }}
                  aria-label="Enable GSAP motion engine"
                />
              </div>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={addAnimation} disabled={!draftGsap.enabled}>
                Add animation
              </Button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Switch
                checked={draftGsap.respectReducedMotion}
                onCheckedChange={(v) => {
                  setDraftGsap((b) => ({ ...b, respectReducedMotion: v }));
                  markDirty();
                }}
                aria-label="Respect prefers-reduced-motion"
              />
              Respect reduced motion (recommended)
            </label>

            {!draftGsap.enabled ? (
              <p className="mt-2 text-[11px] text-muted-foreground">Disabled — generated sites bundle no animation library.</p>
            ) : draftGsap.animations.length === 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">No animations yet — add one, or ask the chat agent for e.g. “animate my hero title word by word”.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {draftGsap.animations.map((animation) => {
                  const preset = getGsapMotionPreset(animation.preset);
                  const open = expanded === animation.id;
                  return (
                    <li key={animation.id} className="rounded-md border border-border/50 bg-background/50 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setExpanded(open ? null : animation.id)}
                          aria-expanded={open}
                        >
                          <span className="block truncate text-[12px] font-medium">{preset?.name ?? animation.preset}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {animation.target.kind === "section"
                              ? `section ${animation.target.sectionId || "(none)"} · ${animation.target.element}`
                              : animation.target.selector}
                          </span>
                        </button>
                        <Switch
                          checked={animation.enabled}
                          onCheckedChange={(v) => updateAnimation(animation.id, { enabled: v })}
                          aria-label={`Enable animation ${animation.id}`}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeAnimation(animation.id)}
                          aria-label={`Remove animation ${animation.id}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                      {open ? (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div className="col-span-2">
                            <Label className="text-[10px]">Preset</Label>
                            <Select value={animation.preset} onValueChange={(v) => updateAnimation(animation.id, { preset: v })}>
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Animation preset"><SelectValue /></SelectTrigger>
                              <SelectContent className="max-h-64">
                                {GSAP_MOTION_PRESETS.map((p) => (
                                  <SelectItem key={p.id} value={p.id} className="text-[11px]">{p.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-2 grid grid-cols-2 gap-2">
                            <div>
                              <Label className="text-[10px]">Target section</Label>
                              <Select
                                value={animation.target.kind === "section" ? animation.target.sectionId : "__selector__"}
                                onValueChange={(v) => {
                                  if (v === "__selector__") {
                                    updateAnimation(animation.id, { target: { kind: "selector", selector: "" } });
                                  } else {
                                    updateAnimation(animation.id, { target: { kind: "section", sectionId: v, element: animation.target.kind === "section" ? animation.target.element : "container" } });
                                  }
                                }}
                              >
                                <SelectTrigger className="h-7 text-[11px]" aria-label="Target section"><SelectValue /></SelectTrigger>
                                <SelectContent className="max-h-64">
                                  <SelectItem value="__selector__" className="text-[11px]">CSS selector…</SelectItem>
                                  {sectionOptions.map((s) => (
                                    <SelectItem key={s.id} value={s.id} className="text-[11px]">{s.type} · {s.id}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {animation.target.kind === "section" ? (
                              <div>
                                <Label className="text-[10px]">Element</Label>
                                <Select value={animation.target.element} onValueChange={(v) => updateAnimation(animation.id, { target: { kind: "section", sectionId: animation.target.kind === "section" ? animation.target.sectionId : "", element: v as GsapTargetElement } })}>
                                  <SelectTrigger className="h-7 text-[11px]" aria-label="Target element"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {TARGET_ELEMENTS.map((el) => (
                                      <SelectItem key={el} value={el} className="text-[11px]">{el}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            ) : (
                              <div>
                                <Label className="text-[10px]">Selector</Label>
                                <Input
                                  className="h-7 text-[11px]"
                                  value={animation.target.kind === "selector" ? animation.target.selector : ""}
                                  onChange={(e) => updateAnimation(animation.id, { target: { kind: "selector", selector: e.target.value } })}
                                  aria-label="CSS selector"
                                />
                              </div>
                            )}
                          </div>
                          <div>
                            <Label className="text-[10px]">Trigger</Label>
                            <Select
                              value={animation.trigger.type}
                              onValueChange={(v) => updateAnimation(animation.id, { trigger: { ...animation.trigger, type: v as "load" | "scroll" | "interaction" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Trigger"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="scroll" className="text-[11px]">scroll</SelectItem>
                                <SelectItem value="load" className="text-[11px]">load</SelectItem>
                                <SelectItem value="interaction" className="text-[11px]">interaction</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-[10px]">Easing</Label>
                            <Select
                              value={typeof animation.options.easing === "string" ? animation.options.easing : "power2.out"}
                              onValueChange={(v) => updateOption(animation.id, "easing", v)}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Easing"><SelectValue /></SelectTrigger>
                              <SelectContent className="max-h-64">
                                {GSAP_EASING_IDS.map((e) => (
                                  <SelectItem key={e} value={e} className="text-[11px]">{e}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {animation.trigger.type === "scroll" ? (
                            <>
                              <div>
                                <Label className="text-[10px]">Start (ScrollTrigger)</Label>
                                <Input
                                  className="h-7 text-[11px]"
                                  value={animation.trigger.start ?? ""}
                                  placeholder="top 85%"
                                  onChange={(e) => updateAnimation(animation.id, { trigger: { ...animation.trigger, start: e.target.value } })}
                                  aria-label="ScrollTrigger start"
                                />
                              </div>
                              <div>
                                <Label className="text-[10px]">End (ScrollTrigger)</Label>
                                <Input
                                  className="h-7 text-[11px]"
                                  value={animation.trigger.end ?? ""}
                                  placeholder="+=100%"
                                  onChange={(e) => updateAnimation(animation.id, { trigger: { ...animation.trigger, end: e.target.value } })}
                                  aria-label="ScrollTrigger end"
                                />
                              </div>
                            </>
                          ) : null}
                          <div>
                            <Label className="text-[10px]">Duration (ms)</Label>
                            <Input
                              className="h-7 text-[11px]"
                              type="number"
                              min={100}
                              max={6000}
                              value={typeof animation.options.duration === "number" ? animation.options.duration : preset?.defaults.duration ?? 800}
                              onChange={(e) => updateOption(animation.id, "duration", e.target.value)}
                              aria-label="Duration in milliseconds"
                            />
                          </div>
                          <div>
                            <Label className="text-[10px]">Delay (ms)</Label>
                            <Input
                              className="h-7 text-[11px]"
                              type="number"
                              min={0}
                              max={8000}
                              value={typeof animation.options.delay === "number" ? animation.options.delay : preset?.defaults.delay ?? 0}
                              onChange={(e) => updateOption(animation.id, "delay", e.target.value)}
                              aria-label="Delay in milliseconds"
                            />
                          </div>
                          <div>
                            <Label className="text-[10px]">Stagger (ms)</Label>
                            <Input
                              className="h-7 text-[11px]"
                              type="number"
                              min={0}
                              max={900}
                              value={typeof animation.options.stagger === "number" ? animation.options.stagger : preset?.defaults.stagger ?? 0}
                              onChange={(e) => updateOption(animation.id, "stagger", e.target.value)}
                              aria-label="Stagger in milliseconds"
                            />
                          </div>
                          <div>
                            <Label className="text-[10px]">On mobile</Label>
                            <Select
                              value={animation.responsive.mobile}
                              onValueChange={(v) => updateAnimation(animation.id, { responsive: { mobile: v as "full" | "reduced" | "off" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Mobile behaviour"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="full" className="text-[11px]">full</SelectItem>
                                <SelectItem value="reduced" className="text-[11px]">reduced</SelectItem>
                                <SelectItem value="off" className="text-[11px]">off</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <p className="col-span-2 text-[10px] leading-relaxed text-muted-foreground">
                            {preset ? `${preset.description} · reduced motion: ${preset.reducedMotion}` : "Unknown preset — will be rejected by the registry."}
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Vanta background engine */}
          <section className="rounded-lg border border-border/60 bg-card p-3" aria-label="Vanta background engine">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Waves className="size-4 text-primary" aria-hidden />
                <h3 className="text-[13px] font-semibold">Vanta background</h3>
                <Switch
                  checked={draftBg?.enabled ?? false}
                  onCheckedChange={(v) => {
                    setDraftBg((bg) =>
                      bg
                        ? { ...bg, enabled: v }
                        : {
                            enabled: v,
                            engine: "vanta",
                            effect: "FOG",
                            target: { kind: "hero" },
                            settings: {},
                            responsive: { mobile: "reduced" },
                            accessibility: { respectReducedMotion: true },
                            fallback: { kind: "color", value: "#101014" },
                          }
                    );
                    markDirty();
                  }}
                  aria-label="Enable Vanta background engine"
                />
              </div>
            </div>
            {draftBg?.enabled ? (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px]">Effect</Label>
                  <Select value={draftBg.effect} onValueChange={(v) => { setDraftBg((bg) => (bg ? { ...bg, effect: v, settings: {} } : bg)); markDirty(); }}>
                    <SelectTrigger className="h-7 text-[11px]" aria-label="Vanta effect"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {VANTA_EFFECTS.map((effect) => (
                        <SelectItem key={effect.id} value={effect.id} className="text-[11px]">
                          {effect.name} · {effect.performance}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[10px]">Target</Label>
                  <Select value={draftBg.target.kind} onValueChange={(v) => { setDraftBg((bg) => (bg ? { ...bg, target: { kind: v as "page" | "hero" | "section", sectionId: bg.target.sectionId } } : bg)); markDirty(); }}>
                    <SelectTrigger className="h-7 text-[11px]" aria-label="Background target"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="hero" className="text-[11px]">hero</SelectItem>
                      <SelectItem value="page" className="text-[11px]">page</SelectItem>
                      <SelectItem value="section" className="text-[11px]">section…</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {draftBg.target.kind === "section" ? (
                  <div className="col-span-2">
                    <Label className="text-[10px]">Section</Label>
                    <Select value={draftBg.target.sectionId ?? ""} onValueChange={(v) => { setDraftBg((bg) => (bg ? { ...bg, target: { kind: "section", sectionId: v } } : bg)); markDirty(); }}>
                      <SelectTrigger className="h-7 text-[11px]" aria-label="Background section"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-64">
                        {sectionOptions.map((s) => (
                          <SelectItem key={s.id} value={s.id} className="text-[11px]">{s.type} · {s.id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div>
                  <Label className="text-[10px]">Speed</Label>
                  <Input
                    className="h-7 text-[11px]"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="4"
                    value={typeof draftBg.settings.speed === "number" ? draftBg.settings.speed : 1}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setDraftBg((bg) => (bg ? { ...bg, settings: { ...bg.settings, speed: Number.isFinite(value) ? value : 1 } } : bg));
                      markDirty();
                    }}
                    aria-label="Background speed"
                  />
                </div>
                <div>
                  <Label className="text-[10px]">Fallback color</Label>
                  <Input
                    className="h-7 text-[11px]"
                    value={draftBg.fallback.value}
                    onChange={(e) => { setDraftBg((bg) => (bg ? { ...bg, fallback: { ...bg.fallback, value: e.target.value } } : bg)); markDirty(); }}
                    aria-label="Static fallback color"
                  />
                </div>
                <label className="col-span-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Switch
                    checked={draftBg.accessibility.respectReducedMotion}
                    onCheckedChange={(v) => { setDraftBg((bg) => (bg ? { ...bg, accessibility: { respectReducedMotion: v } } : bg)); markDirty(); }}
                    aria-label="Respect reduced motion for the background"
                  />
                  Static fallback for reduced-motion visitors
                </label>
                <p className="col-span-2 text-[10px] leading-relaxed text-muted-foreground">
                  {VANTA_EFFECTS.find((e) => e.id === draftBg.effect)?.description} — three.js + the effect bundle are emitted locally (no CDN); WebGL failures fall back to the static color.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-muted-foreground">Disabled — no WebGL background will be generated.</p>
            )}
          </section>

          {/* 3D scene engine (GZ-3) */}
          <section className="rounded-lg border border-border/60 bg-card p-3" aria-label="3D scene engine">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Boxes className="size-4 text-primary" aria-hidden />
                <h3 className="text-[13px] font-semibold">3D scenes</h3>
                <Switch
                  checked={draftScene3d.enabled}
                  onCheckedChange={(v) => {
                    setDraftScene3d((b) => ({ ...b, enabled: v }));
                    markDirty();
                  }}
                  aria-label="Enable 3D scene engine"
                />
              </div>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={addScene} disabled={!draftScene3d.enabled || draftScene3d.scenes.length >= 3}>
                Add scene
              </Button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Switch
                checked={draftScene3d.respectReducedMotion}
                onCheckedChange={(v) => {
                  setDraftScene3d((b) => ({ ...b, respectReducedMotion: v }));
                  markDirty();
                }}
                aria-label="Respect prefers-reduced-motion for 3D scenes"
              />
              Respect reduced motion (recommended)
            </label>

            {!draftScene3d.enabled ? (
              <p className="mt-2 text-[11px] text-muted-foreground">Disabled — no 3D scenes will be generated.</p>
            ) : draftScene3d.scenes.length === 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                No scenes yet — add one, or ask the chat agent for e.g. “add an interactive 3D hero with floating golden shapes”.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {draftScene3d.scenes.map((scene) => {
                  const open = expandedScene === scene.id;
                  return (
                    <li key={scene.id} className="rounded-md border border-border/50 bg-background/50 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setExpandedScene(open ? null : scene.id)}
                          aria-expanded={open}
                        >
                          <span className="block truncate text-[12px] font-medium">{scene.id}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {scene.target.kind}
                            {scene.target.kind === "section" ? ` · ${scene.target.sectionId ?? "(none)"}` : ""} ·{" "}
                            {scene.objects.length} object{scene.objects.length === 1 ? "" : "s"} · pointer {scene.interactions?.pointer ?? "parallax"}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeScene(scene.id)}
                          aria-label={`Remove 3D scene ${scene.id}`}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                      {open ? (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-[10px]">Target</Label>
                            <Select
                              value={scene.target.kind}
                              onValueChange={(v) => updateScene(scene.id, { target: { kind: v as "page" | "hero" | "section", sectionId: scene.target.sectionId } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Scene target"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="hero" className="text-[11px]">hero</SelectItem>
                                <SelectItem value="page" className="text-[11px]">page</SelectItem>
                                <SelectItem value="section" className="text-[11px]">section…</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {scene.target.kind === "section" ? (
                            <div>
                              <Label className="text-[10px]">Section</Label>
                              <Select
                                value={scene.target.sectionId ?? ""}
                                onValueChange={(v) => updateScene(scene.id, { target: { kind: "section", sectionId: v } })}
                              >
                                <SelectTrigger className="h-7 text-[11px]" aria-label="Scene section"><SelectValue /></SelectTrigger>
                                <SelectContent className="max-h-64">
                                  {sectionOptions.map((s) => (
                                    <SelectItem key={s.id} value={s.id} className="text-[11px]">{s.type} · {s.id}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          ) : (
                            <div>
                              <Label className="text-[10px]">Camera FOV</Label>
                              <Input
                                className="h-7 text-[11px]"
                                type="number"
                                min={20}
                                max={100}
                                value={scene.camera?.fov ?? 55}
                                onChange={(e) => {
                                  const parsed = Number(e.target.value);
                                  if (Number.isFinite(parsed)) {
                                    const cam = scene.camera ?? { position: { x: 0, y: 0, z: 6 } };
                                    updateScene(scene.id, { camera: { ...cam, fov: parsed } });
                                  }
                                }}
                                aria-label="Camera field of view"
                              />
                            </div>
                          )}
                          {(["x", "y", "z"] as const).map((axis) =>
                            sceneNumber(
                              scene.camera?.position?.[axis],
                              { x: 0, y: 0, z: 6 }[axis],
                              -40,
                              40,
                              (n) => {
                                const base = scene.camera?.position ?? { x: 0, y: 0, z: 6 };
                                updateScene(scene.id, { camera: { ...(scene.camera ?? { fov: 55 }), position: { ...base, [axis]: n } } });
                              },
                              `Camera ${axis.toUpperCase()}`
                            )
                          )}

                          <div className="col-span-2">
                            <div className="flex items-center justify-between">
                              <Label className="text-[10px]">Objects ({scene.objects.length}/24)</Label>
                              <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => addObject(scene)} disabled={scene.objects.length >= 24}>
                                Add object
                              </Button>
                            </div>
                            <ul className="mt-1 flex flex-col gap-1.5">
                              {scene.objects.map((object) => (
                                <li key={object.id} className="rounded border border-border/40 bg-card/60 p-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <Input
                                      className="h-6 w-28 text-[10px] font-mono"
                                      value={object.id}
                                      readOnly
                                      aria-label="Object id"
                                      title={object.id}
                                    />
                                    <Select value={object.kind} onValueChange={(v) => updateObject(scene.id, object.id, { kind: v as Scene3dObjectSpec["kind"] })}>
                                      <SelectTrigger className="h-6 flex-1 text-[10px]" aria-label="Object geometry"><SelectValue /></SelectTrigger>
                                      <SelectContent className="max-h-56">
                                        {SCENE3D_OBJECT_KINDS.map((k) => (
                                          <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                      onClick={() => removeObject(scene.id, object.id)}
                                      aria-label={`Remove object ${object.id}`}
                                    >
                                      <Trash2 className="size-3" aria-hidden />
                                    </Button>
                                  </div>
                                  <div className="mt-1 grid grid-cols-3 gap-1.5">
                                    {(["x", "y", "z"] as const).map((axis) =>
                                      sceneNumber(
                                        object.position?.[axis],
                                        0,
                                        -40,
                                        40,
                                        (n) => updateObject(scene.id, object.id, { position: { ...(object.position ?? { x: 0, y: 0, z: 0 }), [axis]: n } }),
                                        `Pos ${axis.toUpperCase()}`
                                      )
                                    )}
                                  </div>
                                  <div className="mt-1 grid grid-cols-3 gap-1.5">
                                    {sceneNumber(object.scale, 1, 0.05, 12, (n) => updateObject(scene.id, object.id, { scale: n }), "Scale")}
                                    {sceneNumber(object.animation?.speed, 0.6, 0.05, 3, (n) => updateObject(scene.id, object.id, { animation: { ...(object.animation ?? { kind: "none" }), speed: n } }), "Anim speed")}
                                    <div>
                                      <Label className="text-[10px]">Animation</Label>
                                      <Select
                                        value={object.animation?.kind ?? "none"}
                                        onValueChange={(v) => updateObject(scene.id, object.id, { animation: { ...(object.animation ?? { speed: 0.6 }), kind: v as NonNullable<Scene3dObjectSpec["animation"]>["kind"] } })}
                                      >
                                        <SelectTrigger className="h-7 text-[11px]" aria-label="Object animation"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {(["none", "rotate", "float", "pulse", "orbit"] as const).map((k) => (
                                            <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                  <div className="mt-1 grid grid-cols-2 gap-1.5">
                                    <div>
                                      <Label className="text-[10px]">Color</Label>
                                      <Input
                                        className="h-7 text-[11px] font-mono"
                                        value={object.material?.color ?? "#e5c878"}
                                        onChange={(e) => updateObject(scene.id, object.id, { material: { ...(object.material ?? { kind: "standard" }), color: e.target.value } })}
                                        aria-label="Object color"
                                      />
                                    </div>
                                    <label className="flex items-end gap-2 pb-1 text-[10px] text-muted-foreground">
                                      <Switch
                                        checked={object.material?.wireframe ?? false}
                                        onCheckedChange={(v) => updateObject(scene.id, object.id, { material: { ...(object.material ?? { kind: "standard" }), wireframe: v } })}
                                        aria-label={`Wireframe ${object.id}`}
                                      />
                                      Wireframe
                                    </label>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div>
                            <Label className="text-[10px]">Pointer</Label>
                            <Select
                              value={scene.interactions?.pointer ?? "parallax"}
                              onValueChange={(v) => updateScene(scene.id, { interactions: { ...(scene.interactions ?? { hover: "none" }), pointer: v as "none" | "parallax" | "rotate" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Pointer interaction"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(["none", "parallax", "rotate"] as const).map((k) => (
                                  <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-[10px]">Hover</Label>
                            <Select
                              value={scene.interactions?.hover ?? "none"}
                              onValueChange={(v) => updateScene(scene.id, { interactions: { ...(scene.interactions ?? { pointer: "none" }), hover: v as "none" | "scale" | "spin" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Hover interaction"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(["none", "scale", "spin"] as const).map((k) => (
                                  <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-[10px]">Scroll camera</Label>
                            <Select
                              value={scene.scroll?.mode ?? "none"}
                              onValueChange={(v) => updateScene(scene.id, { scroll: { ...(scene.scroll ?? { strength: 0.5 }), mode: v as "none" | "cameraDolly" | "cameraOrbit" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Scroll interaction"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(["none", "cameraDolly", "cameraOrbit"] as const).map((k) => (
                                  <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-[10px]">On mobile</Label>
                            <Select
                              value={scene.quality?.mobile ?? "reduced"}
                              onValueChange={(v) => updateScene(scene.id, { quality: { ...(scene.quality ?? { maxPixelRatio: 1.5 }), mobile: v as "full" | "reduced" | "off" } })}
                            >
                              <SelectTrigger className="h-7 text-[11px]" aria-label="Mobile quality"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {(["full", "reduced", "off"] as const).map((k) => (
                                  <SelectItem key={k} value={k} className="text-[11px]">{k}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-2">
                            <Label className="text-[10px]">Fallback (no-WebGL background)</Label>
                            <Input
                              className="h-7 text-[11px] font-mono"
                              placeholder="optional, e.g. #101014"
                              value={scene.fallback?.value ?? ""}
                              onChange={(e) => {
                                const value = e.target.value;
                                updateScene(scene.id, {
                                  fallback: value.trim() ? { kind: scene.fallback?.kind ?? "color", value } : undefined,
                                });
                              }}
                              aria-label="Scene fallback color"
                            />
                          </div>
                          <p className="col-span-2 text-[10px] leading-relaxed text-muted-foreground">
                            Decorative three.js overlay on “{scene.target.kind}” — pointer-events: none, disposed on pagehide; reduced-motion / no-WebGL visitors see the page content unchanged.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* live file-based preview */}
        <section className="flex min-h-0 flex-col gap-2" aria-label="Motion preview">
          <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            <Switch checked={reducedPreview} onCheckedChange={setReducedPreview} aria-label="Reduced-motion preview" />
            Reduced-motion preview (?motion=static)
          </label>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-background">
            <iframe
              key={`${previewSrc}`}
              src={previewSrc}
              sandbox="allow-scripts"
              className="h-full min-h-[320px] w-full"
              title="Generated website motion preview"
            />
          </div>
          <p className="shrink-0 text-[10px] leading-relaxed text-muted-foreground">
            This is the REAL compiled output served through the platform preview (CSP-isolated). Save motion changes to regenerate it; with JavaScript disabled or GSAP unavailable, all content stays fully visible.
          </p>
        </section>
      </div>
    </div>
  );
}

export default MotionWorkspace;
