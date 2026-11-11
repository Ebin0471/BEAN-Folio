"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, ScanSearch, Send, Sparkles, Square, Telescope } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/client";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { designPresets } from "@/lib/site-config";
import type { SiteConfig } from "@/lib/site-config";
import type { AiDesignProposal } from "@/lib/types";

export interface RiisheProposal extends AiDesignProposal {
  request: string;
}

export interface RiisheContext {
  device: string;
  pageName: string | null;
  sectionType: string | null;
  sectionTitle: string | null;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  kind?: "proposal" | "audit" | "text";
}

/**
 * RIISHE Design — the design-intelligence agent INSIDE Website Studio.
 *
 * This is the same RIISHE that answers at #/intelligence, surfaced in its
 * builder context: it sees the current page, selection, template and design
 * tokens, and talks to the SAME server-side gateway (/api/ai/design,
 * GLM provider behind `aiComplete`). Two modes:
 *  - Edit  → a schema-validated, previewable config PROPOSAL (never saved
 *            or published from here; the builder owns accept/discard/undo)
 *  - Audit → findings and recommendations only, no config change.
 * Unsupported actions are reported honestly; nothing is fabricated.
 */

const EDIT_EXAMPLES = [
  "Make my portfolio feel like a premium editorial design studio.",
  "Improve the hero without changing my project grid.",
  "Make the layout more cinematic but keep it fast on mobile.",
  "Use a consistent typography scale throughout the site.",
  "Create a better case-study layout for my visual projects.",
  "Reduce the empty space and align all sections.",
  "Keep the design, but improve mobile responsiveness.",
];

const AUDIT_EXAMPLES = [
  "Audit my visual hierarchy and spacing.",
  "Check my typography for consistency problems.",
  "Is my section order right for my profession?",
  "Am I over-animating my portfolio?",
];

function suggestionsFor(config: SiteConfig): string[] {
  const out: string[] = [];
  const types = new Set(config.pages.flatMap((p) => p.sections.map((s) => s.type)));
  if (!types.has("testimonials")) out.push("Add a testimonials section (I'll leave it empty until you add real quotes).");
  if (!types.has("services")) out.push("Add a services section to explain what I offer.");
  if (!types.has("experience")) out.push("Add an experience timeline I can fill in.");
  if (config.motion.preset === "none" || !config.motion.enabled) out.push("Add subtle scroll reveals without hurting performance.");
  if (config.theme.typeScale === "intimate") out.push("Make the headings more commanding.");
  if (config.theme.density === "relaxed") out.push("Tighten the spacing for a denser, faster feel.");
  if (out.length < 3) out.push("Recommend a visual direction for my profession.");
  return out.slice(0, 4);
}

export function RiisheDesignPanel({
  currentConfig,
  lastProposal,
  context,
  onProposal,
  onOpenSection,
}: {
  currentConfig: SiteConfig;
  lastProposal: SiteConfig | null;
  context: RiisheContext;
  onProposal: (proposal: RiisheProposal | null) => void;
  onOpenSection?: () => void;
}) {
  const { user, refresh } = useSession();
  const [request, setRequest] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState<false | "edit" | "audit">(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRequest, setLastRequest] = useState<{ text: string; mode: "edit" | "audit" } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const consented = Boolean(user?.aiConsent);

  const suggestions = useMemo(() => suggestionsFor(currentConfig), [currentConfig]);

  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  async function enableConsent(next: boolean) {
    try {
      await api("/api/me/privacy", { method: "PATCH", json: { aiConsent: next } });
      await refresh();
      if (next) toast.success("RIISHE design assistance enabled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update AI consent");
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }

  async function submit(text: string, mode: "edit" | "audit") {
    const trimmed = text.trim();
    if (trimmed.length < 3) {
      setError("Describe what you want (at least a few words).");
      return;
    }
    setBusy(mode);
    setError(null);
    setLastRequest({ text: trimmed, mode });
    setRequest("");
    setTurns((t) => [...t, { role: "user", text: trimmed, kind: mode === "audit" ? "audit" : "text" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.text.slice(0, 1000) }));
      const res = await api<{ config?: SiteConfig; changes?: string[]; reply: string; findings?: string[] }>(
        "/api/ai/design",
        {
          method: "POST",
          json: {
            request: trimmed,
            mode,
            currentConfig,
            ...(lastProposal ? { previousProposal: lastProposal } : {}),
            context,
            history,
          },
          signal: controller.signal,
        }
      );
      if (mode === "audit") {
        const findings = (res.findings ?? []).filter(Boolean);
        setTurns((t) => [
          ...t,
          { role: "assistant", text: [res.reply, ...(findings.length ? ["", ...findings.map((f) => `• ${f}`)] : [])].join("\n"), kind: "audit" },
        ]);
        toast.success("Audit complete");
      } else {
        if (!res.config) {
          // Ambiguous request — the model returned a clarifying question.
          setTurns((t) => [...t, { role: "assistant", text: res.reply || "Could you clarify the change?", kind: "text" }]);
        } else {
          onProposal({ request: trimmed, config: res.config, changes: res.changes ?? [], reply: res.reply ?? "" });
          setTurns((t) => [...t, { role: "assistant", text: res.reply || "Proposal ready — preview it on the canvas.", kind: "proposal" }]);
          toast.success("Proposal ready — preview it on the canvas");
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setTurns((t) => [...t, { role: "assistant", text: "Stopped.", kind: "text" }]);
      } else {
        const message = e instanceof Error ? e.message : "RIISHE is unavailable right now";
        setError(message);
        setTurns((t) => [...t, { role: "assistant", text: `Couldn't complete that: ${message}`, kind: "text" }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ consent gate
  if (!consented) {
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Telescope className="size-4 text-primary" aria-hidden />
          <p className="text-sm font-medium">RIISHE Design</p>
        </div>
        <p className="text-sm text-muted-foreground">
          RIISHE is the design-intelligence agent for Website Studio. With your consent it reads the
          current page, selection and design tokens you already have open, then proposes structured,
          schema-validated changes or audits the design. It runs on the shared server-side AI provider,
          never publishes anything, and reports unsupported actions honestly.
        </p>
        <div className="flex items-center gap-2">
          <Switch id="riishe-consent" checked={false} onCheckedChange={(v) => void enableConsent(v)} aria-label="Enable RIISHE design assistance" />
          <Label htmlFor="riishe-consent" className="text-sm">
            Enable RIISHE design assistance
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">You can also manage this in Trust &amp; settings.</p>
      </div>
    );
  }

  // ------------------------------------------------------------ main panel
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <Telescope className="size-4 text-primary" aria-hidden />
        <p className="text-sm font-medium">RIISHE Design</p>
        <span className="ml-auto rounded-full bg-gold-soft px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          Preview only
        </span>
      </div>

      {/* context */}
      <div className="flex flex-wrap gap-1.5 border-b border-border/60 px-4 py-2">
        <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
          {context.device} preview
        </span>
        <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
          {currentConfig.template}
        </span>
        {context.pageName && (
          <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            page: {context.pageName}
          </span>
        )}
        {context.sectionType && (
          <button
            type="button"
            onClick={onOpenSection}
            className="rounded-full border border-primary/40 bg-gold-soft/40 px-2 py-0.5 text-[10px] text-primary"
            title="Open the selected section in the content editor"
          >
            editing: {context.sectionTitle || context.sectionType}
          </button>
        )}
      </div>

      {/* conversation history */}
      <div ref={historyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" style={{ scrollbarWidth: "thin" }}>
        {turns.length === 0 && (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              Ask for a design change in plain language, or run an audit. Proposals are validated
              against the site schema, previewed on the canvas, and applied only when you accept
              them as a draft.
            </p>
            <p className="text-[11px] opacity-80">
              Changing one section never touches the others. Ambiguous or destructive requests get
              a clarifying question instead of a change.
            </p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-relaxed",
                t.role === "user"
                  ? "bg-gold-soft/50 text-foreground"
                  : t.kind === "audit"
                    ? "border border-primary/30 bg-background/60"
                    : "bg-muted/60"
              )}
            >
              {t.kind === "audit" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <ScanSearch className="size-3" aria-hidden /> Audit
                </p>
              )}
              {t.kind === "proposal" && (
                <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <Sparkles className="size-3" aria-hidden /> Proposal on canvas
                </p>
              )}
              {t.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> RIISHE is thinking…
          </div>
        )}
      </div>

      {/* suggestions */}
      {turns.length === 0 && !busy && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 pt-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void submit(s, "edit")}
              className="max-w-full truncate rounded-full border border-border/70 bg-background/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* input */}
      <div className="space-y-2 border-t border-border/60 p-4">
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <Textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={1000}
          placeholder="e.g. Make the hero calmer and keep the project grid untouched…"
          className="min-h-20"
          aria-label="Design request for RIISHE"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
              e.preventDefault();
              void submit(request, "edit");
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="flex-1" onClick={() => void submit(request, "edit")} disabled={busy !== false}>
            {busy === "edit" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            Propose changes
          </Button>
          <Button size="sm" variant="outline" onClick={() => void submit(request || AUDIT_EXAMPLES[0], "audit")} disabled={busy !== false} title="Get findings and recommendations without changing anything">
            <ScanSearch className="size-4" aria-hidden /> Audit
          </Button>
          {busy ? (
            <Button size="sm" variant="ghost" onClick={stop}>
              <Square className="size-3.5" aria-hidden /> Stop
            </Button>
          ) : (
            lastRequest && (
              <Button size="sm" variant="ghost" onClick={() => void submit(lastRequest.text, lastRequest.mode)} title="Retry the last request">
                <RotateCcw className="size-3.5" aria-hidden /> Retry
              </Button>
            )
          )}
        </div>
        {lastProposal && (
          <Button size="sm" variant="ghost" className="w-full" onClick={() => onProposal(null)} disabled={busy !== false}>
            Clear proposal preview
          </Button>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Runs on the shared server-side AI provider (GLM), using your daily AI quota shared with
          RIISHE chat. Examples: “{EDIT_EXAMPLES[0]}”
        </p>
      </div>
    </div>
  );
}

export { EDIT_EXAMPLES, AUDIT_EXAMPLES, designPresets };
