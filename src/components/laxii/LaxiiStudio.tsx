"use client";

/**
 * LAXII Studio — the conversational creative workspace.
 *
 * One studio, three creation workflows behind a unified creation-type
 * dropdown (Banner / Avatar / Resume — default Banner):
 *  - Banner: platform presets, exact canvases, safe areas (existing engine).
 *  - Avatar: no-prompt style presets, reference photos, background removal.
 *  - Resume: guided document generation on the shared conversation infra
 *    (separate document service — never routed through image providers).
 *
 * Layout: left sidebar (chats/gallery/resumes) · center thread (messages,
 * variants, selected preview, compare) · bottom composer. Image actions
 * (Edit, Variations, Upscale, Remove background, Expand, Export, Download,
 * Favourite, Continue) operate on the SELECTED version; every edit continues
 * from a real parent image — the full version tree is preserved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  Crop,
  Download,
  Eraser,
  FileText,
  Heart,
  ImagePlus,
  Layers,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
  Undo2,
  Redo2,
  UserRound,
  X,
  RectangleHorizontal,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { uploadFile } from "@/lib/client";
import {
  laxiiApi,
  LAXII_PROMPT_MAX,
  type LaxiiBriefResponse,
  type LaxiiCapabilities,
  type LaxiiConversationDetail,
  type LaxiiConversationSummary,
  type LaxiiGalleryImage,
  type LaxiiMessage,
  type LaxiiVersion,
  type ResumeSummary,
} from "@/lib/laxii-client";
import { LaxiiSidebar, type SidebarTab, type CreationMode } from "./LaxiiSidebar";
import { LaxiiBannerPanel } from "./LaxiiBannerPanel";
import { LaxiiResumePanel } from "./LaxiiResumePanel";
import { LaxiiImageLightbox, type LightboxItem } from "./LaxiiImageLightbox";
import { BriefReviewCard, BriefPipelineProgress, QualityFindingsPanel } from "./LaxiiBriefReview";
import { IntegrationRequestDialog } from "./IntegrationRequestDialog";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/**
 * Prompt budget mirror — the server refuses prompts beyond this limit
 * (src/lib/laxii/service.ts), so the composer blocks early with a clear
 * message instead of a round-trip 400.
 */
const PROMPT_MAX = LAXII_PROMPT_MAX;

/** The single fixed banner canvas — must match BANNER_PRESETS in src/lib/laxii/banner-presets.ts. */
const BEAN_BANNER_SLUG = "bean-folio-banner";

/** sessionStorage key carrying a Riishe→LAXII brief taskId across the handoff navigation. */
const BRIEF_STORAGE_KEY = "bean:laxii-pending-brief";

interface UploadedRef {
  mediaId: string;
  url: string;
  name: string;
}

export function LaxiiStudio() {
  const [caps, setCaps] = useState<LaxiiCapabilities | null>(null);
  const [conversations, setConversations] = useState<LaxiiConversationSummary[]>([]);
  const [resumes, setResumes] = useState<ResumeSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LaxiiConversationDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Active creation workflow for NEW creations (dropdown default: Banner).
  const [mode, setMode] = useState<CreationMode>("banner");

  // Composer state
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<string>("1:1");
  const [count, setCount] = useState(1);
  const [refs, setRefs] = useState<UploadedRef[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [avatarPreset, setAvatarPreset] = useState<string>("professional-headshot");

  // Edit context — the version the next operation will build on.
  const [editParent, setEditParent] = useState<LaxiiVersion | null>(null);

  // Banner composer state — one fixed BEAN Folio canvas (2048×687).
  const [bannerPreset, setBannerPreset] = useState(BEAN_BANNER_SLUG);

  // Conversational engine controls (Phase 4/5): LAXII V1 is the single
  // user-facing image engine (no engine picker — the server refuses any
  // other engine instead of silently rerouting). Optional quality tier and
  // the no-prompt Style Registry remain.
  // aspect/count are only sent when the user actually touched the selectors —
  // untouched AUTO turns let the server derive them (style default / the
  // source image's real ratio), so a casual "make it brighter" never
  // silently reframes the image.
  const [quality, setQuality] = useState("");
  const [styleSlug, setStyleSlug] = useState("");
  const [aspectTouched, setAspectTouched] = useState(false);
  const [countTouched, setCountTouched] = useState(false);

  // Generation state
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Sidebar/gallery state
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats");
  const [gallery, setGallery] = useState<LaxiiGalleryImage[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);

  // Overlays
  const [compare, setCompare] = useState<{ before: LaxiiVersion; after: LaxiiVersion } | null>(null);

  // Phase 3: Riishe→LAXII structured brief handoff.
  const [briefTask, setBriefTask] = useState<LaxiiBriefResponse | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  // Image preview (lightbox) — a descriptor of WHICH image set is open; the
  // items themselves derive from live state, so favourite/selection flags in
  // the preview stay fresh after actions taken inside it.
  const [lightboxSource, setLightboxSource] = useState<
    | { kind: "message"; messageId: string; index: number }
    | { kind: "gallery"; index: number }
    | { kind: "refs"; index: number }
    | { kind: "single"; items: LightboxItem[]; index: number }
    | null
  >(null);
  const [mobileSidebar, setMobileSidebar] = useState(false);

  // Independent thread scrolling — auto-follows the latest message only while
  // the user is already near the bottom, so reading older history is never hijacked.
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastConvIdRef = useRef<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const reloadConversations = useCallback(() => {
    let alive = true;
    laxiiApi
      .conversations()
      .then((r) => alive && setConversations(r.conversations))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const loadResumes = useCallback(() => {
    let alive = true;
    laxiiApi
      .resumeList()
      .then((r) => alive && setResumes(r.resumes))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const loadGallery = useCallback((tab: SidebarTab) => {
    if (tab !== "chats" && tab !== "resumes") {
      setGalleryLoading(true);
      let alive = true;
      const filter =
        tab === "favourites" ? "favourites" : tab === "banners" ? "banners" : tab === "avatars" ? "avatars" : "all";
      laxiiApi
        .images(filter)
        .then((r) => {
          if (alive) setGallery(r.images);
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) setGalleryLoading(false);
        });
      return () => {
        alive = false;
      };
    }
    return undefined;
  }, []);

  // Initial capabilities + conversations + resume library.
  useEffect(() => {
    const cleanupCaps = (() => {
      let alive = true;
      laxiiApi
        .capabilities()
        .then((c) => {
          if (alive) setCaps(c);
        })
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    })();
    const cleanupConvs = reloadConversations();
    const cleanupResumes = loadResumes();
    return () => {
      cleanupCaps();
      cleanupConvs();
      cleanupResumes();
    };
  }, [reloadConversations, loadResumes]);

  // Gallery per tab.
  useEffect(() => {
    const cleanup = loadGallery(sidebarTab);
    return cleanup;
  }, [sidebarTab, loadGallery]);

  // Phase 3: brief handoff intake. The RIISHE delegation card stores the
  // brief's taskId in sessionStorage before navigating here (the hash router
  // strips query params, so sessionStorage is the transport). The brief is
  // fetched with full ownership enforcement and shown for review.
  useEffect(() => {
    let alive = true;
    const raw = typeof window !== "undefined" ? sessionStorage.getItem(BRIEF_STORAGE_KEY) : null;
    if (!raw) return;
    sessionStorage.removeItem(BRIEF_STORAGE_KEY);
    setMode("banner");
    laxiiApi
      .brief(raw)
      .then(async (r) => {
        if (!alive) return;
        setBriefTask(r);
        const convId = r.generation.conversationId;
        if (convId) {
          try {
            const d = await laxiiApi.conversation(convId);
            if (!alive) return;
            setActiveId(convId);
            setDetail(d);
          } catch {
            // thread gone — the brief card still renders and can regenerate
          }
        }
      })
      .catch(() => {
        if (alive) toast.error("Could not load the design brief handoff — start again from RIISHE.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const convId = detail?.conversation.id ?? null;
  const messageCount = detail?.messages.length ?? 0;
  const runningCount = detail?.messages.filter((m) => m.status === "RUNNING").length ?? 0;

  // Composer textarea auto-grows with content but is capped: a pasted novel
  // scrolls inside the textarea instead of pushing the composer/thread around.
  useEffect(() => {
    const el = promptTextareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [prompt]);

  // New conversation or fresh composer → reset the follow state.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    if (!convId) {
      nearBottomRef.current = true;
      lastConvIdRef.current = null;
      el.scrollTop = 0;
    }
  }, [convId]);

  // Keep the thread readable: opening a conversation jumps to its end; new
  // messages and generation results bring the latest message into view — but
  // only while the user is already near the bottom, so inspecting older
  // history is never interrupted.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el || !convId) return;
    if (lastConvIdRef.current !== convId) {
      lastConvIdRef.current = convId;
      nearBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight });
      return;
    }
    if (nearBottomRef.current && threadEndRef.current) {
      const end = threadEndRef.current;
      const target = end.offsetTop + end.offsetHeight - el.clientHeight;
      el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }, [messageCount, runningCount, busy, convId]);

  // Re-attach to jobs that are already running on the server (reopened
  // conversation, remount after a route change, or a lost polling connection).
  // Without this a reopened thread would show the honest RUNNING card forever
  // with no way to follow it — the poll resumes automatically instead.
  const reattachKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || busy) return;
    const running = detail.messages.find((m) => m.status === "RUNNING");
    const convId = detail.conversation.id;
    if (!running) {
      if (reattachKeyRef.current?.startsWith(`${convId}:`)) reattachKeyRef.current = null;
      return;
    }
    const key = `${convId}:${running.id}`;
    if (reattachKeyRef.current === key) return;
    reattachKeyRef.current = key;
    const controller = new AbortController();
    void pollGenerationJob(convId, running.id, controller.signal, {
      banner: detail.conversation.kind === "BANNER",
      avatar: detail.conversation.kind === "AVATAR",
    });
    return () => controller.abort();
  }, [detail?.conversation.id, runningCount, busy]);

  const openConversation = useCallback((id: string) => {
    setActiveId(id);
    setEditParent(null);
    setLoadingDetail(true);
    setMobileSidebar(false);
    let alive = true;
    laxiiApi
      .conversation(id)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        const selected = findSelected(d);
        if (selected) setEditParent(selected);
        // The size selector always shows the single BEAN Folio option; a
        // legacy conversation keeps rendering/exporting at its own stored
        // canvas (server-side), so no size state is restored here.
      })
      .catch((e) => {
        if (alive) toast.error(e instanceof Error ? e.message : "Could not load the conversation.");
      })
      .finally(() => {
        if (alive) setLoadingDetail(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Load detail when activeId set from gallery etc.
  useEffect(() => {
    if (activeId && !detail) openConversation(activeId);
  }, [activeId, detail, openConversation]);

  function findSelected(d: LaxiiConversationDetail): LaxiiVersion | null {
    for (let i = d.messages.length - 1; i >= 0; i -= 1) {
      const sel = d.messages[i].versions.find((v) => v.isSelected);
      if (sel) return sel;
    }
    return null;
  }

  const selectedVersion = useMemo(() => (detail ? findSelected(detail) : null), [detail]);
  // Phase 3: the meta of the message that produced the selected version —
  // drives the brief approval gate on the banner export panel.
  const selectedMessageMeta = useMemo(() => {
    if (!detail || !selectedVersion) return null;
    return detail.messages.find((m) => m.versions.some((v) => v.id === selectedVersion.id))?.meta ?? null;
  }, [detail, selectedVersion]);
  const isBannerConv = detail?.conversation.kind === "BANNER";
  const isResumeConv = detail?.conversation.kind === "RESUME";
  const activePreset = caps?.bannerPresets.find((p) => p.slug === bannerPreset) ?? null;

  /** Composer workflow: derive from the open conversation, else the dropdown mode. */
  function composerMode(): "banner" | "avatar" | "image" | "resume" {
    if (detail) {
      if (detail.conversation.kind === "BANNER") return "banner";
      if (detail.conversation.kind === "RESUME") return "resume";
      // Avatar conversations keep their dedicated composer (style presets,
      // reference photos) when reopened from the sidebar or gallery.
      if (detail.conversation.kind === "AVATAR") return "avatar";
      return "image";
    }
    return mode;
  }

  function startNewCreation(nextMode?: CreationMode) {
    const m = nextMode ?? mode;
    setActiveId(null);
    setDetail(null);
    setEditParent(null);
    setPrompt("");
    setRefs([]);
    setMode(m);
    setAspectTouched(false);
    setCountTouched(false);
    setStyleSlug("");
    if (m === "avatar") {
      const preset = caps?.avatarPresets.find((p) => p.slug === avatarPreset);
      if (preset) setAspect(preset.defaultAspect);
    }
    setMobileSidebar(false);
  }

  /** Dropdown selection switches the active workflow immediately. */
  const handleCreationModeChange = useCallback(
    (m: CreationMode) => {
      setMode(m);
      setActiveId(null);
      setDetail(null);
      setEditParent(null);
      setPrompt("");
      setRefs([]);
      setAspectTouched(false);
      setCountTouched(false);
      setStyleSlug("");
      if (m === "avatar") {
        const preset = caps?.avatarPresets.find((p) => p.slug === avatarPreset);
        if (preset) setAspect(preset.defaultAspect);
        toast.info("Avatar studio ready — pick a style, add reference photos (optional) and generate.");
      } else if (m === "resume") {
        toast.info("Resume studio ready — fill your facts or upload an existing resume.");
      }
    },
    [caps, avatarPreset]
  );

  function handleAvatarPresetChange(slug: string) {
    setAvatarPreset(slug);
    const preset = caps?.avatarPresets.find((p) => p.slug === slug);
    if (preset) setAspect(preset.defaultAspect);
  }

  async function uploadReferences(files: FileList) {
    setUploadingRef(true);
    // The engine's real reference budget (capability-based) — never promise
    // the user more reference slots than the active engine accepts.
    const cap = providerCapability?.maxRefs && providerCapability.maxRefs > 0 ? Math.min(4, providerCapability.maxRefs) : 4;
    try {
      for (const file of Array.from(files).slice(0, cap)) {
        const res = await uploadFile(file);
        if (res.media.kind !== "IMAGE") {
          toast.error("Only image files can be used as references.");
          continue;
        }
        setRefs((r) => [...r, { mediaId: res.media.id, url: res.media.url, name: file.name }].slice(0, cap));
        if (refs.length + 1 >= cap) toast.info(`This engine accepts up to ${cap} reference images.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingRef(false);
    }
  }

  /** Composer send: banner/avatar keep their explicit operations; plain image
   * mode is CONVERSATIONAL — the edit chip pins a deterministic EDIT, and
   * everything else goes to the server-side intent classifier (AUTO). */
  function sendComposer() {
    if (busy) return;
    const c = composerMode();
    if (c === "banner") return void runGeneration("BANNER");
    if (c === "avatar") return void runGeneration("GENERATE");
    return void runGeneration(editParent ? "EDIT" : "AUTO");
  }

  async function runGeneration(
    operation: "AUTO" | "GENERATE" | "EDIT" | "VARIATIONS" | "UPSCALE" | "REMOVE_BACKGROUND" | "EXPAND" | "BANNER",
    /** Explicit edit parent — used by preview actions so the operation builds
        on the exact image the user acted on, never a stale closure value. */
    opts?: { parentVersion?: LaxiiVersion | null; promptOverride?: string }
  ) {
    if (busy) return;
    // LAXII V1 availability gate — refuse honestly, never substitute an engine.
    if (caps?.engine && !caps.engine.available) {
      toast.error(caps.engine.note);
      return;
    }
    const cm = composerMode();
    const isAvatar = operation === "GENERATE" && cm === "avatar";
    const isBanner = operation === "BANNER";
    const parent = opts && opts.parentVersion !== undefined ? opts.parentVersion : editParent;
    const text = (opts?.promptOverride ?? prompt).trim();
    // Client-side prompt budget guard — matches the server schema so an
    // over-limit prompt fails here with a clear, actionable message instead
    // of a round-trip 400. A mid-generation edit can never exceed the cap:
    // the textarea's maxLength clamps input as the user types.
    if (text.length > PROMPT_MAX) {
      toast.error(
        `Prompt is too long — ${text.length.toLocaleString()} characters, the limit is ${PROMPT_MAX.toLocaleString()}. Shorten the prompt and try again.`
      );
      return;
    }
    const activeStyle = styleSlug && styleSlug !== "none" ? styleSlug : "";
    const needsPrompt =
      operation === "EDIT" || isBanner || (operation === "GENERATE" && (isAvatar ? avatarPreset === "custom" : true));
    // AUTO may go prompt-less only when a compiled style carries the brief.
    if ((needsPrompt || operation === "AUTO") && !text && !(operation === "AUTO" && activeStyle)) {
      toast.error(
        isBanner
          ? "Describe the banner you want."
          : isAvatar && avatarPreset === "custom"
            ? "Describe the avatar you want, or pick a style preset."
            : operation === "AUTO" && activeStyle
              ? "Pick a style or describe what you want to create."
              : "Describe what you want to create."
      );
      return;
    }
    if (!isBanner && operation !== "GENERATE" && operation !== "AUTO" && !parent) {
      toast.error("Select an image first — this operation edits the selected image.");
      return;
    }

    setBusy(true);
    setBusyLabel(
      operation === "GENERATE"
        ? isAvatar
          ? "Creating your avatar…"
          : "Creating…"
        : operation === "EDIT"
          ? "Editing…"
          : operation === "VARIATIONS"
            ? "Exploring variations…"
            : operation === "UPSCALE"
              ? "Enhancing detail…"
              : operation === "REMOVE_BACKGROUND"
                ? "Isolating subject…"
                : operation === "EXPAND"
                  ? "Extending canvas…"
                  : "Designing banner…"
    );
    const controller = new AbortController();
    abortRef.current = controller;
    const startedFromConvId = activeId;

    try {
      // Job creation returns immediately (202) — the engine runs in a server
      // job so a long real render never holds this request open (the old
      // synchronous POST could be cut off by proxies with a bare 502 while
      // the generation actually succeeded server-side). The thread below
      // renders the job's true RUNNING → DONE/FAILED state.
      const res = await laxiiApi.generate(
        {
          conversationId: activeId ?? undefined,
          prompt: text,
          operation,
          aspect: aspectTouched || operation !== "AUTO" ? aspect : undefined,
          count:
            operation === "GENERATE" || operation === "AUTO"
              ? countTouched || operation !== "AUTO"
                ? count
                : undefined
              : 1,
          // LAXII V1 — the managed gateway is the only user-facing engine.
          provider: "managed" as const,
          quality: (quality || undefined) as "1K" | "2K" | "4K" | undefined,
          referenceMediaIds: refs.map((r) => r.mediaId),
          parentVersionId: !isBanner && operation !== "GENERATE" && operation !== "AUTO" ? parent?.id : undefined,
          banner: isBanner ? { presetSlug: bannerPreset } : undefined,
          avatar: isAvatar && avatarPreset !== "custom" ? { presetSlug: avatarPreset } : undefined,
          style: activeStyle && cm === "image" && (operation === "AUTO" || operation === "GENERATE") ? { slug: activeStyle } : undefined,
        },
        controller.signal
      );

      setActiveId(res.conversationId);
      setSidebarTab("chats");
      const d = await laxiiApi.conversation(res.conversationId);
      setDetail(d);
      reloadConversations();
      if (res.duplicate) {
        toast.info("Reattached to the generation already in progress.");
      }
      await pollGenerationJob(res.conversationId, res.messageId, controller.signal, {
        banner: isBanner,
        avatar: isAvatar,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast.info("Stopped watching — the generation continues and will appear in this conversation.");
        // Refresh thread — the job keeps its honest RUNNING state in the DB.
        if (startedFromConvId) {
          laxiiApi.conversation(startedFromConvId).then(setDetail).catch(() => undefined);
        }
      } else {
        const message = e instanceof Error ? e.message : "Generation failed";
        toast.error(message);
        if (startedFromConvId) {
          laxiiApi.conversation(startedFromConvId).then(setDetail).catch(() => undefined);
        }
        reloadConversations();
      }
    } finally {
      setBusy(false);
      setBusyLabel("");
      abortRef.current = null;
    }
  }

  /**
   * Poll the conversation until the job message reaches a terminal state.
   * Every poll is a short-lived request — the slow engine render happens
   * server-side, so no proxy can kill it with a 502. Warnings and errors come
   * from the job message itself (honest states only).
   */
  async function pollGenerationJob(
    conversationId: string,
    messageId: string,
    signal: AbortSignal,
    labels: { banner: boolean; avatar: boolean }
  ) {
    const successLabel = labels.banner ? "Banner generated." : labels.avatar ? "Avatar generated." : "Image generated.";
    const deadline = Date.now() + 7 * 60 * 1000; // long jobs keep rendering; the RUNNING card stays honest
    let consecutiveErrors = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      if (signal.aborted) return;
      let d: LaxiiConversationDetail;
      try {
        d = await laxiiApi.conversation(conversationId);
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 5) {
          toast.info("Lost the connection while waiting — reopen this chat to see the result.");
          return;
        }
        continue;
      }
      if (signal.aborted) return;
      setDetail(d);
      const m = d.messages.find((x) => x.id === messageId);
      if (!m) return; // thread replaced or deleted
      if (m.status === "DONE") {
        const selected = findSelected(d);
        if (selected) setEditParent(selected);
        const warnings = m.meta?.warnings ?? [];
        if (warnings.length > 0) toast.warning(warnings[0]);
        else toast.success(successLabel);
        // The submitted prompt STAYS in the composer after completion — the
        // user decides when to clear or edit it. Clearing only the reference
        // chips keeps the completed turn's inputs readable in the thread.
        setRefs([]);
        reloadConversations();
        return;
      }
      if (m.status === "FAILED") {
        toast.error(m.error ?? "Generation failed.");
        reloadConversations();
        return;
      }
    }
    toast.info("Still generating — the result will appear in this conversation when it's ready.");
  }

  /**
   * Re-run a failed job from its thread card: same user words, same recorded
   * operation. Best-effort on the edit source (the currently selected version
   * stands in when the original parent is unknown) — honest, and one click.
   */
  async function retryFromMessage(messageId: string) {
    if (!detail || busy) return;
    const idx = detail.messages.findIndex((m) => m.id === messageId);
    if (idx < 1) return;
    const failed = detail.messages[idx];
    const userMsg = [...detail.messages.slice(0, idx)].reverse().find((m) => m.role === "USER");
    const op = (failed.operation ?? "GENERATE") as
      | "AUTO"
      | "GENERATE"
      | "EDIT"
      | "VARIATIONS"
      | "UPSCALE"
      | "REMOVE_BACKGROUND"
      | "EXPAND"
      | "BANNER";
    void runGeneration(op, {
      promptOverride: userMsg?.text ?? "",
      parentVersion: op === "GENERATE" || op === "AUTO" ? null : selectedVersion,
    });
  }

  /**
   * Phase 3: run the professional banner pipeline from an approved Riishe
   * brief. The brief supplies prompt/canvas/typography server-side; the free
   * composer is bypassed. Polling + toasts reuse the same machinery.
   */
  async function runBriefGeneration() {
    if (!briefTask || busy) return;
    setBusy(true);
    setBusyLabel("Producing banner from the approved brief…");
    const controller = new AbortController();
    abortRef.current = controller;
    const taskId = briefTask.task.id;
    try {
      const res = await laxiiApi.generate(
        {
          conversationId: briefTask.generation.conversationId ?? activeId ?? undefined,
          prompt: "",
          operation: "BANNER",
          briefTaskId: taskId,
        },
        controller.signal
      );
      setActiveId(res.conversationId);
      setSidebarTab("chats");
      const d = await laxiiApi.conversation(res.conversationId);
      setDetail(d);
      reloadConversations();
      laxiiApi.brief(taskId).then(setBriefTask).catch(() => undefined);
      await pollGenerationJob(res.conversationId, res.messageId, controller.signal, { banner: true, avatar: false });
      // Refresh the brief state (approval link + status) after the pipeline ends.
      laxiiApi.brief(taskId).then(setBriefTask).catch(() => undefined);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        toast.info("Stopped watching — the banner pipeline continues and will appear in this conversation.");
      } else {
        toast.error(e instanceof Error ? e.message : "Could not start the brief generation.");
      }
      reloadConversations();
      laxiiApi.brief(taskId).then(setBriefTask).catch(() => undefined);
    } finally {
      setBusy(false);
      setBusyLabel("");
      abortRef.current = null;
    }
  }

  /** Record the user's approve/reject decision on a brief-produced result. */
  async function decideBriefResult(decision: "approved" | "rejected", messageId: string) {
    if (!briefTask || !messageId) return;
    setDecisionBusy(true);
    try {
      const next = await laxiiApi.briefAction(
        decision === "approved"
          ? { action: "approve-result", taskId: briefTask.task.id, messageId }
          : { action: "reject-result", taskId: briefTask.task.id, messageId }
      );
      setBriefTask(next as LaxiiBriefResponse);
      toast.success(
        decision === "approved"
          ? "Result approved — export unlocked."
          : "Result rejected — request changes on the brief and generate again."
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record the decision.");
    } finally {
      setDecisionBusy(false);
    }
  }

  async function selectVersion(v: LaxiiVersion) {
    if (v.isSelected) {
      setEditParent(v);
      return;
    }
    try {
      await laxiiApi.select(v.id);
      setEditParent(v);
      if (activeId) {
        const d = await laxiiApi.conversation(activeId);
        setDetail(d);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not select this version");
    }
  }

  async function toggleFavourite(v: LaxiiVersion) {
    try {
      const res = await laxiiApi.favourite(v.id);
      if (activeId) {
        const d = await laxiiApi.conversation(activeId);
        setDetail(d);
      }
      if (sidebarTab !== "chats" && sidebarTab !== "resumes") loadGallery(sidebarTab);
      toast.success(res.isFavourite ? "Added to favourites." : "Removed from favourites.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update favourite");
    }
  }

  async function toggleFavouriteFromGallery(img: LaxiiGalleryImage) {
    try {
      await laxiiApi.favourite(img.id);
      if (sidebarTab !== "chats" && sidebarTab !== "resumes") loadGallery(sidebarTab);
    } catch {
      toast.error("Could not update favourite");
    }
  }

  async function exportSelected(format: "png" | "jpeg" | "webp") {
    if (!selectedVersion) return;
    try {
      const res = await laxiiApi.exportImage(selectedVersion.id, format);
      toast.success(`Exported at exactly ${res.export.width}×${res.export.height} ${res.export.mime.split("/")[1].toUpperCase()}.`);
      // Real file download (verified pixels) — a plain window.open would open
      // a viewer tab instead of saving the file.
      const ext = res.export.mime.split("/")[1] || format;
      const a = document.createElement("a");
      a.href = res.export.url;
      a.download = `laxii-${selectedVersion.id.slice(0, 8)}-${res.export.width}x${res.export.height}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    }
  }

  /** Undo/redo = navigate the version tree by re-selecting ancestors/descendants. */
  async function navigateTree(direction: "undo" | "redo") {
    if (!detail || !selectedVersion) return;
    if (direction === "undo") {
      if (!selectedVersion.parentVersionId) {
        toast.info("Nothing to undo — this is the original.");
        return;
      }
      const parent = detail.messages.flatMap((m) => m.versions).find((v) => v.id === selectedVersion.parentVersionId);
      if (parent) await selectVersion(parent);
    } else {
      const children = detail.messages
        .flatMap((m) => m.versions)
        .filter((v) => v.parentVersionId === selectedVersion.id);
      if (children.length === 0) {
        toast.info("Nothing to redo — no edits after this version yet.");
        return;
      }
      await selectVersion(children[children.length - 1]);
    }
  }

  const parentOfSelected = useMemo(() => {
    if (!detail || !selectedVersion?.parentVersionId) return null;
    return detail.messages.flatMap((m) => m.versions).find((v) => v.id === selectedVersion.parentVersionId) ?? null;
  }, [detail, selectedVersion]);

  const availableAspects = useMemo(() => {
    const p = caps?.providers.find((x) => x.id === caps?.defaultProvider);
    return p?.aspects ?? ASPECTS;
  }, [caps]);

  // Capability data still drives which actions exist — it just never names the
  // underlying provider in the UI (the unified LAXII identity).
  const providerCapability = useMemo(() => {
    const p = caps?.providers.find((x) => x.id === caps?.defaultProvider);
    if (!p) return null;
    return {
      info: p,
      upscale: p.capabilities.upscale.supported,
      removeBackground: p.capabilities.removeBackground.supported,
      expand: p.capabilities.expand.supported,
      variations: p.capabilities.variations.supported,
      maxRefs: p.capabilities.generate.maxReferences ?? 0,
    };
  }, [caps]);

  // LAXII V1 — the single user-facing engine. When the managed gateway is not
  // configured, generation is disabled with the honest reason (no engine
  // substitution happens anywhere in the pipeline).
  const laxiiV1 = caps?.engine ?? null;

  // ------------------------------------------------------------------ lightbox
  // Click-to-open image preview shared by every LAXII image surface.

  const operationLabel = (op: string | null | undefined) =>
    op ? op.charAt(0) + op.slice(1).toLowerCase().replace(/_/g, " ") : null;

  /** Preview item for a version, with the conversation-context actions. */
  function versionLightboxItem(v: LaxiiVersion, message?: LaxiiMessage | null): LightboxItem {
    return {
      key: v.id,
      url: v.url,
      prompt: v.prompt || message?.text || null,
      width: v.width,
      height: v.height,
      operationLabel: operationLabel(v.operation ?? message?.operation ?? null),
      isFavourite: v.isFavourite,
      isSelected: v.isSelected,
      onSelect: () => void selectVersion(v),
      onFavourite: () => void toggleFavourite(v),
      onEdit: () => void runVersionPreviewAction(v, "edit"),
      onVariations: providerCapability?.variations ? () => void runVersionPreviewAction(v, "variations") : undefined,
      onRemoveBackground: providerCapability?.removeBackground
        ? () => void runVersionPreviewAction(v, "removeBackground")
        : undefined,
      onContinue: () => void runVersionPreviewAction(v, "continue"),
    };
  }

  /**
   * Lightbox actions that continue in the thread: the thread's selected
   * version is the source of truth for edit operations, so select the acted-on
   * version first (when needed), close the preview, then run the action with
   * an explicit parent — never a stale closure value.
   */
  async function runVersionPreviewAction(
    v: LaxiiVersion,
    action: "edit" | "variations" | "removeBackground" | "continue"
  ) {
    setLightboxSource(null);
    if (!v.isSelected) await selectVersion(v);
    setEditParent(v);
    if (action === "edit" || action === "continue") {
      document.querySelector<HTMLTextAreaElement>('[data-testid="laxii-prompt"]')?.focus();
      return;
    }
    void runGeneration(action === "variations" ? "VARIATIONS" : "REMOVE_BACKGROUND", { parentVersion: v });
  }

  /** Open the preview for a version — sibling variations stay navigable. */
  function openVersionLightbox(v: LaxiiVersion) {
    const m = detail?.messages.find((msg) => msg.versions.some((x) => x.id === v.id)) ?? null;
    if (m) {
      const idx = Math.max(0, m.versions.findIndex((x) => x.id === v.id));
      setLightboxSource({ kind: "message", messageId: m.id, index: idx });
    } else {
      setLightboxSource({ kind: "single", items: [versionLightboxItem(v)], index: 0 });
    }
  }

  // Items are derived on demand — the lightbox renders only while open, so a
  // plain per-render mapping is plenty and always reflects fresh flags.
  const lightboxItems: LightboxItem[] = (() => {
    if (!lightboxSource) return [];
    if (lightboxSource.kind === "message") {
      const m = detail?.messages.find((x) => x.id === lightboxSource.messageId);
      if (!m) return [];
      return m.versions.map((v) => versionLightboxItem(v, m));
    }
    if (lightboxSource.kind === "gallery") {
      return gallery.map((img) => ({
        key: img.id,
        url: img.url,
        prompt: img.prompt || img.conversationTitle,
        width: img.width ?? img.canvasWidth,
        height: img.height ?? img.canvasHeight,
        operationLabel: operationLabel(img.operation),
        isFavourite: img.isFavourite,
        onFavourite: () => void toggleFavouriteFromGallery(img),
        onOpenConversation: () => {
          setLightboxSource(null);
          setDetail(null);
          openConversation(img.conversationId);
        },
      }));
    }
    if (lightboxSource.kind === "refs") {
      return refs.map((r) => ({ key: r.mediaId, url: r.url, prompt: `Reference — ${r.name}` }));
    }
    return lightboxSource.items;
  })();

  const sidebarNode = (
    <LaxiiSidebar
      conversations={conversations}
      activeId={activeId}
      tab={sidebarTab}
      gallery={gallery}
      galleryLoading={galleryLoading}
      caps={caps}
      resumes={resumes}
      creationMode={mode}
      onTabChange={(t) => setSidebarTab(t)}
      onOpenConversation={(id) => {
        setDetail(null);
        openConversation(id);
      }}
      onCreationModeChange={handleCreationModeChange}
      onNewCreation={() => startNewCreation()}
      onDeleteConversation={async (id) => {
        try {
          await laxiiApi.deleteConversation(id);
          if (id === activeId) startNewCreation();
          reloadConversations();
          loadResumes();
          toast.success("Conversation deleted.");
        } catch {
          toast.error("Could not delete the conversation.");
        }
      }}
      onOpenImage={(img) => {
        setDetail(null);
        openConversation(img.conversationId);
      }}
      onPreviewImage={(img) => {
        const idx = Math.max(0, gallery.findIndex((g) => g.id === img.id));
        setLightboxSource({ kind: "gallery", index: idx });
      }}
      onToggleFavourite={(versionId) => {
        const v = detail?.messages.flatMap((m) => m.versions).find((x) => x.id === versionId);
        if (v) void toggleFavourite(v);
      }}
      onToggleFavouriteFromGallery={toggleFavouriteFromGallery}
    />
  );

  const cm = composerMode();

  return (
    <Sheet open={mobileSidebar} onOpenChange={setMobileSidebar}>
      <div
        className="relative mx-auto flex h-[calc(100dvh-8.8125rem-env(safe-area-inset-bottom))] min-h-0 w-full max-w-[1600px] overflow-hidden px-0 md:h-[calc(100dvh-4.0625rem)] md:px-6"
        data-testid="laxii-studio"
      >
      {/* Desktop sidebar — solid obsidian panel. The former translucent
          glass treatment (bg-white/[0.02] + backdrop-blur-xl) read as an
          unwanted faded shade over the list; a solid token background keeps
          borders and gold accents while every row stays fully legible. */}
      <aside className="hidden h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-l-3xl border border-white/10 bg-sidebar md:flex">
        {sidebarNode}
      </aside>

      {/* Center thread — the workspace column: full height of the studio row,
          flex column, overflow contained. Header shrink-0 / messages flex-1
          min-h-0 overflow-y-auto / composer shrink-0 give the thread its own
          independent vertical scroll while the composer stays pinned. */}
      <main
        className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-white/10 md:border-l"
        aria-label="LAXII creation thread"
      >
        {/* Thread header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
          {/* Mobile studio menu — a normal flex participant, no absolute overlay. */}
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="size-8 shrink-0 border-white/15 bg-black/50 md:hidden" aria-label="Open studio menu">
              <Layers className="size-4" aria-hidden />
            </Button>
          </SheetTrigger>
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">
            {detail ? detail.conversation.title : `New ${mode === "banner" ? "banner" : mode === "avatar" ? "avatar" : "resume"}`}
            {isBannerConv && detail?.conversation.canvasWidth ? (
              <span className="ml-2 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                BANNER {detail.conversation.canvasWidth}×{detail.conversation.canvasHeight}
              </span>
            ) : null}
            {isResumeConv ? (
              <span className="ml-2 rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">RESUME</span>
            ) : null}
          </h1>
          {selectedVersion ? (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="size-8" aria-label="Undo — select parent version" onClick={() => navigateTree("undo")}>
                <Undo2 className="size-4" aria-hidden />
              </Button>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Redo — select latest child version" onClick={() => navigateTree("redo")}>
                <Redo2 className="size-4" aria-hidden />
              </Button>
              {parentOfSelected ? (
                <Button variant="ghost" size="icon" className="size-8" aria-label="Compare with previous version" onClick={() => setCompare({ before: parentOfSelected, after: selectedVersion })}>
                  <ArrowLeftRight className="size-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Center content */}
        {isResumeConv || (!detail && mode === "resume") ? (
          /* Resume studio — document panel (form + preview + export). A fresh
             resume renders the facts form; generating creates the thread. */
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="laxii-resume-conversation">
            <LaxiiResumePanel
              conversationId={detail?.conversation.id ?? null}
              caps={caps}
              onOpenConversation={(id) => {
                setDetail(null);
                openConversation(id);
              }}
              onLibraryChanged={() => {
                reloadConversations();
                loadResumes();
              }}
            />
          </div>
        ) : (
          <>
            {/* Thread scroll region — messages, the banner studio panel and the
                selected-image bar share ONE scroll area so long prompts, images,
                variant rows, comparisons and the safe-area canvas are always
                reachable, while the composer stays pinned at the bottom.
                laxii-scroll gives the region the studio's thin gold scrollbar. */}
            <div
              ref={messagesScrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
              }}
              className="laxii-scroll relative min-h-0 flex-1 overflow-y-auto"
              data-testid="laxii-messages"
            >
              <div className="px-4 py-5">
                {loadingDetail ? (
                  <div className="grid place-items-center py-16">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading conversation" />
                  </div>
                ) : !detail ? (
                  briefTask && briefTask.task.status !== "CANCELLED" ? (
                    <div className="mx-auto flex max-w-3xl flex-col gap-5 py-4">
                      <BriefReviewCard
                        briefTask={briefTask}
                        busy={busy}
                        onGenerate={() => void runBriefGeneration()}
                        onUpdated={setBriefTask}
                        onDismiss={() => setBriefTask(null)}
                      />
                    </div>
                  ) : (
                    <WorkspaceIntro
                      mode={mode}
                      onPrompt={(p) => {
                        setPrompt(p);
                        document.querySelector<HTMLTextAreaElement>('[data-testid="laxii-prompt"]')?.focus();
                      }}
                    />
                  )
                ) : (
                  <div className="mx-auto flex max-w-3xl flex-col gap-5">
                    {briefTask && briefTask.task.status !== "CANCELLED" ? (
                      <BriefReviewCard
                        briefTask={briefTask}
                        busy={busy}
                        onGenerate={() => void runBriefGeneration()}
                        onUpdated={setBriefTask}
                        onDismiss={() => setBriefTask(null)}
                      />
                    ) : null}
                    {detail.messages.map((m) => (
                      <MessageBlock
                        key={m.id}
                        message={m}
                        banner={isBannerConv}
                        capability={providerCapability}
                        onSelect={selectVersion}
                        onFavourite={toggleFavourite}
                        onAction={handleImageAction}
                        onOpenLightbox={openVersionLightbox}
                        onRetry={() => void retryFromMessage(m.id)}
                        onStopWait={busy ? () => abortRef.current?.abort() : undefined}
                        briefTask={m.meta?.briefTaskId ? briefTask : null}
                        onBriefDecision={decideBriefResult}
                        decisionBusy={decisionBusy}
                      />
                    ))}
                    {busy && runningCount === 0 ? (
                      <div className="flex items-center gap-3 rounded-2xl border border-primary/25 bg-primary/[0.06] p-4" data-testid="laxii-busy">
                        <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
                        <div className="flex-1">
                          <p className="text-sm font-medium">{busyLabel}</p>
                          <p className="text-xs text-muted-foreground">Real generation in progress — this takes a moment.</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
                          Cancel
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
                <div ref={threadEndRef} aria-hidden className="h-px" />
              </div>

              {/* Banner studio: canvas preview with safe-area guides + export.
                  Lives inside the scroll region — it's large preview content —
                  while the compact selected-image bar and composer stay pinned. */}
              {isBannerConv && selectedVersion && detail?.conversation.canvasWidth && detail.conversation.canvasHeight && !busy ? (
                <div className="border-t border-white/10 bg-white/[0.02] px-4 py-3" data-testid="laxii-banner-studio">
                  <div className="mx-auto max-w-3xl">
                    <LaxiiBannerPanel
                      version={selectedVersion}
                      preset={detail.conversation.bannerKind ? caps?.bannerPresets.find((p) => p.slug === detail.conversation.bannerKind) ?? null : null}
                      canvasWidth={detail.conversation.canvasWidth}
                      canvasHeight={detail.conversation.canvasHeight}
                      presets={caps?.bannerPresets ?? []}
                      onOpenPreview={() => openVersionLightbox(selectedVersion)}
                      approvalRequired={Boolean(selectedMessageMeta?.briefTaskId)}
                      approved={Boolean(briefTask?.generation.approved)}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* Selected preview + actions — pinned above the composer so the
                edit tools stay reachable while the thread scrolls. shrink-0
                guarantees the scroll region above absorbs all leftover space,
                so this bar is never squeezed into the composer. */}
            {selectedVersion && !busy ? (
              <div className="relative z-10 shrink-0 border-t border-white/10 bg-white/[0.02] px-4 py-3" data-testid="laxii-selected-bar">
                <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2">
                  <img
                    src={selectedVersion.url}
                    alt="Selected image"
                    className={cn(
                      "shrink-0 cursor-pointer rounded-lg border border-white/15 object-cover",
                      isBannerConv ? "h-14 w-auto" : "h-14 w-14"
                    )}
                    style={isBannerConv ? { aspectRatio: `${selectedVersion.width} / ${selectedVersion.height}` } : undefined}
                    onClick={() => openVersionLightbox(selectedVersion)}
                  />
                  <div className="min-w-0 flex-1 basis-36">
                    <p className="truncate text-xs font-medium">{selectedVersion.prompt || "Selected image"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {selectedVersion.width}×{selectedVersion.height}
                      {editParent ? " · next operation builds on this" : ""}
                    </p>
                  </div>
                  <div className="ml-auto">
                    <ImageActions
                      selected={selectedVersion}
                      capability={providerCapability}
                      onAction={handleImageAction}
                      onExport={exportSelected}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {/* Composer */}
            {cm !== "resume" ? (
              <div className="relative z-10 shrink-0 border-t border-white/10 px-4 py-3" data-testid="laxii-composer">
                <div className="mx-auto max-w-3xl space-y-2">
                  {cm === "banner" ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Select value={bannerPreset} onValueChange={setBannerPreset}>
                        <SelectTrigger className="h-8 w-64 border-white/10 bg-white/[0.04] text-xs" aria-label="Banner size" data-testid="laxii-banner-size">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(caps?.bannerPresets ?? [{ slug: BEAN_BANNER_SLUG, label: "BEAN Folio banner", width: 2048, height: 687 }]).map((p) => (
                            <SelectItem key={p.slug} value={p.slug}>
                              {p.label} · {p.width} × {p.height}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">{activePreset?.description}</span>
                    </div>
                  ) : null}

                  {cm === "avatar" ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="laxii-avatar-controls">
                      <Select value={avatarPreset} onValueChange={handleAvatarPresetChange}>
                        <SelectTrigger className="h-8 w-52 border-white/10 bg-white/[0.04] text-xs" aria-label="Avatar style">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(caps?.avatarPresets ?? []).map((p) => (
                            <SelectItem key={p.slug} value={p.slug}>
                              {p.label} — {p.blurb}
                            </SelectItem>
                          ))}
                          <SelectItem value="custom">Custom style — write your own prompt</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-muted-foreground">
                        {avatarPreset === "custom"
                          ? "Describe the avatar you want."
                          : `${caps?.avatarPresets.find((p) => p.slug === avatarPreset)?.blurb ?? ""}`}
                      </span>
                    </div>
                  ) : null}

                  {editParent && cm === "image" ? (
                    <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-1.5 text-xs">
                      <Pencil className="size-3.5 text-primary" aria-hidden />
                      <span className="flex-1 truncate">
                        Editing the selected image — describe the change.
                      </span>
                      <button type="button" aria-label="Clear edit context" onClick={() => setEditParent(null)}>
                        <X className="size-3.5 text-muted-foreground hover:text-foreground" aria-hidden />
                      </button>
                    </div>
                  ) : null}

                  <div className="flex items-end gap-2">
                    <label className="relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] transition-colors hover:bg-white/[0.08]" aria-label="Upload reference images">
                      {uploadingRef ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                      ) : (
                        <ImagePlus className="size-4" aria-hidden />
                      )}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple
                        className="sr-only"
                        onChange={(e) => {
                          if (e.target.files) void uploadReferences(e.target.files);
                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                    <Textarea
                      ref={promptTextareaRef}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          sendComposer();
                        }
                      }}
                      maxLength={PROMPT_MAX}
                      placeholder={
                        cm === "banner"
                          ? "Describe your banner — style, subject, mood, colors…"
                          : cm === "avatar"
                            ? avatarPreset === "custom"
                              ? "Describe the avatar you want…"
                              : "Optional details — e.g. glasses, navy suit, warm smile…"
                            : editParent
                              ? "Describe the edit — e.g. replace the background with a warm sunset studio…"
                              : "Describe a creation — or a change to make — and LAXII understands…"
                      }
                      rows={2}
                      className="laxii-scroll max-h-40 min-h-[44px] resize-none overflow-y-auto border-white/10 bg-white/[0.04] text-sm"
                      aria-label="Prompt"
                      data-testid="laxii-prompt"
                    />
                    <Button
                      onClick={() => sendComposer()}
                      disabled={busy || Boolean(caps?.engine && !caps.engine.available)}
                      aria-label={cm === "banner" ? "Generate banner" : cm === "avatar" ? "Generate avatar" : editParent ? "Apply edit" : "Create"}
                      title={caps?.engine && !caps.engine.available ? caps.engine.note : undefined}
                      className="h-10 shrink-0 gap-1.5 bg-primary px-4 text-primary-foreground hover:bg-primary/90"
                      data-testid="laxii-generate"
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                      <span className="hidden sm:inline">
                        {cm === "banner" ? "Generate banner" : cm === "avatar" ? "Generate avatar" : editParent ? "Apply edit" : "Create"}
                      </span>
                    </Button>
                  </div>

                  {/* Subtle prompt budget counter — muted normally, amber when
                      the remaining budget is small, destructive at the limit. */}
                  {prompt.length > 0 ? (
                    <div className="flex items-center justify-end px-3 pb-1 sm:px-5">
                      <span
                        data-testid="laxii-prompt-counter"
                        aria-live="polite"
                        className={`text-[10px] tabular-nums ${
                          prompt.length >= PROMPT_MAX
                            ? "font-medium text-destructive"
                            : PROMPT_MAX - prompt.length <= 1000
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground/70"
                        }`}
                      >
                        {prompt.length.toLocaleString()} / {PROMPT_MAX.toLocaleString()}
                        {PROMPT_MAX - prompt.length <= 1000
                          ? ` — ${(PROMPT_MAX - prompt.length).toLocaleString()} character${PROMPT_MAX - prompt.length === 1 ? "" : "s"} remaining`
                          : ""}
                      </span>
                    </div>
                  ) : null}

                  {refs.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {refs.map((r, refIndex) => (
                        <span key={r.mediaId} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] py-1 pl-1 pr-2 text-xs">
                          <button
                            type="button"
                            className="shrink-0 cursor-zoom-in"
                            aria-label={`Preview reference ${r.name}`}
                            onClick={() => setLightboxSource({ kind: "refs", index: refIndex })}
                          >
                            <img src={r.url} alt={`Reference ${r.name}`} className="size-6 rounded object-cover" />
                          </button>
                          <span className="max-w-24 truncate text-muted-foreground">{r.name}</span>
                          <button type="button" aria-label={`Remove reference ${r.name}`} onClick={() => setRefs((list) => list.filter((x) => x.mediaId !== r.mediaId))}>
                            <X className="size-3 hover:text-destructive" aria-hidden />
                          </button>
                        </span>
                      ))}
                      <span className="text-[11px] text-muted-foreground">
                        {cm === "avatar" ? "reference photos guide the likeness (best-effort)" : ""}
                        {providerCapability?.maxRefs ? ` · up to ${providerCapability.maxRefs} refs` : ""}
                      </span>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {cm !== "banner" ? (
                      <Select
                        value={aspect}
                        onValueChange={(v) => {
                          setAspect(v);
                          setAspectTouched(true);
                        }}
                      >
                        <SelectTrigger className="h-8 w-[7.5rem] border-white/10 bg-white/[0.04] text-xs" aria-label="Aspect ratio">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {availableAspects.map((a) => (
                            <SelectItem key={a} value={a}>
                              {a}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    {cm !== "banner" ? (
                      <Select
                        value={String(count)}
                        onValueChange={(v) => {
                          setCount(Number(v));
                          setCountTouched(true);
                        }}
                      >
                        <SelectTrigger className="h-8 w-[7rem] border-white/10 bg-white/[0.04] text-xs" aria-label="Number of variants">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n} variant{n > 1 ? "s" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    {/* LAXII V1 — the single user-facing image engine. No
                        engine picker: the backend refuses any other engine
                        instead of silently rerouting, and the badge reports
                        honestly when the engine is unavailable. */}
                    <span
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 text-xs"
                        title={laxiiV1?.note ?? "LAXII V1 — the BEAN-managed image engine."}
                        data-testid="laxii-engine-selector"
                        aria-label={`Image engine: ${laxiiV1?.label ?? "LAXII V1"}${laxiiV1 && !laxiiV1.available ? " (unavailable)" : ""}`}
                    >
                      <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
                      <span className="whitespace-nowrap font-medium">{laxiiV1?.label ?? "LAXII V1"}</span>
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          laxiiV1 ? (laxiiV1.available ? "bg-emerald-400" : "bg-destructive") : "bg-muted-foreground/50"
                        )}
                        aria-hidden
                      />
                    </span>
                    {/* Style Registry (Phase 5): professional results without
                        prompt writing — compiled directives stay server-side. */}
                    {cm === "image" ? (
                      <Select value={styleSlug || "none"} onValueChange={(v) => setStyleSlug(v === "none" ? "" : v)}>
                        <SelectTrigger
                          className="h-8 w-[10.5rem] border-white/10 bg-white/[0.04] text-xs"
                          aria-label="Style preset"
                          data-testid="laxii-style-selector"
                        >
                          <SelectValue placeholder="Style" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No style — your own words</SelectItem>
                          {(caps?.styles ?? []).map((s) => (
                            <SelectItem key={s.slug} value={s.slug}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}
                    <Select value={quality || "auto"} onValueChange={(v) => setQuality(v === "auto" ? "" : v)}>
                      <SelectTrigger className="h-8 w-[8rem] border-white/10 bg-white/[0.04] text-xs" aria-label="Quality">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Quality: auto</SelectItem>
                        <SelectItem value="1K">Standard · 1K</SelectItem>
                        <SelectItem value="2K">High · 2K</SelectItem>
                        <SelectItem value="4K">Max · 4K</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </main>

      {/* Compare dialog */}
      <Dialog open={Boolean(compare)} onOpenChange={(v) => !v && setCompare(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display">Compare versions</DialogTitle>
            <DialogDescription>Previous version on the left, selected version on the right.</DialogDescription>
          </DialogHeader>
          {compare ? (
            <div className="grid grid-cols-2 gap-3">
              {[compare.before, compare.after].map((v, i) => (
                <figure key={v.id} className="space-y-1.5">
                  <button
                    type="button"
                    className="block w-full cursor-zoom-in"
                    aria-label={`Open the ${i === 0 ? "previous" : "selected"} version in the image preview`}
                    onClick={() => openVersionLightbox(v)}
                  >
                    <img src={v.url} alt={i === 0 ? "Previous version" : "Selected version"} className="w-full rounded-xl border border-white/10" />
                  </button>
                  <figcaption className="text-center text-xs text-muted-foreground">
                    {i === 0 ? "Before" : "After"} · {v.width}×{v.height}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Image preview lightbox — click-to-open from every LAXII image
          surface: message variants, the selected bar, references, the
          sidebar gallery and the banner canvas. */}
      <LaxiiImageLightbox
        items={lightboxItems}
        index={lightboxSource?.index ?? null}
        onIndexChange={(i) =>
          setLightboxSource((s) => (s ? ({ ...s, index: i } as typeof s) : s))
        }
        onClose={() => setLightboxSource(null)}
      />
      </div>

      {/* Mobile sidebar sheet — content lives in a portal; the trigger sits in
          the thread header above. */}
      <SheetContent side="left" className="w-80 border-white/10 bg-sidebar p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>LAXII menu</SheetTitle>
        </SheetHeader>
        {sidebarNode}
      </SheetContent>
    </Sheet>
  );

  function handleImageAction(action: "edit" | "variations" | "upscale" | "removeBackground" | "expand" | "continue") {
    if (!selectedVersion) return;
    setEditParent(selectedVersion);
    if (action === "continue") {
      document.querySelector<HTMLTextAreaElement>('[data-testid="laxii-prompt"]')?.focus();
      return;
    }
    if (action === "edit") {
      document.querySelector<HTMLTextAreaElement>('[data-testid="laxii-prompt"]')?.focus();
      return;
    }
    if (action === "variations") void runGeneration("VARIATIONS");
    else if (action === "upscale") void runGeneration("UPSCALE");
    else if (action === "removeBackground") void runGeneration("REMOVE_BACKGROUND");
    else if (action === "expand") void runGeneration("EXPAND");
  }
}

// ------------------------------------------------------------ workspace intro

/**
 * Per-mode introduction for a NEW creation. The sidebar "Create:" dropdown is
 * the single mode selector — this intro deliberately shows NO mode cards and
 * no mode-switching controls (the previously duplicated Banner/Avatar/Resume
 * cards were removed), only guidance for the already-selected workspace.
 */
const MODE_INTRO: Record<CreationMode, { title: string; blurb: string; features: string[]; icon: React.ReactNode }> = {
  banner: {
    title: "Banner studio",
    blurb:
      "Design the BEAN Folio portfolio banner at exactly 2048 × 687 px with a built-in text-safe guide. Describe the banner below — LAXII renders it to size.",
    features: [],
    icon: <RectangleHorizontal className="size-6 text-primary" aria-hidden />,
  },
  avatar: {
    title: "Avatar studio",
    blurb:
      "Professional photographs, headshots and stylized avatars from no-prompt style presets. Add reference photos for a best-effort likeness, then keep editing in chat.",
    features: ["10 no-prompt style presets", "Reference photo likeness (best-effort)", "Variations + compare", "Background removal + export"],
    icon: <UserRound className="size-6 text-primary" aria-hidden />,
  },
  resume: {
    title: "Resume studio",
    blurb: "Professional, ATS-friendly resumes built from your real facts — guided form, editable sections, PDF + DOCX export.",
    features: [],
    icon: <FileText className="size-6 text-primary" aria-hidden />,
  },
};

const MODE_SUGGESTIONS: Record<CreationMode, string[]> = {
  banner: [
    "BEAN Folio banner with circuit motifs and champagne-gold accents",
    "Minimal portfolio hero, champagne-gold typography space",
  ],
  avatar: [
    "Navy suit, warm confident smile, office blur behind me",
    "Make it feel like a magazine cover shoot",
  ],
  resume: [],
};

function WorkspaceIntro({
  mode,
  onPrompt,
}: {
  mode: CreationMode;
  onPrompt: (p: string) => void;
}) {
  // Resume mode renders the dedicated resume panel instead of this intro.
  const intro = MODE_INTRO[mode === "resume" ? "banner" : mode];
  const suggestions = MODE_SUGGESTIONS[mode === "resume" ? "banner" : mode];

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-10 text-center" data-testid="laxii-empty">
      <div className="grid size-14 place-items-center rounded-2xl border border-primary/30 bg-primary/10">{intro.icon}</div>
      <div className="space-y-2">
        <h2 className="font-display text-xl font-semibold">{intro.title}</h2>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">{intro.blurb}</p>
      </div>

      {/* Banner creation note — fills the space of the removed feature strip.
          Purely informational: it complements the sidebar's New banner button
          (which starts a conversation) instead of duplicating it. */}
      {mode === "banner" ? (
        <section
          className="w-full max-w-md rounded-2xl border border-primary/25 bg-primary/[0.06] p-4 text-left"
          data-testid="laxii-banner-create-note"
          aria-label="Create banner using LAXII"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10" aria-hidden="true">
              <Sparkles className="size-4 text-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">Create banner using LAXII</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Create professional portfolio banners with LAXII.</p>
            </div>
            <span className="shrink-0 rounded-md bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary">2048 × 687</span>
          </div>
        </section>
      ) : null}

      {intro.features.length > 0 ? (
        <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5">
          {intro.features.map((f) => (
            <li key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-1 shrink-0 rounded-full bg-primary/70" aria-hidden /> {f}
            </li>
          ))}
        </ul>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {suggestions.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPrompt(p)}
              className="rounded-full border border-white/12 bg-white/[0.04] px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquarePlus className="size-3.5" aria-hidden /> Every result is a real generation — failures are surfaced honestly, never hidden.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ blocks

function MessageBlock({
  message,
  banner,
  capability,
  onSelect,
  onFavourite,
  onAction,
  onOpenLightbox,
  onRetry,
  onStopWait,
  briefTask,
  onBriefDecision,
  decisionBusy,
}: {
  message: LaxiiMessage;
  /** Banner conversation — versions render at their true ultra-wide ratio
      instead of the square library thumbnail (no misleading cropping). */
  banner?: boolean;
  /** Capability data for the active engine — per-result actions only render
      what the engine can honestly deliver (parity with the pinned bar). */
  capability?: {
    upscale: boolean;
    removeBackground: boolean;
    expand: boolean;
    variations: boolean;
  } | null;
  onSelect: (v: LaxiiVersion) => void;
  onFavourite: (v: LaxiiVersion) => void;
  onAction: (action: "edit" | "variations" | "upscale" | "removeBackground" | "expand" | "continue") => void;
  onOpenLightbox: (v: LaxiiVersion) => void;
  /** One-click honest retry for failed jobs. */
  onRetry?: () => void;
  /** Present while the studio is attached to a running job — lets the user
      detach from polling (the server job keeps running honestly). */
  onStopWait?: () => void;
  /** Phase 3: brief task when this message belongs to a Riishe brief pipeline. */
  briefTask?: LaxiiBriefResponse | null;
  onBriefDecision?: (decision: "approved" | "rejected", messageId: string) => void;
  decisionBusy?: boolean;
}) {
  if (message.role === "USER") {
    return (
      <div className="flex justify-end" data-testid="laxii-user-message">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/25 bg-primary/10 px-4 py-2.5 text-sm">
          {message.text}
        </p>
      </div>
    );
  }

  if (message.status === "RUNNING") {
    const pipeline = Boolean(message.meta?.briefTaskId);
    return (
      <div
        className="flex items-start gap-3 rounded-2xl border border-primary/25 bg-primary/[0.06] p-4"
        data-testid="laxii-running-message"
      >
        <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{pipeline ? "Banner pipeline running…" : "Generating…"}</p>
          {pipeline ? (
            <BriefPipelineProgress meta={message.meta} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Real generation in progress — this can take a minute or two. The result appears here automatically.
            </p>
          )}
        </div>
        {onStopWait ? (
          <Button variant="outline" size="sm" onClick={onStopWait}>
            Stop waiting
          </Button>
        ) : null}
      </div>
    );
  }

  if (message.status === "FAILED" && message.versions.length === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/40 bg-destructive/10 p-4" data-testid="laxii-failed-message">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">Generation failed</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{message.error}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Nothing was saved or shown as a result — try again or adjust the prompt.
          </p>
        </div>
        {onRetry ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={onRetry}
            data-testid="laxii-retry"
          >
            <RefreshCw className="size-3.5" aria-hidden /> Try again
          </Button>
        ) : null}
      </div>
    );
  }

  const meta = message.meta;
  const op = message.operation ?? "GENERATE";
  const opLabel = op.charAt(0) + op.slice(1).toLowerCase().replace(/_/g, " ");

  return (
    <div className="space-y-2" data-testid="laxii-assistant-message">
      {message.status === "FAILED" ? (
        <div
          className="flex items-start gap-2.5 rounded-2xl border border-destructive/40 bg-destructive/10 p-3"
          data-testid="laxii-failed-message"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div>
            <p className="text-sm font-medium text-destructive">Generation reported a failure</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{message.error}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The outputs below were generated and saved before the failure was recorded.
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-medium text-foreground">{opLabel}</span>
        {/* Unified engine identity — LAXII V1; internal provider/model details stay server-side. */}
        <span>LAXII V1</span>
        {meta?.aspect ? <span>· {meta.aspect}</span> : null}
        {meta?.durationMs ? <span>· {(meta.durationMs / 1000).toFixed(1)}s</span> : null}
        {meta?.style ? <span>· {meta.style} style</span> : null}
        {meta?.intent ? (
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-primary">
            understood: {meta.intent.kind.toLowerCase().replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      {message.versions.length > 0 ? (
        <div
          className={cn(
            "grid gap-2",
            banner ? "grid-cols-1" : message.versions.length === 1 ? "grid-cols-1 sm:max-w-md" : "grid-cols-2 sm:grid-cols-4"
          )}
        >
          {message.versions.map((v) => (
            <div key={v.id} className={cn("group relative", v.isSelected && "ring-2 ring-primary rounded-xl")}>
              <button
                type="button"
                onClick={() => {
                  // Click selects the version (unchanged behaviour) AND opens
                  // the full-resolution preview — the lightbox shows this
                  // exact image with its sibling variations navigable.
                  onSelect(v);
                  onOpenLightbox(v);
                }}
                className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-white/10"
                aria-label={`Preview and select variant${v.isSelected ? " (selected)" : ""}`}
                aria-pressed={v.isSelected}
              >
                <img
                  src={v.url}
                  alt={v.prompt ?? "Generated image"}
                  className={cn("w-full transition-transform group-hover:scale-[1.02]", banner ? "bg-black/40 object-contain" : "aspect-square object-cover")}
                  style={banner ? { aspectRatio: `${v.width} / ${v.height}` } : undefined}
                  loading="lazy"
                />
              </button>
              <button
                type="button"
                aria-label={v.isFavourite ? "Remove from favourites" : "Add to favourites"}
                onClick={() => onFavourite(v)}
                className={cn(
                  "absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1.5 backdrop-blur transition-opacity",
                  v.isFavourite ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                <Heart className={cn("size-3.5", v.isFavourite ? "fill-primary text-primary" : "text-white")} aria-hidden />
              </button>
              <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                {v.width}×{v.height}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {meta?.warnings && meta.warnings.length > 0 ? (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground">
          {meta.warnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      ) : null}
      {meta?.estimatedCostUsd !== undefined ? (
        <p className="text-[11px] text-muted-foreground">
          Est. generation cost: ${meta.estimatedCostUsd.toFixed(4)} (documented estimate, not a bill)
        </p>
      ) : null}
      {message.meta?.briefTaskId ? (
        <QualityFindingsPanel
          message={message}
          briefTask={briefTask ?? null}
          onDecision={(d) => onBriefDecision?.(d, message.id)}
          decisionBusy={Boolean(decisionBusy)}
        />
      ) : null}
      <VariantActions message={message} capability={capability} onAction={onAction} />
    </div>
  );
}

function VariantActions({
  message,
  capability,
  onAction,
}: {
  message: LaxiiMessage;
  capability?: {
    upscale: boolean;
    removeBackground: boolean;
    expand: boolean;
    variations: boolean;
  } | null;
  onAction: (action: "edit" | "variations" | "upscale" | "removeBackground" | "expand" | "continue") => void;
}) {
  const selected = message.versions.find((v) => v.isSelected);
  if (!selected) return null;
  const actions: { key: typeof ACTIONS[number]; label: string; icon: React.ReactNode }[] = [
    { key: "variations", label: "Variations", icon: <RefreshCw className="size-3.5" aria-hidden /> },
    { key: "upscale", label: "Upscale", icon: <Sparkles className="size-3.5" aria-hidden /> },
    { key: "removeBackground", label: "Remove background", icon: <Eraser className="size-3.5" aria-hidden /> },
    { key: "expand", label: "Expand canvas", icon: <Crop className="size-3.5" aria-hidden /> },
    { key: "continue", label: "Continue", icon: <Pencil className="size-3.5" aria-hidden /> },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {actions
        .filter((a) => {
          // Offer only what the active engine can honestly deliver — an
          // unsupported action would just create a job that fails server-side.
          if (capability && a.key === "variations" && !capability.variations) return false;
          if (capability && a.key === "upscale" && !capability.upscale) return false;
          if (capability && a.key === "removeBackground" && !capability.removeBackground) return false;
          if (capability && a.key === "expand" && !capability.expand) return false;
          return true;
        })
        .map((a) => (
          <Button
            key={a.key}
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px] hover:bg-white/[0.08]"
            onClick={() => onAction(a.key)}
          >
            {a.icon} {a.label}
          </Button>
        ))}
    </div>
  );
}

const ACTIONS = ["edit", "variations", "upscale", "removeBackground", "expand", "continue"] as const;

function ImageActions({
  selected,
  capability,
  onAction,
  onExport,
}: {
  selected: LaxiiVersion;
  capability: {
    upscale: boolean;
    removeBackground: boolean;
    expand: boolean;
    variations: boolean;
  } | null;
  onAction: (action: "edit" | "variations" | "upscale" | "removeBackground" | "expand" | "continue") => void;
  onExport: (format: "png" | "jpeg" | "webp") => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {/* Labels hide below md so the pinned bar stays one row tall on phones;
          icons keep accessible names via aria-label + title. */}
      <Button variant="outline" size="sm" aria-label="Edit selected image" title="Edit" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" onClick={() => onAction("edit")}>
        <Pencil className="size-3.5" aria-hidden /> <span className="hidden md:inline">Edit</span>
      </Button>
      {capability?.variations ? (
        <Button variant="outline" size="sm" aria-label="Generate variations" title="Variations" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" onClick={() => onAction("variations")}>
          <RefreshCw className="size-3.5" aria-hidden /> <span className="hidden md:inline">Variations</span>
        </Button>
      ) : null}
      {capability?.upscale ? (
        <Button variant="outline" size="sm" aria-label="Upscale image" title="Upscale" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" onClick={() => onAction("upscale")}>
          <Sparkles className="size-3.5" aria-hidden /> <span className="hidden md:inline">Upscale</span>
        </Button>
      ) : null}
      {capability?.removeBackground ? (
        <Button variant="outline" size="sm" aria-label="Remove background" title="Remove background" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" onClick={() => onAction("removeBackground")}>
          <Eraser className="size-3.5" aria-hidden /> <span className="hidden md:inline">Remove BG</span>
        </Button>
      ) : null}
      {capability?.expand ? (
        <Button variant="outline" size="sm" aria-label="Expand canvas" title="Expand canvas" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" onClick={() => onAction("expand")}>
          <Crop className="size-3.5" aria-hidden /> <span className="hidden md:inline">Expand</span>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Export image" title="Export" className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]" data-testid="laxii-export-menu">
            <Download className="size-3.5" aria-hidden /> <span className="hidden md:inline">Export</span> <ChevronDown className="size-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onExport("png")}>PNG — transparency preserved</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport("jpeg")}>JPEG — smallest photos</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onExport("webp")}>WebP — modern, efficient</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" asChild className="h-7 gap-1.5 border-white/10 bg-white/[0.03] text-[11px]">
        <a href={selected.url} download target="_blank" rel="noreferrer" aria-label="Download original image" title="Download">
          <Download className="size-3.5" aria-hidden /> <span className="hidden md:inline">Download</span>
        </a>
      </Button>
      {/* Phase 5: Workflow 2 entry — request an engineering integration of this
          asset into an authorized CODE GIFTZ repository (handoff is approved
          there; the engineering plan has its own second gate). */}
      <IntegrationRequestDialog mediaId={selected.mediaId} width={selected.width} height={selected.height} sourceLabel={selected.prompt ? selected.prompt.slice(0, 100) : "LAXII studio asset"} />
    </div>
  );
}
