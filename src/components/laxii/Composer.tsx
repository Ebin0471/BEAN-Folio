"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { api } from "@/lib/client";

import { MediaUploadButton } from "@/components/bean/MediaUploadButton";
import { Spinner } from "@/components/bean/Spinner";

import {
  ASPECTS,
  CHAT_OPERATIONS,
  mediaUrl,
  type BannerPresetInfo,
  type LaxiiChatMessage,
  type ProviderInfo,
} from "./types";
import type { MediaDTO } from "@/lib/types";
import { BannerSettings } from "./BannerSettings";

/**
 * Bottom composer (§Phase 6): prompt, uploads/references, editing mode,
 * provider + model, aspect ratio, variations, generate. The engine only
 * offers what the selected provider genuinely supports (capability registry).
 */
export function Composer({
  conversationId,
  selectedAssetId,
  providers,
  onSent,
  onError,
  onCreateConversation,
}: {
  conversationId: string | null;
  selectedAssetId: string | null;
  providers: ProviderInfo[];
  onSent: (conversationId: string) => void;
  onError: (msg: string) => void;
  onCreateConversation: () => Promise<string>;
}) {
  const [text, setText] = useState("");
  const [operation, setOperation] = useState<string>("AUTO");
  const [providerId, setProviderId] = useState<string>("auto");
  const [model, setModel] = useState<string>("");
  const [aspect, setAspect] = useState<string>("1:1");
  const [variations, setVariations] = useState(4);
  const [refs, setRefs] = useState<MediaDTO[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [banner, setBanner] = useState<{ presetId: string; width: number; height: number; style: string }>({
    presetId: "youtube-channel",
    width: 2560,
    height: 1440,
    style: "",
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const availableProviders = useMemo(() => providers.filter((p) => p.available), [providers]);
  const activeProvider = useMemo(
    () => availableProviders.find((p) => p.id === providerId) ?? availableProviders.find((p) => p.isDefault) ?? availableProviders[0],
    [availableProviders, providerId]
  );

  // Keep the model in sync with the provider's registry.
  useEffect(() => {
    if (activeProvider) {
      const first = activeProvider.capabilities?.models?.[0]?.id ?? "";
      setModel(first);
    }
  }, [activeProvider?.id]);

  // Banner mode auto-opens the banner settings.
  useEffect(() => {
    if (operation === "BANNER") setBannerOpen(true);
  }, [operation]);

  const caps = activeProvider?.capabilities;
  const maxRefs = caps?.maxReferences ?? 1;

  const send = async () => {
    if (sending) return;
    const trimmed = text.trim();
    if (!trimmed && operation !== "BANNER" && operation !== "VARIATIONS" && operation !== "REMOVE_BG" && operation !== "UPSCALE") {
      onError("Describe what you want to create");
      return;
    }
    setSending(true);
    try {
      const convId = conversationId ?? (await onCreateConversation());
      const res = await api<{ userMessage: LaxiiChatMessage; assistantMessage: LaxiiChatMessage }>(
        `/api/laxii/conversations/${convId}/messages`,
        {
          method: "POST",
          json: {
            text: trimmed,
            operation,
            refAssetIds: refs.map((r) => r.id),
            parentAssetId: selectedAssetId ?? undefined,
            settings: {
              provider: providerId === "auto" ? "auto" : providerId,
              model: model || undefined,
              aspect,
              variations,
              format: "PNG",
              bannerPreset: banner.presetId,
              bannerWidth: banner.width,
              bannerHeight: banner.height,
              bannerStyle: banner.style || undefined,
            },
          },
        }
      );
      setText("");
      setRefs([]);
      onSent(convId);
      void res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not send — check your connection";
      onError(msg.includes("already have jobs running") ? "You already have 2 jobs running — wait for them to finish" : msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-h-[68dvh] shrink-0 overflow-y-auto border-t border-border/60 bg-background/80 backdrop-blur laxii-scroll">
      {/* context strip */}
      <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 pt-2 sm:px-5">
        {selectedAssetId ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-gold-soft/20 py-1 pl-1 pr-2 text-[11px] text-primary">
            <img src={mediaUrl(selectedAssetId)} alt="" className="size-5 rounded-full object-cover" />
            Editing selected image
            <button type="button" onClick={() => setOperation("EDIT")} className="rounded-full px-1 hover:bg-accent" aria-label="Switch to Edit mode">
              <WandMini />
            </button>
          </span>
        ) : null}
        {refs.length > 0 ? (
          <span className="flex items-center gap-1">
            {refs.map((r) => (
              <span key={r.id} className="relative">
                <img src={mediaUrl(r.id)} alt="Reference image" className="size-6 rounded-md border border-border/60 object-cover" />
                <button
                  type="button"
                  onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
                  className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-background border border-border/60"
                  aria-label="Remove reference image"
                >
                  <X className="size-2.5" aria-hidden />
                </button>
              </span>
            ))}
            {maxRefs <= refs.length ? <span className="text-[10px] text-muted-foreground">max refs</span> : null}
          </span>
        ) : null}
      </div>

      {/* main row */}
      <div className="mx-auto flex max-w-3xl items-end gap-2 p-3 sm:px-5">
        {/* attach */}
        <div className={maxRefs > 0 ? "" : "pointer-events-none opacity-40"} title={maxRefs > 0 ? "Upload reference images" : "The selected provider does not support references"} aria-label="Upload reference image">
          <MediaUploadButton
            kind="IMAGE"
            label=""
            size="icon"
            className="size-10 shrink-0 rounded-xl border border-border/60 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            onUploaded={(media) => {
              setRefs((rs) => (rs.length >= Math.max(1, maxRefs) ? rs : [...rs, media]));
            }}
          />
        </div>

        {/* prompt */}
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={
              operation === "BANNER"
                ? "Describe the banner design — e.g. luxury tech channel art, charcoal and gold…"
                : selectedAssetId
                  ? "Describe the edit — e.g. make the lighting warmer, change the background to a luxury office…"
                  : "Describe what to create — Enter to generate, Shift+Enter for a new line"
            }
            aria-label="Prompt"
            className="max-h-40 min-h-[44px] w-full resize-none rounded-xl border border-border/60 bg-card/70 px-3.5 py-2.5 pr-10 text-sm leading-relaxed placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending}
            className="absolute bottom-2.5 right-2.5 grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            aria-label={sending ? "Generating" : "Generate"}
          >
            {sending ? <Spinner className="size-3.5" /> : <Send className="size-3.5" aria-hidden />}
          </button>
        </div>

        {/* options toggle */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className={`grid size-10 shrink-0 place-items-center rounded-xl border transition-colors ${
            advancedOpen ? "border-primary/40 bg-gold-soft/20 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
          }`}
          aria-expanded={advancedOpen}
          aria-label="Generation options"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </button>
      </div>

      {/* quick mode chips */}
      <div className="mx-auto flex max-w-3xl gap-1.5 overflow-x-auto px-3 pb-2 laxii-scroll sm:px-5" role="tablist" aria-label="Editing mode">
        {CHAT_OPERATIONS.map((op) => (
          <button
            key={op.id}
            type="button"
            role="tab"
            aria-selected={operation === op.id}
            title={op.hint}
            onClick={() => setOperation(op.id)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${
              operation === op.id ? "border-primary/50 bg-gold-soft/25 font-medium text-primary" : "border-border/60 text-muted-foreground hover:border-primary/30 hover:text-foreground"
            }`}
          >
            {op.label}
          </button>
        ))}
      </div>

      {/* advanced options */}
      {advancedOpen ? (
        <div className="border-t border-border/60 bg-card/40">
          <div className="mx-auto grid max-w-3xl gap-3 p-3 sm:grid-cols-2 sm:px-5">
            {/* provider */}
            <label className="grid gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Provider</span>
              <div className="relative">
                <select
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  className="w-full appearance-none rounded-lg border border-border/60 bg-background px-3 py-2 pr-8 text-sm focus:border-primary/50 focus:outline-none"
                >
                  <option value="auto">Auto (recommended)</option>
                  {availableProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.kind === "external-paid" ? " (paid API)" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
              </div>
              {caps ? <span className="text-[10px] leading-relaxed text-muted-foreground">{caps.costBasis}</span> : null}
            </label>

            {/* model */}
            <label className="grid gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Model</span>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!caps?.models?.length}
                  className="w-full appearance-none rounded-lg border border-border/60 bg-background px-3 py-2 pr-8 text-sm focus:border-primary/50 focus:outline-none disabled:opacity-50"
                >
                  {caps?.models?.length ? (
                    caps.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))
                  ) : (
                    <option value="">Provider default</option>
                  )}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
              </div>
              {caps && caps.costEstimateUSDPerImage && model && caps.costEstimateUSDPerImage[model] ? (
                <span className="text-[10px] text-muted-foreground">≈ ${caps.costEstimateUSDPerImage[model].toFixed(3)} / image (estimate)</span>
              ) : null}
            </label>

            {/* aspect */}
            <label className="grid gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Aspect ratio</span>
              <div className="flex flex-wrap gap-1">
                {ASPECTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAspect(a)}
                    className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                      aspect === a ? "border-primary/50 bg-gold-soft/25 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </label>

            {/* variations */}
            <label className="grid gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Variations</span>
              <div className="flex gap-1">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setVariations(n)}
                    className={`size-8 rounded-md border text-xs transition-colors ${
                      variations === n ? "border-primary/50 bg-gold-soft/25 font-medium text-primary" : "border-border/60 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </label>
          </div>
        </div>
      ) : null}

      {/* banner settings panel */}
      {operation === "BANNER" && bannerOpen ? (
        <BannerSettings
          value={banner}
          onChange={setBanner}
          onClose={() => setBannerOpen(false)}
          onError={onError}
          selectedAssetId={selectedAssetId}
        />
      ) : null}

      <div className="pb-[env(safe-area-inset-bottom)]" />
    </div>
  );
}

function WandMini() {
  return (
    <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 4V2m0 20v-2m5-15 1.5-1.5M4.5 19.5 6 18m13 0 1.5 1.5M4.5 4.5 6 6m13 6a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" strokeLinecap="round" />
    </svg>
  );
}

