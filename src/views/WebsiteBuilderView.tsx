"use client";

/**
 * CODE GIFTZ — the website coding studio (the ONE Code Giftz workspace).
 *
 * Two top-level tabs under one compact header, each with INDEPENDENT settings:
 *
 *   CUSTOMIZATION (free visual editor)
 *     LEFT   ContentEditor  — direct content editing (title, tagline, section
 *                             copy/items, profile identity) — no chat needed
 *     CENTER live preview   — the real site canvas (draft + unsaved edits)
 *     RIGHT  StudioRail     — every real design control (templates, colors,
 *                             typography, layout, motion, presentation)
 *
 *   CODE GIFTZ (AI coding workspace)
 *     LEFT   ChatPanel      — conversational website coding (real site-studio
 *                             pipeline: plan → execute → isolated proposal),
 *                             fixed composer, independent conversation scroll
 *     CENTER preview        — ONLY the GENERATED website (isolated proposal);
 *                             the saved portfolio is never shown as a fake
 *                             generated result (honest empty state instead)
 *
 * Both modes edit the SAME authenticated portfolio website (one draft config,
 * one profile identity — never duplicated). Per-mode UI state (device
 * viewport, mobile zone, preview preferences) is stored under SEPARATE
 * persistence keys so no control in one mode can move the other's settings.
 *
 * The former Engineering dashboard (repositories, task history, handoff
 * panels) was removed from the UI; its secure execution backend and the
 * LAXII integration remain available as shared services. Kept from the
 * previous builder: PreviewFrame/DeviceStage, history (undo/redo),
 * localStorage draft recovery, silent server seed, revisions restore,
 * publish/unpublish + canonical URL honesty, export ZIP, watermark PATCH,
 * logo upload.
 */

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CloudUpload,
  Download,
  ExternalLink,
  FileText,
  Globe,
  History,
  Link2,
  Loader2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Palette,
  Plus,
  Redo2,
  RefreshCw,
  Share2,
  Smartphone,
  Sparkles,
  Tablet,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/bean/EmptyState";
import { SiteRenderer } from "@/components/bean/site/SiteRenderer";
import { ChatPanel, type StudioProposal } from "@/components/bean/site/studio/ChatPanel";
import { ContentEditor, type ProfileContentPatch } from "@/components/bean/site/studio/ContentEditor";
import { SaveControls, type ModeSaveStatus, type StudioSaveMode } from "@/components/bean/site/studio/SaveControls";
import { StudioRail } from "@/components/bean/site/studio/StudioRail";
import { summarizeConfigDiff, useLibraryPrefs } from "@/components/bean/site/studio/controls";
import {
  CHAT_WIDTH_PCT_MAX,
  CHAT_WIDTH_PCT_MIN,
  DEFAULT_CHAT_WIDTH_PCT,
  DEFAULT_CUSTOMIZATION_PREFS,
  DEFAULT_GIFTZ_PREFS,
  readModePrefs,
  writeModePrefs,
  type CustomizationPrefs,
  type GiftzPrefs,
  type StudioDevice,
} from "@/components/bean/site/studio/prefs";
import { api, uploadFile } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { copyToClipboard, shareUrl } from "@/lib/share";
import { useSession } from "@/lib/session";
import { categoryLabel, CATEGORY_LABELS } from "@/lib/categories";
import { publicSitePath, portfolioLinkLabel, shareActionUrls } from "@/lib/site-url";
import { cn } from "@/lib/utils";
import {
  defaultConfig,
  designPresets,
  deriveTheme,
  makeSection,
  normalizeConfig,
  normalizeGlass,
  normalizeMotion,
  templatePresets,
} from "@/lib/site-config";
import type { SiteConfig, SitePage, SiteSection, SiteSectionType, SiteTheme, SiteGlass, TemplateId } from "@/lib/site-config";
import { getPalette } from "@/lib/site-palettes";
import type { PublicProfileResponse, SiteDesignDTO, SiteRevisionDTO } from "@/lib/types";

// ------------------------------------------------------------------ preview frame
// Renders the real SiteRenderer inside an iframe so Tailwind breakpoints respond
// to the DEVICE width, not the editor viewport. Config changes re-render the
// children through the existing React root — the iframe itself is never
// reloaded for small edits.

/**
 * Error boundary INSIDE the preview iframe's React root: a rendering error in
 * the site config must surface as an honest, recoverable message — never a
 * silently blank canvas. The boundary resets itself when the children change
 * (new config) so a fixed draft re-renders without a manual reload.
 */
class PreviewErrorBoundary extends Component<
  { children: React.ReactNode; onError?: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[site-preview] render failed:", error);
    this.props.onError?.();
  }
  componentDidUpdate(prev: { children: React.ReactNode }) {
    if (prev.children !== this.props.children && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
          }}
        >
          <div>
            <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Preview hit a rendering error</p>
            <p style={{ fontSize: "0.85rem", opacity: 0.75 }}>
              Your website data is safe — use “Reload preview” above the canvas to try again.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PreviewFrame({
  label,
  children,
  marker,
  refreshKey = 0,
  onRenderError,
  onAnchorClick,
}: {
  label: string;
  children: React.ReactNode;
  marker?: string;
  refreshKey?: number;
  onRenderError?: () => void;
  /**
   * Intercepted site-project anchors (`#/site/...`) inside the preview.
   * The preview iframe has NO navigation context (portal-rendered into a
   * srcdoc document), so without this a project link would silently do
   * nothing — or, before the website-native routes existed, leak the visitor
   * into the platform's /p/<id> page. The builder forwards the href so the
   * REAL standalone website project page can be opened from the preview.
   */
  onAnchorClick?: (href: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef<ReturnType<typeof import("react-dom/client").createRoot> | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Manual refresh: drop the old document/root and remount the iframe (key
  // change) so the next load re-runs the whole pipeline honestly.
  useEffect(() => {
    if (refreshKey === 0) return;
    setLoaded(false);
    setDoc(null);
    const root = rootRef.current;
    rootRef.current = null;
    if (root) {
      setTimeout(() => {
        try {
          root.unmount();
        } catch {
          /* already gone */
        }
      }, 0);
    }
  }, [refreshKey]);

  const handleLoad = useCallback(() => {
    const frame = frameRef.current;
    const frameDoc = frame?.contentDocument;
    if (!frameDoc) return;
    // Copy the app's stylesheets into the frame so Tailwind classes work inside.
    if (!frameDoc.head.hasChildNodes()) {
      for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
        frameDoc.head.appendChild(node.cloneNode(true));
      }
      // Mirror next/font's CSS-variable classes onto the frame's <body>. The
      // site's bundled font stacks resolve through var(--font-fraunces) /
      // var(--font-geist-sans) / var(--font-geist-mono), which next/font only
      // defines on the APP body — without these classes every bundled family
      // silently fell back to an inherited default inside the preview.
      const fontVarClasses = Array.from(document.body.classList).filter((c) => c.includes("__variable"));
      if (fontVarClasses.length > 0) frameDoc.body.classList.add(...fontVarClasses);
      // Height chain (html→body→mount→site root min-h-full) so the site's own
      // background fills the whole frame.
      frameDoc.documentElement.style.height = "100%";
      frameDoc.body.style.margin = "0";
      frameDoc.body.style.height = "100%";
      frameDoc.body.style.backgroundColor = "transparent";
    }
    setDoc(frameDoc);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!doc || !onAnchorClick) return;
    // Capture-phase delegation: intercept the site's OWN project links inside
    // the preview and hand them to the builder (in-page anchors like
    // #bs-contact keep their default in-frame behavior).
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#/site/")) {
        event.preventDefault();
        onAnchorClick(href);
      }
    };
    doc.addEventListener("click", handler, true);
    return () => doc.removeEventListener("click", handler, true);
  }, [doc, onAnchorClick]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const ReactDOMClient = await import("react-dom/client");
      if (cancelled) return;
      if (!rootRef.current) {
        const mount = doc.createElement("div");
        mount.style.height = "100%";
        doc.body.appendChild(mount);
        rootRef.current = ReactDOMClient.createRoot(mount);
      }
      rootRef.current.render(<PreviewErrorBoundary onError={onRenderError}>{children}</PreviewErrorBoundary>);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, children, onRenderError]);

  useEffect(() => {
    return () => {
      const root = rootRef.current;
      rootRef.current = null;
      if (root) {
        setTimeout(() => {
          try {
            root.unmount();
          } catch {
            /* already gone */
          }
        }, 0);
      }
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <iframe
        key={refreshKey}
        ref={frameRef}
        title={label}
        onLoad={handleLoad}
        srcDoc="<!DOCTYPE html><html><head></head><body></body></html>"
        className="block h-full w-full border border-border/70 bg-background shadow-sm"
        sandbox="allow-same-origin allow-scripts"
        {...(marker ? { "data-bean-preview": marker } : {})}
      />
      {!loaded && (
        <div className="absolute inset-0 grid place-items-center bg-background/60">
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading preview…
          </p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ device stage
// One live preview, centered at the selected device width inside a responsive
// workspace. When the workspace is narrower than the device width the frame is
// scaled visually (transform) — its real viewport dimensions never change.

function DeviceStage({
  deviceWidth,
  label,
  minHeight = 420,
  marker,
  refreshKey,
  onRenderError,
  onAnchorClick,
  children,
}: {
  deviceWidth: number | "100%";
  label: string;
  minHeight?: number;
  marker?: string;
  refreshKey?: number;
  onRenderError?: () => void;
  onAnchorClick?: (href: string) => void;
  children: React.ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const numeric = typeof deviceWidth === "number" ? deviceWidth : null;
  const scale = numeric && box.w > 0 ? Math.min(1, (box.w - 4) / numeric) : 1;
  const shownW = numeric ? numeric * scale : undefined;
  const frameH = box.h > 0 ? (numeric && scale < 1 ? box.h / scale : box.h) : undefined;

  return (
    <div
      ref={outerRef}
      // Mobile: allow the stage to shrink below its desktop minHeight — the
      // wrapped studio header + zone tabs leave little vertical room, and an
      // overflowing (transform-scaled) iframe paints OVER the static zone nav.
      className="relative flex min-h-0 w-full flex-1 items-stretch justify-center overflow-hidden max-md:min-h-0!"
      style={{ minHeight }}
    >
      <div className="relative" style={shownW !== undefined ? { width: shownW, height: box.h || minHeight } : { width: "100%", height: box.h || minHeight }}>
        <div
          className="absolute left-0 top-0 h-full w-full"
          style={
            numeric
              ? {
                  width: numeric,
                  height: frameH,
                  transform: scale < 1 ? `scale(${scale})` : undefined,
                  transformOrigin: "top left",
                }
              : undefined
          }
        >
          <PreviewFrame label={label} marker={marker} refreshKey={refreshKey} onRenderError={onRenderError} onAnchorClick={onAnchorClick}>{children}</PreviewFrame>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

/**
 * Slim vertical collapse rail between a workspace panel and the canvas —
 * the professional-studio "give me the full width" control. Desktop only
 * (mobile zones are mutually exclusive already).
 */
function PanelCollapseRail({
  side,
  collapsed,
  onToggle,
  label,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  const Icon = side === "left" ? (collapsed ? ChevronsRight : ChevronsLeft) : collapsed ? ChevronsLeft : ChevronsRight;
  const action = collapsed ? `Expand ${label}` : `Collapse ${label} — gives the website canvas the full remaining width`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={collapsed}
      aria-label={action}
      title={action}
      className={cn(
        "hidden w-5 shrink-0 flex-col items-center justify-center bg-card/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:flex",
        side === "left" ? "border-r border-border/60" : "border-l border-border/60"
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}

const DEVICE_PRESETS = {
  // Desktop uses a realistic desktop viewport (1280); when the canvas column is
  // narrower the frame is scaled VISUALLY only — the iframe's real viewport
  // stays 1280 so media queries behave like on a real desktop.
  desktop: { label: "Desktop", width: 1280 as const, icon: Monitor },
  tablet: { label: "Tablet", width: 768, icon: Tablet },
  mobile: { label: "Mobile", width: 390, icon: Smartphone },
};

// ------------------------------------------------------------------ chat/preview divider
// CODE GIFTZ's resizable workspace boundary. ONE 22px column carries both the
// drag-to-resize surface and the existing collapse toggle (the former
// PanelCollapseRail control), so the boundary chrome stays exactly as wide as
// before while gaining real resizing.

/** Hard px floors for the two regions — refined % clamps at drag time. */
const CHAT_MIN_PX = 380;
const PREVIEW_MIN_PX = 500;
/** The divider column's own width — the preview gets the remainder MINUS it. */
const DIVIDER_PX = 22;

function ChatResizeDivider({
  collapsed,
  onToggle,
  widthPct,
  minPct,
  maxPct,
  defaultPct,
  onWidthChange,
  onDragEnd,
  workspaceRef,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  /** Current effective chat share of the workspace width (%) — aria mirror. */
  widthPct: number;
  minPct: number;
  maxPct: number;
  /** Double-click resets to this share. */
  defaultPct: number;
  /** Drag move / keyboard step. `final` = a discrete keyboard step or reset. */
  onWidthChange: (pct: number, final: boolean) => void;
  /** Drag finished — the parent commits the drafted width. */
  onDragEnd: () => void;
  /** The workspace row — the % is measured against ITS width (stable during
   * the drag; measuring the divider itself would feed the cursor back into
   * its own position and oscillate). */
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  label: string;
}) {
  const dragRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const onDragEndRef = useRef(onDragEnd);
  useEffect(() => {
    onDragEndRef.current = onDragEnd;
  }, [onDragEnd]);

  const clamp = useCallback((p: number) => Math.min(maxPct, Math.max(minPct, p)), [minPct, maxPct]);

  const pctFromClientX = useCallback(
    (clientX: number): number | null => {
      const row = workspaceRef.current;
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return ((clientX - rect.left) / rect.width) * 100;
    },
    [workspaceRef]
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      e.preventDefault();
      const pct = pctFromClientX(e.clientX);
      if (pct !== null) onWidthChange(clamp(pct), false);
    };
    // One idempotent end-drag path — pointerup, pointercancel and
    // lostpointercapture all route here, so a lost/oddly-delivered event can
    // never leave a draft width uncommitted (commitDraftedChatWidth is
    // ref-based and safe to call twice).
    const endDrag = () => {
      setDragging(false);
      onDragEndRef.current();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("lostpointercapture", endDrag);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("lostpointercapture", endDrag);
    };
  }, [dragging, clamp, onWidthChange, pctFromClientX]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (collapsed || e.button !== 0) return;
    e.preventDefault();
    // Pointer capture keeps every later pointermove retargeted to this strip
    // even when the cursor crosses the preview iframe (iframes otherwise
    // swallow parent-window pointer events and the drag would stall).
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — the window listeners below still track */
    }
    setDragging(true);
    const pct = pctFromClientX(e.clientX);
    if (pct !== null) onWidthChange(clamp(pct), false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (collapsed) return;
    const step = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onWidthChange(clamp(widthPct - step), true);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onWidthChange(clamp(widthPct + step), true);
    } else if (e.key === "Home") {
      e.preventDefault();
      onWidthChange(minPct, true);
    } else if (e.key === "End") {
      e.preventDefault();
      onWidthChange(maxPct, true);
    }
  };

  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  const toggleLabel = collapsed
    ? `Expand ${label}`
    : `Collapse ${label} — gives the website preview the full remaining width`;

  return (
    <>
      {/* drag overlay — covers the whole app (including the iframe) while a
          drag is active so the cursor stays a resizer and no hover/scroll
          steals the gesture */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize select-none" aria-hidden />}
      <div
        className={cn(
          "group relative hidden shrink-0 flex-col items-stretch justify-center lg:flex",
          collapsed ? "w-5" : "w-[22px]"
        )}
      >
      {/* drag surface — the full strip under the collapse button. Window-level
          listeners + pointer capture track the gesture anywhere on screen. */}
      <div
        ref={dragRef}
        role={collapsed ? undefined : "separator"}
        aria-orientation={collapsed ? undefined : "vertical"}
        aria-label={collapsed ? undefined : `Resize ${label} and website preview`}
        aria-valuenow={collapsed ? undefined : Math.round(widthPct)}
        aria-valuemin={collapsed ? undefined : Math.round(minPct)}
        aria-valuemax={collapsed ? undefined : Math.round(maxPct)}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerUp={() => {
          // Redundant commit trigger (window listeners + lostpointercapture
          // are the primary paths) — idempotent.
          if (dragging) {
            setDragging(false);
            onDragEndRef.current();
          }
        }}
        onDoubleClick={() => !collapsed && onWidthChange(defaultPct, true)}
        onKeyDown={handleKeyDown}
        title={collapsed ? undefined : `Drag to resize · double-click to reset · Arrow keys adjust`}
        className={cn(
          "absolute inset-0 touch-none transition-colors",
          collapsed
            ? "cursor-default"
            : dragging
              ? "cursor-col-resize bg-primary/40"
              : "cursor-col-resize bg-transparent hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
        )}
      />
      {/* boundary line affordance */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 transition-colors",
          dragging ? "bg-primary/60" : "bg-border/70 group-hover:bg-primary/40"
        )}
      />
      {/* collapse toggle — the SAME control as the former PanelCollapseRail */}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={collapsed}
        aria-label={toggleLabel}
        title={toggleLabel}
        className="relative z-10 mx-auto flex size-6 cursor-pointer items-center justify-center rounded-md bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
      </div>
    </>
  );
}

/**
 * Client-side twin of the server's configFingerprint (lib/site-studio/turn.ts,
 * FNV-1a 32-bit over the canonical JSON). Used ONLY as an advisory staleness
 * hint on the proposal banner — never as a gate.
 */
function configFingerprint(config: SiteConfig): string {
  let h = 0x811c9dc5;
  const s = JSON.stringify(config);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

interface ProposalPreview {
  messageId: string;
  config: SiteConfig;
  /** Fingerprint of the base config the proposal was generated from. */
  baseHash: string;
}

/** Mobile zone of the CODE GIFTZ workspace. */
type GiftzZone = "chat" | "preview";
/** Mobile zone of the Customization workspace (content editing is a first-class zone). */
type CustomizationZone = "content" | "preview" | "studio";

/**
 * The two top-level Website Studio modes (two-tab structure):
 *  - "customization" — free visual customization (presets, templates,
 *    typography, colors, layout, animations) — no chat.
 *  - "giftz" — the CODE GIFTZ AI coding workspace (chat + live preview) —
 *    no preset library.
 * Both operate on the SAME draft config; switching never remounts the zones
 * (CSS-hidden), so unsaved changes and conversation history survive.
 */
type StudioMode = "customization" | "giftz";

const STUDIO_MODES = [
  { key: "customization", label: "Customization", hint: "Free visual customization — presets, fonts, colors, layout, animations" },
  { key: "giftz", label: "GIFTZ", hint: "AI coding workspace — chat-driven code changes with live preview" },
] as const;

export default function WebsiteBuilderView() {
  const { user } = useSession();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsUsername, setNeedsUsername] = useState(false);

  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [design, setDesign] = useState<SiteDesignDTO | null>(null);
  const [profileData, setProfileData] = useState<PublicProfileResponse | null>(null);
  const hadNoDraftRef = useRef(false);
  /** Glass `enabled` value before Performance mode was turned on (null = not toggled this session). */
  const perfGlassEnabledRef = useRef<boolean | null>(null);

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Publish/link confirmation dialog — opened by a successful publish (with the
  // real URL the server returned) and by the Copy link / Share toolbar actions.
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [activePageId, setActivePageId] = useState<string>("home");
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  /** Top-level studio mode (Customization ⇄ CODE GIFTZ). */
  const [mode, setMode] = useState<StudioMode>("customization");

  // ---- INDEPENDENT per-mode settings (Customization vs CODE GIFTZ). Each
  // mode owns its persisted device viewport, panel-collapse state and (for
  // CODE GIFTZ) chat/preview/validation/draft preferences — separate
  // localStorage keys, so a control in one mode can never write the other's
  // state.
  const [customPrefs, setCustomPrefs] = useState<CustomizationPrefs>(DEFAULT_CUSTOMIZATION_PREFS);
  const [giftzPrefs, setGiftzPrefs] = useState<GiftzPrefs>(DEFAULT_GIFTZ_PREFS);
  const [customZone, setCustomZone] = useState<CustomizationZone>("content");
  const [giftzZone, setGiftzZone] = useState<GiftzZone>("chat");
  const prefsHydratedRef = useRef(false);
  /** Ref mirrors of the two pref stores — update* reads the LATEST value and
   * persists OUTSIDE any state updater (updaters must stay pure: React may
   * defer, re-run or drop them, so a storage write inside one is unreliable). */
  const customPrefsRef = useRef<CustomizationPrefs>(DEFAULT_CUSTOMIZATION_PREFS);
  const giftzPrefsRef = useRef<GiftzPrefs>(DEFAULT_GIFTZ_PREFS);
  useEffect(() => {
    // Client-only hydration of the two INDEPENDENT pref stores (run once).
    if (prefsHydratedRef.current) return;
    prefsHydratedRef.current = true;
    const c = readModePrefs("customization") as CustomizationPrefs;
    const g = readModePrefs("giftz") as GiftzPrefs;
    customPrefsRef.current = c;
    giftzPrefsRef.current = g;
    setCustomPrefs(c);
    setGiftzPrefs(g);
  }, []);
  const updateCustomPrefs = useCallback(function updateCustomPrefs(patch: Partial<CustomizationPrefs>) {
    const next = { ...customPrefsRef.current, ...patch };
    customPrefsRef.current = next;
    setCustomPrefs(next);
    writeModePrefs("customization", next);
  }, []);
  const updateGiftzPrefs = useCallback(function updateGiftzPrefs(patch: Partial<GiftzPrefs>) {
    const next = { ...giftzPrefsRef.current, ...patch };
    giftzPrefsRef.current = next;
    setGiftzPrefs(next);
    writeModePrefs("giftz", next);
  }, []);
  /** The ACTIVE mode's device viewport — each mode remembers its own. */
  const device: keyof typeof DEVICE_PRESETS = mode === "giftz" ? giftzPrefs.device : customPrefs.device;
  function setDeviceForActiveMode(d: StudioDevice) {
    if (mode === "giftz") updateGiftzPrefs({ device: d });
    else updateCustomPrefs({ device: d });
  }
  /**
   * Panel collapse (workspace expansion): each side is collapsible per mode —
   * collapsing gives the canvas the full remaining viewport width. Customization
   * owns left(content)/right(studio); CODE GIFTZ owns left(chat).
   */
  const leftCollapsed = mode === "giftz" ? giftzPrefs.chatCollapsed : customPrefs.leftCollapsed;
  const rightCollapsed = customPrefs.rightCollapsed;
  function setLeftCollapsed(v: boolean) {
    if (mode === "giftz") updateGiftzPrefs({ chatCollapsed: v });
    else updateCustomPrefs({ leftCollapsed: v });
  }
  function setRightCollapsed(v: boolean) {
    updateCustomPrefs({ rightCollapsed: v });
  }

  // ---- INDEPENDENT save workflows: per-mode save lifecycle. Saving while in
  // Customization updates the Customization status; saving (a draft or a
  // generated proposal) while in CODE GIFTZ updates the CODE GIFTZ status.
  // One draft on the server — but each mode's save state, labels and
  // status chip are its own.
  const [saveStatus, setSaveStatus] = useState<Record<StudioSaveMode, ModeSaveStatus>>({
    customization: { state: "idle", at: null },
    giftz: { state: "idle", at: null },
  });

  // ---- GIFTZ generated sites (INDEPENDENT from the portfolio draft) -------
  // GIFTZ mode builds and publishes its OWN website artifacts (GiftzSite).
  // Nothing here reads or writes the portfolio SiteDesign: generation,
  // saving, publishing and switching generated sites never touch
  // Customization state, and Customization never touches a GiftzSite.
  interface GiftzSiteSummary {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  }
  const [giftzSites, setGiftzSites] = useState<GiftzSiteSummary[]>([]);
  const [giftzSitesLoading, setGiftzSitesLoading] = useState(false);
  const [giftzSite, setGiftzSite] = useState<{ id: string; title: string; status: string; config: SiteConfig | null } | null>(null);
  const [giftzPublishedPath, setGiftzPublishedPath] = useState<string | null>(null);
  const [giftzLinkDialogOpen, setGiftzLinkDialogOpen] = useState(false);

  const refreshGiftzSites = useCallback(async () => {
    setGiftzSitesLoading(true);
    try {
      const r = await api<{ sites: GiftzSiteSummary[] }>("/api/giftz/sites");
      setGiftzSites(r.sites);
    } catch {
      // Listing is best-effort — the chat and preview keep working; the
      // failure is visible in the switcher only, never as a fake success.
    } finally {
      setGiftzSitesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGiftzSites();
  }, [refreshGiftzSites]);

  /** Open one of the user's generated sites in the GIFTZ workspace. */
  const openGiftzSite = useCallback(async (id: string) => {
    try {
      const r = await api<{ site: { id: string; title: string; status: string; config: SiteConfig | null } }>(
        `/api/giftz/sites/${encodeURIComponent(id)}`
      );
      setGiftzSite({ id: r.site.id, title: r.site.title, status: r.site.status, config: r.site.config });
      setGiftzPublishedPath(null);
      setProposalPreview(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open this generated site");
    }
  }, []);

  /** Start a NEW generated website (unbound until its first save). */
  function startNewGiftzSite() {
    setGiftzSite(null);
    setGiftzPublishedPath(null);
    setProposalPreview(null);
  }
  function setModeSaveStatus(m: StudioSaveMode, next: ModeSaveStatus) {
    setSaveStatus((prev) => ({ ...prev, [m]: next }));
  }
  function markActiveModeSaving() {
    setModeSaveStatus(mode, { state: "saving", at: saveStatus[mode].at });
  }
  function markModeSaved(m: StudioSaveMode) {
    setModeSaveStatus(m, { state: "saved", at: Date.now() });
  }
  function markModeFailed(m: StudioSaveMode) {
    setModeSaveStatus(m, { state: "failed", at: null });
  }

  /** Manual preview reload counter (Reload preview button) + render-error state. */
  const [previewNonce, setPreviewNonce] = useState(0);
  const [previewError, setPreviewError] = useState(false);

  // ---- Resizable CODE GIFTZ workspace (chat ⇄ preview). The chat region's
  // width is a % of the measured workspace row; px floors keep both regions
  // usable at any desktop size. Drag updates a DRAFT pct (smooth, no storage
  // writes at 60fps); drag-end/keyboard commit it to the giftz prefs store.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [chatPctDraft, setChatPctDraft] = useState<number | null>(null);
  /** Ref mirror of the draft — commit reads it WITHOUT side effects inside
   * state updaters (updaters must stay pure; a storage write inside one can
   * be silently dropped by React's scheduler). */
  const chatPctDraftRef = useRef<number | null>(null);
  const setChatPctDraftTracked = useCallback((v: number | null) => {
    chatPctDraftRef.current = v;
    setChatPctDraft(v);
  }, []);
  useLayoutEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const update = () => setWorkspaceWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const storedChatPct = mode === "giftz" ? giftzPrefs.chatWidthPct : DEFAULT_CHAT_WIDTH_PCT;
  const chatPctBounds = useMemo(() => {
    if (workspaceWidth <= 0) {
      return { min: CHAT_WIDTH_PCT_MIN, max: CHAT_WIDTH_PCT_MAX };
    }
    return {
      min: Math.max(CHAT_WIDTH_PCT_MIN, (CHAT_MIN_PX / workspaceWidth) * 100),
      // The divider column is subtracted from the preview's share, so the
      // floor must reserve it too — otherwise the preview lands ~22px short.
      max: Math.min(CHAT_WIDTH_PCT_MAX, 100 - ((PREVIEW_MIN_PX + DIVIDER_PX) / workspaceWidth) * 100),
    };
  }, [workspaceWidth]);
  const effectiveChatPct = useMemo(() => {
    const raw = chatPctDraft ?? storedChatPct;
    const { min, max } = chatPctBounds;
    // Degenerate ultra-narrow workspace: guarantee the preview floor wins.
    if (min > max) return Math.min(CHAT_WIDTH_PCT_MAX, Math.max(min, raw));
    return Math.min(max, Math.max(min, raw));
  }, [chatPctDraft, storedChatPct, chatPctBounds]);
  /** Divider → view. Draft while dragging; commit on keyboard/discrete steps. */
  const handleChatWidthChange = useCallback(
    (pct: number, final: boolean) => {
      const rounded = Math.round(pct * 10) / 10;
      if (final) {
        setChatPctDraftTracked(null);
        updateGiftzPrefs({ chatWidthPct: rounded });
      } else {
        setChatPctDraftTracked(rounded);
      }
    },
    [setChatPctDraftTracked, updateGiftzPrefs]
  );
  const commitDraftedChatWidth = useCallback(() => {
    const draft = chatPctDraftRef.current;
    setChatPctDraftTracked(null);
    if (draft !== null) updateGiftzPrefs({ chatWidthPct: draft });
  }, [setChatPctDraftTracked, updateGiftzPrefs]);
  /** Device viewport INSIDE the template live-preview dialog (independent of
   * the header device switcher, which drives the main canvas). */
  const [templatePreviewDevice, setTemplatePreviewDevice] = useState<keyof typeof DEVICE_PRESETS>("desktop");

  /** Switch studio mode; each mode keeps its own zone state (all zones are
   * valid in their own mode, so no fixup is needed). */
  function switchMode(next: StudioMode) {
    if (next === mode) return;
    setMode(next);
  }

  // History (undo/redo) — refs hold the stacks; a version counter triggers
  // re-renders. Side effects never run inside state updaters.
  const pastRef = useRef<SiteConfig[]>([]);
  const futureRef = useRef<SiteConfig[]>([]);
  const [histVersion, setHistVersion] = useState(0);
  const configRef = useRef<SiteConfig | null>(null);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Isolated proposal preview (from the studio chat) — the canvas renders this
  // config while the draft stays untouched. Save routes through the normal
  // PUT; Discard simply stops previewing.
  const [proposalPreview, setProposalPreview] = useState<ProposalPreview | null>(null);

  // Library favorites + recents (fonts, palettes, motion presets) — per device.
  const libraryPrefs = useLibraryPrefs();

  // Live template preview dialog (real render through PreviewFrame).
  const [liveTemplateId, setLiveTemplateId] = useState<TemplateId | null>(null);
  const [liveTemplatePageId, setLiveTemplatePageId] = useState<string | null>(null);

  // Explicit publish review dialog — publishing NEVER happens silently.
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);

  // Draft revisions — server-side snapshots that keep the user's original
  // version recoverable even after saves and browser restarts.
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [revisions, setRevisions] = useState<SiteRevisionDTO[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const draftKey = user ? `bean:ws-draft:${user.id}` : null;
  const baseDraftRef = useRef<string>("null");

  // ------------------------------------------------------------ load

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [siteRes, profileRes] = await Promise.all([
        api<{ design: SiteDesignDTO | null; needsUsername: boolean }>("/api/me/site"),
        api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(user?.username ?? "")}`).catch(() => null),
      ]);
      setNeedsUsername(siteRes.needsUsername);
      setDesign(siteRes.design);
      setProfileData(profileRes);
      hadNoDraftRef.current = !siteRes.design?.draft;

      const baseJson = JSON.stringify(siteRes.design?.draft ?? null);
      baseDraftRef.current = baseJson;

      // Restore the saved draft when valid; otherwise start from the template default.
      let restored = normalizeConfig(siteRes.design?.draft);
      let recovered = false;
      if (!restored) {
        hadNoDraftRef.current = true;
        restored = defaultConfig("atelier");
      }
      // Recover unsaved local edits from this device (same server base only).
      if (draftKey) {
        try {
          const raw = localStorage.getItem(draftKey);
          if (raw) {
            const parsed = JSON.parse(raw) as { base?: string; config?: unknown };
            if (parsed.base === baseJson) {
              const local = normalizeConfig(parsed.config);
              if (local) {
                restored = local;
                recovered = true;
              }
            } else {
              localStorage.removeItem(draftKey);
            }
          }
        } catch {
          /* corrupted local draft — ignore */
        }
      }

      setConfig(restored);
      configRef.current = restored;
      pastRef.current = [];
      futureRef.current = [];
      setHistVersion((v) => v + 1);
      setDirty(recovered);
      setProposalPreview(null);
      setActivePageId(restored.pages[0]?.id ?? "home");
      setSelectedSectionId(restored.pages[0]?.sections[0]?.id ?? null);
      if (recovered) toast.info("Recovered your unsaved changes from this device");

      // First visit with no draft anywhere: seed the SERVER draft silently so
      // the website has a STABLE identity (section/page ids) across reloads,
      // remounts and device switches. Seeding writes exactly the starting
      // config already on the canvas and never publishes.
      if (!siteRes.design?.draft && !recovered) {
        const seeded = JSON.stringify(restored);
        baseDraftRef.current = seeded;
        void api("/api/me/site", { method: "PUT", json: { config: restored } })
          .catch(() => {
            // seeding is an optimization — the builder still works unsaved
            baseDraftRef.current = "null";
          });
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load your website");
    } finally {
      setLoading(false);
    }
  }, [user?.username, draftKey]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  // Persist unsaved edits locally so a refresh can recover them.
  useEffect(() => {
    if (!draftKey || !config || !dirty) return;
    try {
      localStorage.setItem(draftKey, JSON.stringify({ base: baseDraftRef.current, config, at: Date.now() }));
    } catch {
      /* storage full/unavailable */
    }
  }, [config, dirty, draftKey]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ------------------------------------------------------------ mutation + history

  const pushHistory = useCallback((prev: SiteConfig) => {
    pastRef.current = [...pastRef.current.slice(-59), prev];
    futureRef.current = [];
    setHistVersion((v) => v + 1);
  }, []);

  const mutateConfig = useCallback(
    (fn: (c: SiteConfig) => SiteConfig) => {
      const c = configRef.current;
      if (!c) return;
      const next = fn(c);
      configRef.current = next;
      setConfig(next);
      setDirty(true);
      pushHistory(c);
    },
    [pushHistory]
  );

  const undo = useCallback(() => {
    const stack = pastRef.current;
    const cur = configRef.current;
    if (stack.length === 0 || !cur) return;
    const prev = stack[stack.length - 1];
    futureRef.current = [cur, ...futureRef.current].slice(0, 60);
    pastRef.current = stack.slice(0, -1);
    configRef.current = prev;
    setConfig(prev);
    setDirty(true);
    setHistVersion((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    const stack = futureRef.current;
    const cur = configRef.current;
    if (stack.length === 0 || !cur) return;
    const next = stack[0];
    pastRef.current = [...pastRef.current, cur];
    futureRef.current = stack.slice(1);
    configRef.current = next;
    setDirty(true);
    setHistVersion((v) => v + 1);
  }, []);

  // Keyboard undo/redo (skips while typing in fields — native text undo applies).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  // Escape deselects the directly-selected preview element (direct editing).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      setSelectedSectionId(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ------------------------------------------------------------ pages + sections

  const activePage: SitePage | null = useMemo(
    () =>
      config?.pages.find((p) => p.id === activePageId) ??
      // Land on the first VISIBLE page — hidden pages are not the site's
      // landing page (matches homePage() in the renderer/export).
      config?.pages.find((p) => p.visible) ??
      config?.pages[0] ??
      null,
    [config, activePageId]
  );

  const mutatePage = useCallback(
    (pageId: string, fn: (p: SitePage) => SitePage) => {
      mutateConfig((c) => ({ ...c, pages: c.pages.map((p) => (p.id === pageId ? fn(p) : p)) }));
    },
    [mutateConfig]
  );

  function addPage() {
    if (!config) return;
    if (config.pages.length >= 8) {
      toast.error("A website can have at most 8 pages.");
      return;
    }
    const id = `page-${Date.now().toString(36)}`;
    const hero = makeSection("hero");
    const page: SitePage = { id, name: `Page ${config.pages.length + 1}`, visible: true, sections: [hero] };
    mutateConfig((c) => ({ ...c, pages: [...c.pages, page] }));
    setActivePageId(id);
    setSelectedSectionId(hero.id);
  }

  function duplicatePage(pageId: string) {
    if (!config) return;
    if (config.pages.length >= 8) {
      toast.error("A website can have at most 8 pages.");
      return;
    }
    const src = config.pages.find((p) => p.id === pageId);
    if (!src) return;
    const id = `page-${Date.now().toString(36)}`;
    const copy: SitePage = {
      ...src,
      id,
      name: `${src.name} copy`,
      sections: src.sections.map((s) => ({ ...s, id: `${s.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` })),
    };
    const idx = config.pages.findIndex((p) => p.id === pageId);
    const pages = [...config.pages];
    pages.splice(idx + 1, 0, copy);
    mutateConfig((c) => ({ ...c, pages }));
    setActivePageId(id);
  }

  function removePage(pageId: string) {
    if (!config) return;
    if (config.pages.length <= 1) {
      toast.error("A website needs at least one page.");
      return;
    }
    const pages = config.pages.filter((p) => p.id !== pageId);
    mutateConfig((c) => ({ ...c, pages }));
    if (activePageId === pageId) {
      setActivePageId(pages[0].id);
      setSelectedSectionId(pages[0].sections[0]?.id ?? null);
    }
  }

  function movePage(pageId: string, dir: -1 | 1) {
    if (!config) return;
    const idx = config.pages.findIndex((p) => p.id === pageId);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= config.pages.length) return;
    const pages = [...config.pages];
    [pages[idx], pages[target]] = [pages[target], pages[idx]];
    mutateConfig((c) => ({ ...c, pages }));
  }

  function selectPage(pageId: string) {
    setActivePageId(pageId);
    const page = config?.pages.find((p) => p.id === pageId);
    setSelectedSectionId(page?.sections[0]?.id ?? null);
  }

  function addSection(type: SiteSectionType) {
    if (!activePage) return;
    if (activePage.sections.length >= 12) {
      toast.error("A page can have at most 12 sections.");
      return;
    }
    const section = makeSection(type);
    mutatePage(activePage.id, (p) => ({ ...p, sections: [...p.sections, section] }));
    setSelectedSectionId(section.id);
  }

  function duplicateSection(id: string) {
    if (!activePage) return;
    const idx = activePage.sections.findIndex((s) => s.id === id);
    if (idx === -1) return;
    if (activePage.sections.length >= 12) {
      toast.error("A page can have at most 12 sections.");
      return;
    }
    const copy: SiteSection = {
      ...activePage.sections[idx],
      // Random suffix — same-ms duplicates previously collided on ids.
      id: `${activePage.sections[idx].type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    };
    const sections = [...activePage.sections];
    sections.splice(idx + 1, 0, copy);
    mutatePage(activePage.id, (p) => ({ ...p, sections }));
    setSelectedSectionId(copy.id);
  }

  function removeSection(id: string) {
    if (!activePage) return;
    if (activePage.sections.length <= 1) {
      toast.error("A page needs at least one section.");
      return;
    }
    mutatePage(activePage.id, (p) => ({ ...p, sections: p.sections.filter((s) => s.id !== id) }));
    if (selectedSectionId === id) setSelectedSectionId(null);
  }

  function moveSection(id: string, dir: -1 | 1) {
    if (!activePage) return;
    const idx = activePage.sections.findIndex((s) => s.id === id);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= activePage.sections.length) return;
    const sections = [...activePage.sections];
    [sections[idx], sections[target]] = [sections[target], sections[idx]];
    mutatePage(activePage.id, (p) => ({ ...p, sections }));
  }

  function updateSection(id: string, patch: Partial<SiteSection>) {
    if (!activePage) return;
    mutatePage(activePage.id, (p) => ({
      ...p,
      sections: p.sections.map((s) => (s.id === id ? ({ ...s, ...patch } as SiteSection) : s)),
    }));
  }

  function updateTheme(patch: Partial<SiteTheme>) {
    mutateConfig((c) => ({ ...c, theme: { ...c.theme, ...patch } }));
  }

  function updateMotion(patch: Partial<SiteConfig["motion"]>) {
    mutateConfig((c) => ({ ...c, motion: { ...c.motion, ...patch } }));
  }

  function updateGlass(patch: Partial<SiteGlass>) {
    mutateConfig((c) => ({
      ...c,
      theme: { ...c.theme, glass: normalizeGlass({ ...(c.theme.glass ?? { enabled: true }), ...patch }) },
    }));
  }

  // ------------------------------------------------------------ branding logo

  const [logoUploading, setLogoUploading] = useState(false);

  async function handleLogoFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Logos must be an image file (PNG, JPG, WebP, GIF, SVG).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Logo images are limited to 8MB.");
      return;
    }
    setLogoUploading(true);
    try {
      const res = await uploadFile(file);
      // The server sniffs real content type from magic bytes — a text file
      // named .png never becomes the site logo.
      if (res.media.kind !== "IMAGE") {
        toast.error("That file is not an image — the logo was not changed.");
        return;
      }
      mutateConfig((c) => ({ ...c, logoMediaId: res.media.id, logoPreset: null }));
      toast.success("Logo uploaded — it now appears in your website's header");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not upload the logo");
    } finally {
      setLogoUploading(false);
    }
  }

  /** Use the built-in BEAN Folio brand mark as the site logo (optional). */
  function useBeanFolioLogo() {
    mutateConfig((c) => ({ ...c, logoPreset: "bean-folio", logoMediaId: null }));
    toast.success("BEAN Folio logo set — remove it any time");
  }

  function removeLogo() {
    mutateConfig((c) => ({ ...c, logoMediaId: null, logoPreset: null }));
    toast.success("Logo removed — your website shows its name again");
  }

  /** Apply a curated color system — color tokens ONLY. */
  function applyPalette(paletteId: string) {
    const p = getPalette(paletteId);
    if (!p) return;
    mutateConfig((c) => ({
      ...c,
      theme: {
        ...c.theme,
        background: p.tokens.background,
        foreground: p.tokens.foreground,
        accent: p.tokens.accent,
        accent2: p.tokens.accent2,
        surface: p.tokens.surface,
        border: p.tokens.border,
        muted: p.tokens.muted,
        focus: p.tokens.focus,
        gradient: p.tokens.gradient ? { ...p.tokens.gradient } : null,
        ...(c.theme.glass?.enabled ? { glass: { ...c.theme.glass, tint: p.tokens.glassTint } } : {}),
      },
    }));
    libraryPrefs.pushRecent("palette", p.id);
    toast.success(`${p.label} color system applied — colors only, everything else untouched`);
  }

  function applyFont(role: "headingFont" | "bodyFont" | "accentFont" | "codeFont" | "navFont" | "buttonFont", fontId: string) {
    updateTheme({ [role]: fontId } as Partial<SiteTheme>);
    libraryPrefs.pushRecent("font", fontId);
  }

  function applyMotionPreset(presetId: string) {
    updateMotion({ preset: presetId });
    libraryPrefs.pushRecent("motion", presetId);
  }

  /** One-click performance/accessibility mode: motion off + glass off. */
  function setPerformanceMode(on: boolean) {
    mutateConfig((c) => ({
      ...c,
      motion: { ...c.motion, enabled: !on },
      theme: { ...c.theme, glass: c.theme.glass ? { ...c.theme.glass, enabled: !on && c.theme.glass.enabled } : c.theme.glass },
    }));
    if (on) {
      perfGlassEnabledRef.current = config?.theme.glass?.enabled ?? false;
    } else if (perfGlassEnabledRef.current !== null && config?.theme.glass) {
      const restore = perfGlassEnabledRef.current;
      perfGlassEnabledRef.current = null;
      mutateConfig((c) => ({
        ...c,
        theme: { ...c.theme, glass: { ...c.theme.glass!, enabled: restore } },
      }));
    }
    toast.success(on ? "Performance mode on — animations and glass are off" : "Effects restored");
  }

  /**
   * Safe template switch: themes + presentation swap, real content is kept.
   * Every apply snapshots the pre-apply config so the Templates panel can
   * offer a REAL one-click "Revert last apply" for any template.
   */
  const lastTemplateSnapshotRef = useRef<SiteConfig | null>(null);
  const [templateSnapshotVersion, setTemplateSnapshotVersion] = useState(0);

  function applyTemplate(templateId: TemplateId) {
    const preset = templatePresets().find((t) => t.id === templateId);
    if (!preset || !config) return;
    lastTemplateSnapshotRef.current = configRef.current;
    setTemplateSnapshotVersion((v) => v + 1);
    if (hadNoDraftRef.current && !dirty) {
      // Pristine first-run site — nothing to preserve, adopt the full template.
      mutateConfig((c) => ({
        ...c,
        template: preset.id,
        theme: deriveTheme(preset.theme),
        motion: { ...c.motion, ...(preset.motion ?? {}) },
        pages: preset.pages.map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s })) })),
      }));
      setActivePageId("home");
      setSelectedSectionId(null);
      toast.success(`${preset.label} applied — your site was still empty, so its layout came too`, {
        description: "Undo it any time with “Revert last apply” in the Templates panel.",
      });
    } else {
      mutateConfig((c) => ({
        ...c,
        template: preset.id,
        // Glass and surface opacity are user customizations unrelated to the
        // template's token set — switching templates must not silently drop
        // them (template themes never define glass).
        theme: { ...deriveTheme(preset.theme), glass: c.theme.glass, surfaceOpacity: c.theme.surfaceOpacity },
        motion: { ...c.motion, ...(preset.motion ?? {}) },
      }));
      toast.success(`${preset.label} design applied — your pages and content were kept`, {
        description: "Undo it any time with “Revert last apply” in the Templates panel.",
      });
    }
  }

  /** Restore the exact pre-apply state of the most recent template apply. */
  function revertLastTemplateApply() {
    const snapshot = lastTemplateSnapshotRef.current;
    if (!snapshot) return;
    lastTemplateSnapshotRef.current = null;
    setTemplateSnapshotVersion((v) => v + 1);
    pushHistory(configRef.current!);
    configRef.current = snapshot;
    setConfig(snapshot);
    setDirty(true);
    const restored = templatePresets().find((t) => t.id === snapshot.template);
    toast.success(`Reverted to the design before ${restored?.label ?? "the last template"} was applied`);
  }

  function applyDesignPreset(presetId: string) {
    const preset = designPresets().find((p) => p.id === presetId);
    if (!preset) return;
    mutateConfig((c) => ({
      ...c,
      // Preserve the user's glass system + card opacity (see applyTemplate).
      theme: { ...deriveTheme({ ...preset.theme }), glass: c.theme.glass, surfaceOpacity: c.theme.surfaceOpacity },
      motion: { ...c.motion, ...(preset.motion ?? {}) },
    }));
    toast.success(`${preset.label} design tokens applied — sections untouched`);
  }

  /** Reset colors/type/motion to the current template's defaults — content kept. */
  function resetToTemplateDefaults() {
    if (!config) return;
    const t = templatePresets().find((tp) => tp.id === config.template);
    if (!t) return;
    mutateConfig((c) => ({
      ...c,
      theme: { ...deriveTheme(t.theme), glass: c.theme.glass, surfaceOpacity: c.theme.surfaceOpacity },
      motion: normalizeMotion({ ...c.motion, ...(t.motion ?? {}) }),
    }));
    toast.success(`Reset to ${t.label} defaults — your content was kept`);
  }

  // ------------------------------------------------------------ persistence

  async function saveDraft({ silent = false, override }: { silent?: boolean; override?: SiteConfig } = {}): Promise<SiteConfig | null> {
    const toSave = override ?? config;
    if (!toSave) return null;
    const via: StudioSaveMode = mode; // the ACTIVE mode owns this save's status
    setModeSaveStatus(via, { state: "saving", at: saveStatus[via].at });
    setSaving(true);
    try {
      await api("/api/me/site", { method: "PUT", json: { config: toSave } });
      setDirty(false);
      hadNoDraftRef.current = false;
      baseDraftRef.current = JSON.stringify(toSave);
      if (draftKey) localStorage.removeItem(draftKey);
      setModeSaveStatus(via, { state: "saved", at: Date.now() });
      if (!silent) toast.success("Draft saved — only you can see it");
      return toSave;
    } catch (e) {
      setModeSaveStatus(via, { state: "failed", at: null });
      toast.error(e instanceof Error ? e.message : "Could not save the draft");
      return null;
    } finally {
      setSaving(false);
    }
  }

  /**
   * Save the ISOLATED proposal preview.
   *
   * PRODUCT SEPARATION: in Customization mode the proposal becomes the
   * PORTFOLIO draft (PUT /api/me/site — server snapshots "Before save"); in
   * GIFTZ mode the proposal is saved to the GiftzSite artifact (POST to
   * create it when unbound, then PUT /api/giftz/sites/:id) — the portfolio
   * draft is NEVER touched by a GIFTZ save.
   */
  async function saveProposalPreview() {
    if (!proposalPreview || !config) return;
    const candidate = normalizeConfig(proposalPreview.config);
    if (!candidate) {
      toast.error("This proposal is no longer a valid website configuration — discard it and retry.");
      return;
    }
    if (mode === "giftz") {
      await saveGiftzProposal(candidate);
      return;
    }
    // CODE GIFTZ's own save lifecycle: the proposal save records its status
    // on the giftz mode, never on Customization.
    setModeSaveStatus("giftz", { state: "saving", at: saveStatus.giftz.at });
    // PUT first — the server snapshots "Before save" — and only touch the
    // canvas state once the save is CONFIRMED, so a failed save can never
    // leave the canvas showing proposal content after a later Discard.
    const saved = await saveDraft({ override: candidate });
    if (saved) {
      pushHistory(configRef.current!);
      configRef.current = candidate;
      setConfig(candidate);
      setProposalPreview(null);
      setModeSaveStatus("giftz", { state: "saved", at: Date.now() });
      toast.success("Proposal saved as your draft — publish to update the live site");
    } else {
      setModeSaveStatus("giftz", { state: "failed", at: null });
    }
  }

  /**
   * GIFTZ save — persists the generated website to its OWN artifact
   * (GiftzSite): creates the artifact when the workspace is unbound, then
   * saves the config with the SAME media-ownership guard the portfolio
   * enforces. Returns the saved site (id) so the publish flow can chain.
   */
  async function saveGiftzProposal(candidate: SiteConfig): Promise<{ id: string } | null> {
    setModeSaveStatus("giftz", { state: "saving", at: saveStatus.giftz.at });
    try {
      let siteId = giftzSite?.id ?? null;
      if (!siteId) {
        const created = await api<{ site: { id: string; title: string; status: string } }>("/api/giftz/sites", {
          method: "POST",
          json: { title: (candidate.name || "Generated site").slice(0, 120) },
        });
        siteId = created.site.id;
      }
      const saved = await api<{ saved: boolean; config: SiteConfig | null }>(
        `/api/giftz/sites/${encodeURIComponent(siteId)}`,
        { method: "PUT", json: { config: candidate } }
      );
      setGiftzSite({ id: siteId, title: candidate.name || "Generated site", status: giftzSite?.status ?? "DRAFT", config: saved.config ?? candidate });
      setProposalPreview(null);
      setModeSaveStatus("giftz", { state: "saved", at: Date.now() });
      void refreshGiftzSites();
      toast.success("Generated website saved — it is its own site, separate from your portfolio");
      return { id: siteId };
    } catch (e) {
      setModeSaveStatus("giftz", { state: "failed", at: null });
      toast.error(e instanceof Error ? e.message : "Could not save the generated website");
      return null;
    }
  }

  function discardChanges() {
    if (proposalPreview) {
      setProposalPreview(null);
      toast.info(
        mode === "giftz"
          ? "Proposal preview discarded — your generated website is unchanged"
          : "Proposal preview discarded — your draft is unchanged"
      );
      return;
    }
    // GIFTZ mode has no manually-editable draft — nothing to revert here.
    if (mode === "giftz" || !dirty || !config) return;
    const saved = normalizeConfig(baseDraftRef.current);
    if (!saved) {
      toast.error("Could not revert automatically — use “Restore” to pick a previous version instead.");
      return;
    }
    pushHistory(configRef.current!);
    configRef.current = saved;
    setConfig(saved);
    setDirty(false);
    if (draftKey) localStorage.removeItem(draftKey);
    toast.success("Draft reverted to the last saved version");
  }

  async function publish() {
    // PRODUCT SEPARATION: the publish path is per-product. GIFTZ publishes
    // its generated site to its own address; Customization publishes the
    // portfolio website. Neither action ever touches the other's artifact.
    if (mode === "giftz") {
      await publishGiftzSite();
      return;
    }
    if (!config) return;
    setPublishing(true);
    try {
      // Publishing snapshots the SAVED draft — flush unsaved edits first.
      if (dirty) {
        const saved = await saveDraft({ silent: true });
        if (!saved) return;
      }
      const res = await api<{
        status: string;
        publishedAt: string | null;
        publicUrl: string | null;
        canonicalUrl: string | null;
        canonicalKind: "production" | "workspace" | null;
        canonicalUrlUnavailable: { reason: "not-configured" | "invalid-config" | "unverified-host"; message: string } | null;
      }>("/api/me/site/publish", { method: "POST" });
      setDesign((d) =>
        d
          ? {
              ...d,
              status: "PUBLISHED",
              publishedAt: res.publishedAt,
              publicUrl: res.publicUrl,
              canonicalUrl: res.canonicalUrl,
              canonicalKind: res.canonicalKind,
              canonicalUrlUnavailable: res.canonicalUrlUnavailable,
              published: config,
              draft: config,
            }
          : d
      );
      setLinkDialogOpen(true); // surface the shareable URL + Copy/Share/Open actions
      if (res.canonicalUrl) {
        // Visible label is BEAN-branded (portfolioLinkLabel); the real working
        // URL — hostname included — stays the link destination, the copied
        // text and the address in the publish dialog that just opened.
        toast.success("Website published", {
          description:
            res.canonicalKind === "workspace"
              ? `${portfolioLinkLabel(user?.username)} is live — shareable via this workspace's public address.`
              : `${portfolioLinkLabel(user?.username)} is live.`,
        });
      } else {
        toast.warning("Snapshot saved — no shareable public link yet", {
          description:
            res.canonicalUrlUnavailable?.message ??
            (res.publicUrl
              ? `Visitors can now open #${res.publicUrl} in a new tab.`
              : "The snapshot is saved, but no public website route is available yet."),
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish");
    } finally {
      setPublishing(false);
    }
  }

  async function unpublish() {
    if (mode === "giftz") {
      await unpublishGiftzSite();
      return;
    }
    setPublishing(true);
    try {
      await api<{ status: string; canonicalUrl: string | null; canonicalKind: "production" | "workspace" | null }>(
        "/api/me/site/unpublish",
        { method: "POST" }
      );
      setDesign((d) => (d ? { ...d, status: "DRAFT", publishedAt: null } : d));
      setLinkDialogOpen(false);
      toast.success("Website unpublished — it is no longer publicly visible. Your public profile is unaffected.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unpublish");
    } finally {
      setPublishing(false);
    }
  }

  /**
   * GIFTZ publish — publishes THIS generated site to its own public address
   * (/site/<username>/g/<siteId>). The portfolio website is untouched.
   */
  async function publishGiftzSite() {
    setPublishing(true);
    try {
      // Publishing snapshots the SAVED artifact — flush the active proposal
      // first (the confirm dialog promises this).
      let siteId = giftzSite?.id ?? null;
      if (proposalPreview) {
        const candidate = normalizeConfig(proposalPreview.config);
        if (!candidate) {
          toast.error("This proposal is no longer a valid website configuration — discard it and retry.");
          return;
        }
        const saved = await saveGiftzProposal(candidate);
        if (!saved) return; // save failed — publish stops honestly
        siteId = saved.id;
      }
      if (!siteId) {
        toast.error("Generate and save a website first — there is nothing to publish yet.");
        return;
      }
      const res = await api<{ status: string; publishedAt: string | null; publicPath: string | null }>(
        `/api/giftz/sites/${encodeURIComponent(siteId)}/publish`,
        { method: "POST" }
      );
      setGiftzSite((s) => (s && s.id === siteId ? { ...s, status: "PUBLISHED" } : s));
      setGiftzPublishedPath(res.publicPath);
      setGiftzLinkDialogOpen(true);
      toast.success("Generated website published — it is live at its own address");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish the generated website");
    } finally {
      setPublishing(false);
    }
  }

  /** GIFTZ unpublish — takes THIS generated site offline; its draft is kept. */
  async function unpublishGiftzSite() {
    if (!giftzSite) return;
    setPublishing(true);
    try {
      await api(`/api/giftz/sites/${encodeURIComponent(giftzSite.id)}/unpublish`, { method: "POST" });
      setGiftzSite((s) => (s ? { ...s, status: "DRAFT" } : s));
      setGiftzPublishedPath(null);
      setGiftzLinkDialogOpen(false);
      toast.success("Generated website unpublished — it is no longer publicly visible");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unpublish");
    } finally {
      setPublishing(false);
    }
  }

  /**
   * Toggle the platform footer attribution ("Made with BEAN Folio · GIFTZ")
   * — a platform SETTING, not site content: it applies to the live website
   * immediately. Optimistic update with rollback on failure.
   */
  async function toggleWatermark(next: boolean) {
    const prev = design?.watermark ?? true;
    if (prev === next) return;
    setDesign((d) => (d ? { ...d, watermark: next } : d));
    try {
      await api<{ watermark: boolean }>("/api/me/site", { method: "PATCH", json: { watermark: next } });
    } catch (e) {
      setDesign((d) => (d ? { ...d, watermark: prev } : d));
      toast.error(e instanceof Error ? e.message : "Could not update the attribution setting");
    }
  }

  // ------------------------------------------------------------ draft revisions (restore)

  async function openRevisions() {
    setRevisionsOpen(true);
    setRevisionsLoading(true);
    try {
      const r = await api<{ revisions: SiteRevisionDTO[] }>("/api/me/site/revisions");
      setRevisions(r.revisions);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load previous versions");
      setRevisions([]);
    } finally {
      setRevisionsLoading(false);
    }
  }

  async function restoreRevision(id: string) {
    setRestoringId(id);
    try {
      const r = await api<{ restored: boolean; draft: unknown; label: string }>("/api/me/site/revisions", {
        method: "POST",
        json: { id },
      });
      const normalized = normalizeConfig(r.draft);
      if (!normalized) {
        toast.error("This snapshot is not a valid website configuration.");
        return;
      }
      pushHistory(configRef.current!);
      configRef.current = normalized;
      setConfig(normalized);
      setDirty(true);
      setProposalPreview(null);
      setRevisionsOpen(false);
      toast.success(`Previous version restored — the version you just left was also saved (label: ${r.label})`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore this version");
    } finally {
      setRestoringId(null);
    }
  }

  // ------------------------------------------------------------ proposal preview (from chat)

  const handlePreviewProposal = useCallback(
    (proposal: StudioProposal, messageId: string, opts?: { auto?: boolean }) => {
      const normalized = normalizeConfig(proposal.config);
      if (!normalized) {
        toast.error("This proposal is no longer a valid website configuration.");
        return;
      }
      setProposalPreview({ messageId, config: normalized, baseHash: proposal.baseConfigHash });
      // On mobile, a USER-initiated preview jumps straight to the canvas; an
      // auto-preview (generation finished) leaves the user in Chat — the
      // proposal card offers a one-tap Preview there.
      if (!opts?.auto) setGiftzZone("preview");
    },
    []
  );

  // ------------------------------------------------------------ profile content (left panel)

  const [profileSaving, setProfileSaving] = useState(false);

  /**
   * Save the profile-content edits from the Content editor (shared portfolio
   * identity — the SAME data every mode reads; never duplicated). Empty
   * optional links clear to null (the API validates emails/URLs strictly).
   */
  async function saveProfileContent(patch: ProfileContentPatch): Promise<boolean> {
    setProfileSaving(true);
    try {
      await api("/api/me/profile", {
        method: "PATCH",
        json: {
          headline: patch.headline,
          bio: patch.bio,
          location: patch.location,
          availability: patch.availability,
          contactEmail: patch.contactEmail.trim() === "" ? null : patch.contactEmail.trim(),
          websiteUrl: patch.websiteUrl.trim() === "" ? null : patch.websiteUrl.trim(),
          skills: patch.skills,
        },
      });
      // Re-pull the profile so the site canvas renders the new identity.
      const profileRes = await api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(user?.username ?? "")}`).catch(() => null);
      if (profileRes) setProfileData(profileRes);
      toast.success("Profile content saved", { description: "Your headline, introduction, skills and contact details are shared by the whole platform." });
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the profile content");
      return false;
    } finally {
      setProfileSaving(false);
    }
  }

  // ------------------------------------------------------------ render helpers

  const previewProfile = useMemo(() => {
    const p = profileData?.profile;
    return {
      name: p?.name ?? user?.name ?? "Your Name",
      username: p?.username ?? user?.username ?? null,
      headline: p?.headline ?? user?.headline ?? null,
      location: p?.location ?? user?.location ?? null,
      bio: p?.bio ?? user?.bio ?? null,
      availability: p?.availability ?? user?.availability ?? null,
      avatarUrl: p?.avatarUrl ?? user?.avatarUrl ?? null,
      coverUrl: p?.coverUrl ?? user?.coverUrl ?? null,
      coverPositionY: p?.coverPositionY ?? user?.coverPositionY ?? 50,
      professions: p?.professions ?? user?.professions ?? [],
      skills: p?.skills ?? user?.skills ?? [],
      websiteUrl: p?.websiteUrl ?? user?.websiteUrl ?? null,
      contactEmail: p?.contactEmail ?? user?.contactEmail ?? null,
      stats: {
        followers: p?.stats.followers ?? 0,
        following: p?.stats.following ?? 0,
        projects: profileData?.projects.length ?? 0,
      },
    };
  }, [profileData, user]);

  const projectCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of profileData?.projects ?? []) if (p.category) set.add(p.category);
    return Array.from(set);
  }, [profileData]);

  // Category filter options: the full taxonomy (labels, not raw slugs) plus any
  // category already on the user's projects.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>(Object.keys(CATEGORY_LABELS));
    for (const c of projectCategories) set.add(c);
    return Array.from(set).sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
  }, [projectCategories]);

  // Saved-draft base for the unsaved-changes list (recomputed when dirty flips).
  const savedBase = useMemo(() => {
    try {
      return normalizeConfig(baseDraftRef.current);
    } catch {
      return null;
    }
  }, [dirty, config]);
  const unsavedChanges = useMemo(
    () => (dirty && config ? summarizeConfigDiff(savedBase, config) : []),
    [dirty, savedBase, config]
  );

  const selectedSection = activePage?.sections.find((s) => s.id === selectedSectionId) ?? null;
  const published = design?.status === "PUBLISHED";
  const deviceMeta = DEVICE_PRESETS[device];

  // Advisory staleness: did the base change since this proposal was generated?
  // Per-product: a GIFTZ proposal is compared against the GiftzSite's own
  // saved config; a Customization proposal against the portfolio draft.
  const proposalBase = mode === "giftz" ? giftzSite?.config ?? null : config;
  const proposalStale = Boolean(proposalPreview && proposalBase && configFingerprint(proposalBase) !== proposalPreview.baseHash);

  // One-line canvas status (caption row above the preview).
  const canvasStatusText = previewError
    ? "Preview hit a rendering error — use Reload preview to retry. Your data is safe."
    : proposalPreview
      ? mode === "giftz"
        ? "Isolated proposal preview — the generated website is untouched until you save."
        : "Isolated proposal preview — your draft and published site are untouched until you save."
      : mode === "giftz"
        ? giftzSite
          ? giftzSite.status === "PUBLISHED"
            ? `Previewing “${giftzSite.title}” — published at its own address`
            : `Previewing your saved generated website — “${giftzSite.title}”`
          : "No website generated yet"
        : dirty
          ? "Previewing unsaved draft edits"
          : "Previewing your saved draft";

  // Canonical public address (see lib/site-url + lib/workspace-origin).
  const livePath = design?.publicUrl ?? publicSitePath(user?.username ?? null);
  const liveHash = livePath ? `#${livePath}` : null;
  const canonicalUrl = design?.canonicalUrl ?? null;
  const canonicalKind = design?.canonicalKind ?? null;
  const canonicalUnavailable = design?.canonicalUrlUnavailable ?? null;
  const shareTargets = shareActionUrls(canonicalUrl, liveHash);
  const liveMatchesDraft = Boolean(
    published && design?.published && config && JSON.stringify(config) === JSON.stringify(design.published)
  );
  const draftAheadOfLive = published && !liveMatchesDraft;

  // Live template candidate — the exact config Apply would produce.
  const liveTemplateConfig = useMemo<SiteConfig | null>(() => {
    if (!liveTemplateId || !config) return null;
    const preset = templatePresets().find((t) => t.id === liveTemplateId);
    if (!preset) return null;
    if (hadNoDraftRef.current && !dirty) {
      return {
        ...config,
        template: preset.id,
        theme: deriveTheme(preset.theme),
        motion: normalizeMotion({ ...config.motion, ...(preset.motion ?? {}) }),
        pages: preset.pages.map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s })) })),
      };
    }
    return {
      ...config,
      template: preset.id,
      theme: { ...deriveTheme(preset.theme), glass: config.theme.glass, surfaceOpacity: config.theme.surfaceOpacity },
      motion: normalizeMotion({ ...config.motion, ...(preset.motion ?? {}) }),
    };
  }, [liveTemplateId, config, dirty]);

  const liveTemplatePreset = useMemo(
    () => (liveTemplateId ? templatePresets().find((t) => t.id === liveTemplateId) ?? null : null),
    [liveTemplateId]
  );

  if (loading) {
    return (
      <div className="flex h-[calc(100dvh-4rem)] flex-col px-2 py-3" aria-busy="true">
        <Skeleton className="h-10 w-full rounded-xl" />
        <div className="mt-3 grid min-h-0 flex-1 gap-2 lg:grid-cols-[360px_1fr_360px]">
          <Skeleton className="h-full rounded-xl" />
          <Skeleton className="h-full rounded-xl" />
          <Skeleton className="h-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError || !config) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={RefreshCw}
          title="Couldn't open the website editor"
          description={loadError ?? "Something went wrong."}
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      </div>
    );
  }

  if (needsUsername) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={Globe}
          title="Claim your public URL first"
          description="Your website publishes to its own public address (/site/<username>). Finish onboarding to claim your username, then come back to design your site."
          action={<Button onClick={() => navigate("/onboarding")}>Finish setup</Button>}
        />
      </div>
    );
  }

  // The canvas config: an isolated proposal preview when active; otherwise
  // the product's own artifact — in GIFTZ mode the GENERATED site's saved
  // config (never the portfolio draft), in Customization mode the portfolio
  // draft.
  const previewConfig: SiteConfig = proposalPreview?.config ?? (mode === "giftz" ? giftzSite?.config ?? config : config);

  const previewChildren = (cfg: SiteConfig, opts: { interactive?: boolean } = {}) => (
    <SiteRenderer
      config={cfg}
      profile={previewProfile}
      projects={profileData?.projects ?? []}
      collections={profileData?.collections ?? []}
      watermark={design?.watermark ?? true}
      pageId={activePage?.id}
      onPageChange={(id) => setActivePageId(id)}
      {...(opts.interactive && !proposalPreview
        ? {
            // Direct element selection — studio canvas only. Clicking any
            // rendered element selects its owning section; the Studio rail's
            // section editor edits it. Never while previewing a proposal.
            interactiveSelection: {
              selectedSectionId,
              onSelectSection: (sectionId: string | null) => {
                setSelectedSectionId(sectionId);
                if (sectionId && typeof window !== "undefined" && window.innerWidth < 1024) setCustomZone("studio");
              },
            },
          }
        : {})}
    />
  );

  // ------------------------------------------------------------ header actions

  const openLive = () => {
    if (shareTargets.openUrl) window.open(shareTargets.openUrl, "_blank", "noopener");
  };

  /** Copy Link — copies the canonical public URL; honestly refuses when no
   * permanent production URL is configured. */
  async function copyLiveLink() {
    const url = shareTargets.shareUrl;
    if (!url) {
      toast.error("No permanent public link yet", {
        description:
          canonicalUnavailable?.message ??
          "Set NEXT_PUBLIC_APP_URL to your production domain in the deployment environment, then republish.",
      });
      return;
    }
    const ok = await copyToClipboard(url);
    if (ok) toast.success("Link copied", { description: url });
    else toast.error("Could not copy automatically — select the URL and copy it manually.", { description: url });
  }

  /** Share — same canonical URL (Web Share API when available). */
  async function shareLive() {
    const url = shareTargets.shareUrl;
    if (!url) {
      toast.error("No permanent public link yet", {
        description:
          canonicalUnavailable?.message ??
          "Set NEXT_PUBLIC_APP_URL to your production domain in the deployment environment, then republish.",
      });
      return;
    }
    const outcome = await shareUrl(url, config?.name?.trim() || user?.name || "My website — BEAN Folio");
    if (outcome === "shared") toast.success("Shared");
    else if (outcome === "copied") toast.success("Sharing isn't available here — the link was copied instead", { description: url });
    else toast.error("Could not share or copy the link.", { description: url });
  }

  /**
   * Download Website Code — exports the CURRENT SAVED website as a standalone
   * static-site ZIP. Independent of publishing; unsaved canvas edits are NOT
   * silently included (the draft is flushed first, like publishing does).
   */
  async function downloadSiteCode() {
    setExporting(true);
    try {
      if (dirty) {
        const saved = await saveDraft({ silent: true });
        if (!saved) return; // save failed — its toast already explains
      }
      const res = await fetch("/api/me/site/export", {
        credentials: "include",
        headers: typeof window !== "undefined" && window.self !== window.top ? { "X-Bean-Embed": "1" } : {},
      });
      if (!res.ok) {
        let message = `Export failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "website-export.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast.success("Website code downloaded", {
        description: `${filename} — a standalone static site (HTML/CSS/JS + assets) with a README for local preview and hosting on Cloudflare Pages, Netlify or GitHub Pages.`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not export the website code");
    } finally {
      setExporting(false);
    }
  }

  const chatContext = {
    device: deviceMeta.label,
    pageName: activePage?.name ?? null,
    sectionType: selectedSection?.type ?? null,
    sectionTitle: selectedSection?.title ?? null,
  };

  return (
    // Mobile: the shell's fixed bottom nav (~5rem + safe area) overlays the
    // viewport bottom — reserve that space so the zone tabs stay tappable.
    <div className="flex h-[calc(100dvh-4rem)] flex-col overflow-hidden max-md:pb-[calc(5rem_+_env(safe-area-inset-bottom))]">
      {/* ---------------- header: brand · identity · save state · device · tools ---------------- */}
      <header className="z-30 flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 bg-background/95 px-2 py-1.5 backdrop-blur sm:gap-1.5">
        {/* brand wordmark + the two top-level studio tabs (Customization | CODE GIFTZ) */}
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className="font-display text-[13px] font-semibold uppercase tracking-[0.22em] text-primary">GIFTZ</span>
          <div
            role="tablist"
            aria-label="Website Studio modes"
            className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-card/60 p-0.5"
          >
            {STUDIO_MODES.map((tab) => {
              const active = mode === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.hint}
                  onClick={() => switchMode(tab.key)}
                  className={cn(
                    "inline-flex min-h-[32px] items-center whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors sm:text-[13px]",
                    active
                      ? "bg-gold-soft text-primary shadow-sm"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* site identity — wired into site.json's name (Customization owns the
            portfolio site's identity; GIFTZ sites carry the generated name) */}
        {mode === "customization" && (
          <Input
            value={config.name}
            maxLength={80}
            onChange={(e) => mutateConfig((c) => ({ ...c, name: e.target.value }))}
            aria-label="Website name"
            placeholder="Website name"
            className="h-8 w-28 min-w-0 font-display text-sm font-semibold sm:w-44"
          />
        )}
        {mode === "giftz" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 max-w-[200px] gap-1.5 px-2"
                title="Your GIFTZ generated websites — each one is an independent site, separate from your portfolio"
              >
                <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate">{giftzSite?.title ?? "New generated site"}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Generated websites</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={startNewGiftzSite}
                className={!giftzSite ? "bg-accent" : undefined}
              >
                <Plus className="size-4" aria-hidden /> New website
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {giftzSitesLoading ? (
                <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Loading…
                </div>
              ) : giftzSites.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No generated websites yet.</p>
              ) : (
                giftzSites.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => {
                      if (giftzSite?.id !== s.id) void openGiftzSite(s.id);
                    }}
                    className={giftzSite?.id === s.id ? "bg-accent" : undefined}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.title}</span>
                    {s.status === "PUBLISHED" && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400">live</span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* save-state cluster — scoped to the ACTIVE mode: Customization and
            CODE GIFTZ each get exactly ONE primary save action, their own
            status chip and their own discard/restore workflow. The publish
            workflow stays a separate, explicit path. */}
        <SaveControls
          mode={mode}
          dirty={mode === "giftz" ? Boolean(proposalPreview) : dirty}
          status={saveStatus[mode]}
          publishing={publishing}
          hasPublished={mode === "giftz" ? giftzSite?.status === "PUBLISHED" : published}
          draftAheadOfLive={mode === "giftz" ? false : draftAheadOfLive}
          proposalActive={Boolean(proposalPreview)}
          unsavedChanges={mode === "giftz" ? (proposalPreview ? ["The generated website preview is not saved yet"] : []) : unsavedChanges}
          showRestore={mode === "customization"}
          confirmBeforeSave={mode === "giftz" ? giftzPrefs.confirmProposalSave : false}
          onSave={() => {
            if (proposalPreview) void saveProposalPreview();
            else if (mode === "customization") void saveDraft();
          }}
          onDiscard={discardChanges}
          onOpenRevisions={() => void openRevisions()}
          onPublishRequest={() => setPublishDialogOpen(true)}
          onUnpublish={() => void unpublish()}
        />

        <div className="hidden min-w-0 flex-1 2xl:block" aria-hidden />

        {/* device switcher — the ACTIVE mode's preview viewport; each mode
            remembers its own (independent per-mode settings) */}
        <div className="flex rounded-lg border border-border/60 p-0.5" role="tablist" aria-label="Preview device">
          {(Object.keys(DEVICE_PRESETS) as (keyof typeof DEVICE_PRESETS)[]).map((d) => {
            const Icon = DEVICE_PRESETS[d].icon;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={device === d}
                aria-label={`${DEVICE_PRESETS[d].label} preview`}
                title={`${DEVICE_PRESETS[d].label} preview`}
                onClick={() => setDeviceForActiveMode(d)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                  device === d ? "bg-gold-soft font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="hidden 2xl:inline">{DEVICE_PRESETS[d].label}</span>
              </button>
            );
          })}
        </div>

        {/* undo / redo — PORTFOLIO tools: they edit the Customization draft,
            so they are hidden in GIFTZ mode where they would act on the wrong
            product's state. */}
        {mode === "customization" && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="size-8" aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" disabled={pastRef.current.length === 0} onClick={undo}>
              <Undo2 className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Redo" title="Redo (Ctrl/Cmd+Y)" disabled={futureRef.current.length === 0} onClick={redo}>
              <Redo2 className="size-4" aria-hidden />
            </Button>
          </div>
        )}

        {/* export ZIP — independent of publishing (portfolio website export) */}
        {mode === "customization" && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={() => void downloadSiteCode()}
            disabled={exporting}
            title="Download your website as a standalone ZIP (HTML/CSS/JS + assets) you can host anywhere — no BEAN Folio needed"
          >
            {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            <span className="hidden 2xl:inline">Download code</span>
            <span className="sr-only">Download website code (ZIP)</span>
          </Button>
        )}

        {/* more menu: share tools (portfolio website share) */}
        {mode === "customization" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 px-2" aria-label="More studio tools">
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Share</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void copyLiveLink()} disabled={!shareTargets.shareUrl}>
              <Link2 className="size-4" aria-hidden /> Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void shareLive()} disabled={!shareTargets.shareUrl}>
              <Share2 className="size-4" aria-hidden /> Share…
            </DropdownMenuItem>
            {published && shareTargets.openUrl && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openLive()}>
                  <ExternalLink className="size-4" aria-hidden /> Open live website
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        )}

        {/* live address chip (xl screens) — the PORTFOLIO website's address;
            GIFTZ generated sites surface their own address after publishing */}
        {mode === "customization" && published && (canonicalUrl ?? liveHash) && (
          <a
            href={shareTargets.openUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden max-w-[260px] items-center gap-1 rounded-full border border-primary/30 bg-gold-soft/40 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-gold-soft/70 2xl:inline-flex"
            title={
              canonicalUrl
                ? "Your live website — opens in a new tab. Draft edits stay private until you publish again."
                : "Live on the current deployment (preview). Configure NEXT_PUBLIC_APP_URL with your production domain to get the permanent share link."
            }
          >
            <Link2 className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{portfolioLinkLabel(user?.username)}</span>
          </a>
        )}
      </header>

      {/* ---------------- three-zone workspace (collapsible panels, full-width canvas) ---------------- */}
      <div
        ref={workspaceRef}
        className="flex min-h-0 min-w-0 flex-1"
        style={{ "--giftz-chat-w": `${effectiveChatPct}%` } as React.CSSProperties}
      >
        {/* LEFT — CODE GIFTZ chat (CODE GIFTZ mode only; stays mounted while
            hidden so conversation history and in-flight turns survive tab
            switches AND panel collapses). Conversation = one independent
            scroll region; composer fixed at the panel bottom. Width is the
            resizable divider's share (--giftz-chat-w), never a fixed sidebar. */}
        <aside
          className={cn(
            "min-h-0 w-full flex-col overflow-hidden border-border/60 bg-card lg:w-[var(--giftz-chat-w,40%)] lg:shrink-0 lg:border-r",
            mode === "giftz" ? "lg:flex" : "lg:hidden",
            mode === "giftz" && giftzZone === "chat" ? "flex" : "hidden",
            leftCollapsed && "lg:hidden"
          )}
          aria-label="GIFTZ chat"
          aria-hidden={mode !== "giftz" || giftzZone !== "chat"}
        >
          <ChatPanel
            key={giftzSite?.id ?? "new"}
            currentConfig={config}
            context={chatContext}
            onPreviewProposal={handlePreviewProposal}
            activeProposalMessageId={proposalPreview?.messageId ?? null}
            autoPreviewProposals={giftzPrefs.autoPreview}
            giftzSettings={giftzPrefs}
            onGiftzSettingsChange={(next) => updateGiftzPrefs(next)}
            sessionTarget={{ kind: "giftz", siteId: giftzSite?.id ?? null }}
            sessionsTargetFilter="giftz"
          />
        </aside>

        {/* resizable divider — CODE GIFTZ: drag to resize the chat/preview
            split (position persists with the mode's prefs); the chevron keeps
            the existing collapse/expand control */}
        {mode === "giftz" && (
          <ChatResizeDivider
            collapsed={leftCollapsed}
            onToggle={() => setLeftCollapsed(!leftCollapsed)}
            widthPct={effectiveChatPct}
            minPct={chatPctBounds.min}
            maxPct={Math.max(chatPctBounds.min, chatPctBounds.max)}
            defaultPct={DEFAULT_CHAT_WIDTH_PCT}
            onWidthChange={handleChatWidthChange}
            onDragEnd={commitDraftedChatWidth}
            workspaceRef={workspaceRef}
            label="chat panel"
          />
        )}

        {/* LEFT — content editor (Customization mode only; stays mounted while
            hidden so open editors and profile-draft state survive switches).
            Direct content editing — never mixed with AI code proposals. */}
        <aside
          className={cn(
            "min-h-0 w-full flex-col overflow-hidden border-border/60 bg-card lg:w-[360px] lg:shrink-0 lg:border-r xl:w-[400px] 2xl:w-[440px]",
            mode === "customization" ? "lg:flex" : "lg:hidden",
            mode === "customization" && customZone === "content" ? "flex" : "hidden",
            leftCollapsed && "lg:hidden"
          )}
          aria-label="Content editor"
          aria-hidden={mode !== "customization" || customZone !== "content"}
        >
          <ContentEditor
            config={config}
            activePage={activePage}
            categoryOptions={categoryOptions}
            onNameChange={(v) => mutateConfig((c) => ({ ...c, name: v }))}
            onTaglineChange={(v) => mutateConfig((c) => ({ ...c, tagline: v }))}
            updateSection={updateSection}
            profile={
              previewProfile
                ? {
                    headline: previewProfile.headline,
                    bio: previewProfile.bio,
                    location: previewProfile.location,
                    availability: previewProfile.availability,
                    contactEmail: previewProfile.contactEmail,
                    websiteUrl: previewProfile.websiteUrl,
                    skills: previewProfile.skills,
                  }
                : null
            }
            profileSaving={profileSaving}
            onProfileSave={(patch) => saveProfileContent(patch)}
          />
        </aside>

        {/* collapse rail — Customization: content editor */}
        {mode === "customization" && (
          <PanelCollapseRail side="left" collapsed={leftCollapsed} onToggle={() => setLeftCollapsed(!leftCollapsed)} label="content editor" />
        )}

        {/* CENTER — preview workspace.
            Customization: the real site canvas (draft + unsaved edits).
            CODE GIFTZ: ONLY the generated website — the saved portfolio is
            deliberately NOT rendered here (empty state until generation).
            Chrome is deliberately minimal: ONE status/reload row, the canvas
            fills the rest — no nested padded containers eating width. */}
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col bg-muted/30 lg:flex",
            (mode === "giftz" ? giftzZone : customZone) === "preview" ? "flex" : "hidden"
          )}
          aria-label={mode === "giftz" ? "Generated website preview" : "Website preview canvas"}
        >
          {/* isolated proposal banner — STATUS ONLY. Save/Discard live in the
              header's mode-scoped save cluster (one primary save action per
              mode — no duplicate buttons over the same operation). */}
          {proposalPreview && (
            <div className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2" role="status">
              <p className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-4 shrink-0" aria-hidden /> Previewing changes — not saved yet. Use the
                header’s “Save Draft” to keep this generated website, or “Discard” to return to your draft.
              </p>
              {proposalStale && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  Your draft changed since this proposal was generated — saving replaces those newer edits with what you see here.
                </p>
              )}
            </div>
          )}
          {mode === "giftz" && !proposalPreview && !giftzSite?.config ? (
            /* CODE GIFTZ initial state — the generated-website preview is
               empty until an actual generation exists. The user's saved
               portfolio is NEVER shown as a fake generated result. */
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <span className="rounded-full border border-border/60 bg-card/60 p-3" aria-hidden>
                <Sparkles className="size-5 text-primary" />
              </span>
              <p className="font-display text-sm font-semibold">No website generated yet</p>
              <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                This Preview workspace shows the website GIFTZ generates for you. Describe what you want in the
                Chat workspace — every generated result lands here as an isolated preview before you decide to save.
              </p>
              <p className="max-w-sm text-[11px] leading-relaxed text-muted-foreground/80">
                Your saved website is not shown here — it lives in the Customization tab and can never be overwritten
                by generation.
              </p>
              <Button size="sm" variant="outline" className="h-8" onClick={() => setGiftzZone("chat")}>
                <MessageSquare className="size-3.5" aria-hidden /> Open Chat
              </Button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-1 p-1.5">
              {/* one compact toolbar row: status caption left, reload right */}
              <div className="flex shrink-0 items-center justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={canvasStatusText}>
                  {canvasStatusText}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground"
                  onClick={() => {
                    setPreviewError(false);
                    setPreviewNonce((n) => n + 1);
                  }}
                  title="Reload the live preview from scratch — useful after an error or to re-run fonts and animations"
                >
                  <RefreshCw className="size-3.5" aria-hidden /> Reload preview
                </Button>
              </div>
              <DeviceStage
                deviceWidth={DEVICE_PRESETS[device].width}
                label={`${deviceMeta.label} ${mode === "giftz" ? "generated website preview" : "website preview"}`}
                minHeight={320}
                marker="canvas"
                refreshKey={previewNonce}
                onRenderError={() => setPreviewError(true)}
                onAnchorClick={(href) => {
                  // The preview canvas has no navigation context: project links
                  // open the REAL website-native project page in a new tab
                  // (/site/<username>/projects/<id> — proxy-served path form),
                  // never the BEAN Folio platform project page.
                  const path = href.startsWith("#") ? href.slice(1) : href;
                  if (path.startsWith("/site/")) window.open(path, "_blank", "noopener");
                }}
              >
                {previewChildren(previewConfig, { interactive: mode === "customization" })}
              </DeviceStage>
            </div>
          )}
        </main>

        {/* collapse rail — Customization: design studio */}
        {mode === "customization" && (
          <PanelCollapseRail side="right" collapsed={rightCollapsed} onToggle={() => setRightCollapsed(!rightCollapsed)} label="design studio" />
        )}

        {/* RIGHT — studio rail (Customization mode only; stays mounted while
            hidden so section selection and panel state survive tab switches) */}
        <aside
          className={cn(
            "min-h-0 w-full flex-col border-border/60 bg-card lg:w-[360px] lg:shrink-0 lg:border-l xl:w-[400px] 2xl:w-[440px]",
            mode === "customization" ? "lg:flex" : "lg:hidden",
            mode === "customization" && customZone === "studio" ? "flex" : "hidden",
            rightCollapsed && "lg:hidden"
          )}
          aria-label="Design studio"
          aria-hidden={mode !== "customization" || customZone !== "studio"}
        >
          <StudioRail
            config={config}
            activePage={activePage}
            activePageId={activePageId}
            selectedSectionId={selectedSectionId}
            categoryOptions={categoryOptions}
            projects={profileData?.projects ?? []}
            logoUploading={logoUploading}
            watermark={design?.watermark ?? true}
            libraryPrefs={libraryPrefs}
            canRevertLastApply={templateSnapshotVersion > 0 && lastTemplateSnapshotRef.current !== null}
            onRevertLastApply={revertLastTemplateApply}
            onSelectPage={selectPage}
            onSelectSection={setSelectedSectionId}
            updateTheme={updateTheme}
            updateMotion={updateMotion}
            updateGlass={updateGlass}
            setPerformanceMode={setPerformanceMode}
            applyPalette={applyPalette}
            applyFont={applyFont}
            applyMotionPreset={applyMotionPreset}
            applyTemplate={applyTemplate}
            previewTemplate={(id) => {
              setLiveTemplatePageId(null);
              setLiveTemplateId(id as TemplateId);
            }}
            applyDesignPreset={applyDesignPreset}
            resetToTemplateDefaults={resetToTemplateDefaults}
            addPage={addPage}
            duplicatePage={duplicatePage}
            removePage={removePage}
            movePage={movePage}
            renamePage={(id, name) => mutatePage(id, (pg) => ({ ...pg, name }))}
            togglePageVisible={(id) => mutatePage(id, (pg) => ({ ...pg, visible: !pg.visible }))}
            addSection={addSection}
            duplicateSection={duplicateSection}
            removeSection={removeSection}
            moveSection={moveSection}
            updateSection={updateSection}
            onTaglineChange={(v) => mutateConfig((c) => ({ ...c, tagline: v }))}
            onLogoUpload={(f) => void handleLogoFile(f)}
            onBeanLogo={useBeanFolioLogo}
            onRemoveLogo={removeLogo}
            onWatermarkChange={(v) => void toggleWatermark(v)}
          />
        </aside>
      </div>

      {/* ---------------- mobile zone switcher (per mode, independent) ---------------- */}
      <nav className="relative z-10 flex shrink-0 border-t border-border/60 bg-background/95 lg:hidden" role="tablist" aria-label="Studio zones">
        {(mode === "giftz"
          ? ([
              { id: "chat", label: "Chat", icon: MessageSquare },
              { id: "preview", label: "Preview", icon: Monitor },
            ] as const)
          : ([
              { id: "content", label: "Content", icon: FileText },
              { id: "preview", label: "Preview", icon: Monitor },
              { id: "studio", label: "Studio", icon: Palette },
            ] as const)
        ).map((z) => {
          const Icon = z.icon;
          const active = mode === "giftz" ? giftzZone === z.id : customZone === z.id;
          const onSelect = () => {
            if (mode === "giftz") setGiftzZone(z.id as GiftzZone);
            else setCustomZone(z.id as CustomizationZone);
          };
          return (
            <button
              key={z.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={onSelect}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center gap-1.5 text-xs transition-colors",
                active ? "bg-gold-soft font-medium text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="size-4" aria-hidden /> {z.label}
            </button>
          );
        })}
      </nav>

      {/* ---------------- published: the real, shareable address ---------------- */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Your website is live</DialogTitle>
            <DialogDescription>
              Anyone with your public link can visit the published website — no account needed. The address stays
              the same when you edit and republish; unpublishing removes public access (your draft is kept).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={canonicalUrl ?? liveHash ?? ""}
                aria-label={canonicalUrl ? "Public website URL" : "Live route on the current deployment"}
                className="h-9 flex-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            {/* platform footer attribution — live setting, applies immediately */}
            <label
              htmlFor="ws-publish-watermark"
              className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="block text-xs font-medium">Footer attribution</span>
                <span className="block text-[11px] text-muted-foreground">
                  Shows a small "Made with BEAN Folio · GIFTZ" credit in your website's footer. Applies
                  immediately — no republish needed.
                </span>
              </span>
              <Switch
                id="ws-publish-watermark"
                checked={design?.watermark ?? true}
                onCheckedChange={(v) => void toggleWatermark(v)}
              />
            </label>
            {canonicalUrl && canonicalKind === "workspace" && (
              <div
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400"
                role="status"
              >
                <p className="font-medium">Shareable now — verified publicly reachable ✓</p>
                <p className="mt-1">
                  Anyone can open this link in any browser — no account, no editor, just your website. The address
                  belongs to this workspace and stays valid while the workspace is live; if the workspace address ever
                  changes, publish again and the dialog will show the current one.
                </p>
                <p className="mt-1">
                  A permanent, workspace-independent domain can be added later via production deployment
                  (NEXT_PUBLIC_APP_URL).
                </p>
              </div>
            )}
            {!canonicalUrl && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400" role="status">
                <p className="font-medium">
                  {canonicalUnavailable?.reason === "unverified-host"
                    ? "This environment's address could not be verified as publicly reachable."
                    : "No permanent public link yet — production domain configuration required."}
                </p>
                <p className="mt-1">
                  {canonicalUnavailable?.message ??
                    "Set NEXT_PUBLIC_APP_URL (for example https://your-domain.com) in the deployment environment and redeploy. The route above works only on the current deployment and is not a permanent share link."}
                </p>
                <p className="mt-1">
                  Copy Link and Share stay disabled until then, so an internal address can never be shared by
                  mistake.
                </p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copyLiveLink()} disabled={!shareTargets.shareUrl}>
                <Link2 className="size-4" aria-hidden /> Copy link
              </Button>
              <Button variant="outline" onClick={() => void shareLive()} disabled={!shareTargets.shareUrl}>
                <Share2 className="size-4" aria-hidden /> Share
              </Button>
              <Button
                onClick={() => {
                  setLinkDialogOpen(false);
                  openLive();
                }}
                disabled={!shareTargets.openUrl}
              >
                <ExternalLink className="size-4" aria-hidden /> Open live website
              </Button>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs font-medium">Host it yourself</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Download your website's code as a standalone ZIP — plain HTML, CSS, JavaScript and local assets with a
                README for Cloudflare Pages, Netlify or GitHub Pages. Exporting never changes your live website or your
                draft.
              </p>
              <Button variant="outline" size="sm" className="mt-2 h-8" onClick={() => void downloadSiteCode()} disabled={exporting}>
                {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
                Download Website Code
              </Button>
            </div>
          </div>
          <DialogFooter>
            <p className="text-xs text-muted-foreground">
              Draft edits stay private until you publish again — the live site only shows the published snapshot.
            </p>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- GIFTZ generated site: its own public address ---------------- */}
      <Dialog open={giftzLinkDialogOpen} onOpenChange={setGiftzLinkDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Your generated website is live</DialogTitle>
            <DialogDescription>
              This GIFTZ website is published at its own address — separate from your portfolio website. Anyone with
              the link can visit it; unpublishing removes public access (the generated draft is kept).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              readOnly
              value={giftzPublishedPath ? `#${giftzPublishedPath}` : ""}
              aria-label="Generated website public route"
              className="h-9 flex-1 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  if (giftzPublishedPath) void navigator.clipboard?.writeText(`${window.location.origin}${giftzPublishedPath}`).catch(() => undefined);
                }}
                disabled={!giftzPublishedPath}
              >
                <Link2 className="size-4" aria-hidden /> Copy link
              </Button>
              <Button
                onClick={() => {
                  setGiftzLinkDialogOpen(false);
                  if (giftzPublishedPath) window.open(giftzPublishedPath, "_blank", "noopener");
                }}
                disabled={!giftzPublishedPath}
              >
                <ExternalLink className="size-4" aria-hidden /> Open generated website
              </Button>
            </div>
            <p className="rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
              A permanent domain link follows the platform's production-domain configuration — the route above is the
              real working address on this deployment. Your portfolio website and its publish state are unaffected.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---------------- explicit publish review (never one-click silent) ---------------- */}
      <Dialog open={publishDialogOpen} onOpenChange={setPublishDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">
              {mode === "giftz"
                ? giftzSite?.status === "PUBLISHED"
                  ? "Update this generated website?"
                  : "Publish this generated website?"
                : published
                  ? "Update the live website?"
                  : "Publish your website?"}
            </DialogTitle>
            <DialogDescription>
              {mode === "giftz"
                ? giftzSite?.status === "PUBLISHED"
                  ? "Republishing replaces the public snapshot of this generated website with its saved draft. Its address stays the same."
                  : "Publishing makes this generated website public at its own address (/site/<username>/g/<id>) — anyone with the link can visit it. Your portfolio website is unaffected."
                : published
                  ? "Republishing replaces the public snapshot with your current saved draft. The address stays the same."
                  : "Publishing makes your website public at its own address (/site/<username>) — anyone with the link can visit it. Your BEAN Folio profile (/u/<username>) stays independent."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            {mode === "giftz" ? (
              <>
                <p>
                  <span className="font-medium text-foreground">“{giftzSite?.title ?? "New generated site"}”</span> — a GIFTZ generated website.
                </p>
                <p>· Publishes the SAVED generated website{proposalPreview ? " — the previewed generation is saved first" : ""}.</p>
                <p>· Your portfolio website and its publish state are untouched.</p>
                <p>· You can unpublish any time — the generated draft is kept.</p>
              </>
            ) : (
              <>
                <p>
                  <span className="font-medium text-foreground">“{config.name}”</span>
                  {config.tagline ? ` — ${config.tagline}` : ""}
                </p>
                <p>· Publishes your SAVED draft{dirty ? " — your unsaved changes are saved first" : ""}.</p>
                <p>· The chat's isolated previews are never published — only what you saved.</p>
                {published && draftAheadOfLive && (
                  <p className="text-amber-600 dark:text-amber-400">· The live site currently shows an older snapshot.</p>
                )}
                <p>· You can unpublish any time — your draft is kept.</p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishDialogOpen(false)}>
              Review more
            </Button>
            <Button onClick={() => { setPublishDialogOpen(false); void publish(); }} disabled={publishing}>
              {publishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CloudUpload className="size-4" aria-hidden />}
              {mode === "giftz" ? (giftzSite?.status === "PUBLISHED" ? "Republish now" : "Publish now") : published ? "Republish now" : "Publish now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- template live preview: REAL render, not a screenshot ---------------- */}
      <Dialog
        open={liveTemplateId !== null}
        onOpenChange={(v) => {
          if (!v) setLiveTemplateId(null);
        }}
      >
        <DialogContent className="flex h-[85vh] max-w-4xl flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="font-display">Live preview — {liveTemplatePreset?.label}</DialogTitle>
            <DialogDescription>
              Rendered with your real content through the live renderer. Applying changes colors, fonts, spacing and
              motion — your pages, sections and publish state are kept.
            </DialogDescription>
          </DialogHeader>
          {/* desktop + mobile preview toggle — real render at each device width */}
          <div className="flex shrink-0 items-center gap-1 self-start rounded-lg border border-border/60 p-0.5" role="tablist" aria-label="Template preview device">
            {(Object.keys(DEVICE_PRESETS) as (keyof typeof DEVICE_PRESETS)[]).map((d) => {
              const Icon = DEVICE_PRESETS[d].icon;
              return (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={templatePreviewDevice === d}
                  aria-label={`${DEVICE_PRESETS[d].label} template preview`}
                  onClick={() => setTemplatePreviewDevice(d)}
                  className={cn(
                    "flex min-h-[28px] items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                    templatePreviewDevice === d ? "bg-gold-soft font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">{DEVICE_PRESETS[d].label}</span>
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-muted/30 p-2">
            {liveTemplateConfig && (
              <DeviceStage deviceWidth={DEVICE_PRESETS[templatePreviewDevice].width} label={`${liveTemplatePreset?.label ?? "Template"} live preview`} minHeight={300}>
                <SiteRenderer
                  config={liveTemplateConfig}
                  profile={previewProfile}
                  projects={profileData?.projects ?? []}
                  collections={profileData?.collections ?? []}
                  watermark={design?.watermark ?? true}
                  pageId={liveTemplatePageId ?? liveTemplateConfig.pages[0]?.id}
                  onPageChange={(id) => setLiveTemplatePageId(id)}
                />
              </DeviceStage>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setLiveTemplateId(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (!liveTemplateId) return;
                applyTemplate(liveTemplateId);
                setLiveTemplateId(null);
              }}
            >
              Apply template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- restore previous version ---------------- */}
      <Dialog open={revisionsOpen} onOpenChange={setRevisionsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Restore previous version</DialogTitle>
            <DialogDescription>
              Snapshots are taken automatically before a save overwrites your draft (and before a restore).
              Restoring replaces the current draft; the version you just left is snapshotted too, so this is
              always reversible. Nothing is published by restoring.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-72 space-y-2 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
            {revisionsLoading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading versions…
              </div>
            ) : revisions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No previous versions yet — a snapshot appears the first time you save over an existing draft.
              </p>
            ) : (
              revisions.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-md border border-border/60 p-2.5">
                  <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{r.label}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()} · {r.summary}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void restoreRevision(r.id)} disabled={!r.restorable || restoringId !== null}>
                    {restoringId === r.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                    Restore
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevisionsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
