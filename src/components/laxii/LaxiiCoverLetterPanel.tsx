"use client";

/**
 * LAXII Cover Letter Studio — M33.5-D panel (secondary workspace tab inside
 * the existing career-document surface; not a competing application).
 *
 * Honesty rules surfaced here:
 *  - generation draws ONLY from the linked resume's confirmed facts + the
 *    pasted JD — the automated guard rejects invented names/metrics;
 *  - missing company/hiring-manager stays an explicit neutral placeholder;
 *  - AI-written paragraphs are badged "AI wording"; user edits lose the badge;
 *  - exports are decoded and re-read before the download is offered — the
 *    verification status is shown, never claimed beyond what was proven.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Loader2, Plus, Trash2, ArrowUp, ArrowDown, Save, Download, Copy,
  Sparkles, FileText, Mail, ShieldCheck, TriangleAlert, Briefcase,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { laxiiApi, type CoverLetterData, type CoverLetterLibraryItem, type ResumeSummary } from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Tone = CoverLetterData["tone"];
type Length = "concise" | "standard" | "detailed";

const TONES: { id: Tone; label: string }[] = [
  { id: "formal", label: "Formal" },
  { id: "confident", label: "Confident" },
  { id: "warm", label: "Warm" },
  { id: "direct", label: "Direct" },
  { id: "creative", label: "Creative" },
  { id: "academic", label: "Academic" },
];

const LENGTHS: { id: Length; label: string }[] = [
  { id: "concise", label: "Concise (~150 words)" },
  { id: "standard", label: "Standard (one page)" },
  { id: "detailed", label: "Detailed (~400 words)" },
];

function emptyLetter(): CoverLetterData {
  return {
    schemaVersion: 1,
    basics: { name: "", email: "", phone: "", location: "", website: "" },
    label: "",
    targetRole: "",
    companyName: "",
    hiringContactName: "",
    date: new Date().toISOString().slice(0, 10),
    salutation: "Dear Hiring Manager",
    opening: "",
    bodyParagraphs: [],
    closing: "Thank you for your consideration.",
    signatureName: "",
    tone: "formal",
    aiTouched: [],
    sourceResumeConversationId: "",
    jobDescriptionHash: "",
    wordCount: 0,
  };
}

function Field({ label, value, onChange, placeholder, testid }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testid?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 border-white/10 bg-white/[0.04] text-sm"
        data-testid={testid}
      />
    </label>
  );
}

export function LaxiiCoverLetterPanel({
  onBackToResume,
}: {
  onBackToResume: () => void;
}) {
  const [library, setLibrary] = useState<CoverLetterLibraryItem[]>([]);
  const [resumeLibrary, setResumeLibrary] = useState<ResumeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [letterId, setLetterId] = useState<string | null>(null);
  const [letter, setLetter] = useState<CoverLetterData>(emptyLetter());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "generate" | "rephrase" | "save" | "duplicate" | "export">("");

  // generate form
  const [genSource, setGenSource] = useState("");
  const [genRole, setGenRole] = useState("");
  const [genCompany, setGenCompany] = useState("");
  const [genContact, setGenContact] = useState("");
  const [genTone, setGenTone] = useState<Tone>("formal");
  const [genLength, setGenLength] = useState<Length>("standard");
  const [genDate, setGenDate] = useState(new Date().toISOString().slice(0, 10));
  const [genSalutation, setGenSalutation] = useState("Dear Hiring Manager");
  const [genJd, setGenJd] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [letters, resumes] = await Promise.all([laxiiApi.coverLetterList(), laxiiApi.resumeList()]);
      setLibrary(letters.letters);
      setResumeLibrary(resumes.resumes);
      if (!genSource && resumes.resumes.length > 0) setGenSource(resumes.resumes[0].conversationId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the letter library.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadLetter = useCallback(async (id: string) => {
    try {
      const d = await laxiiApi.coverLetterDetail(id);
      setLetter(d.letter);
      setLetterId(d.letterId);
      setDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the letter.");
    }
  }, []);

  function patch(next: Partial<CoverLetterData>) {
    setLetter((l) => ({ ...l, ...next }));
    setDirty(true);
  }

  async function runGenerate() {
    if (!genSource) {
      toast.error("Pick the resume this letter draws its facts from.");
      return;
    }
    if (!genJd.trim()) {
      toast.error("Paste the job description the letter answers to.");
      return;
    }
    setBusy("generate");
    try {
      const res = await laxiiApi.coverLetterGenerate({
        sourceResumeConversationId: genSource,
        targetRole: genRole,
        companyName: genCompany,
        hiringContactName: genContact,
        salutation: genSalutation,
        date: genDate,
        tone: genTone,
        length: genLength,
        jobDescription: genJd,
      });
      setLetter(res.letter);
      setLetterId(res.letterId);
      setDirty(false);
      await reload();
      toast.success("Letter drafted from your confirmed facts — review every line before sending anything.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generation failed.");
    } finally {
      setBusy("");
    }
  }

  async function runRephrase(target: string) {
    if (!letterId) return;
    setBusy("rephrase");
    try {
      const res = await laxiiApi.coverLetterRephrase(letterId, target);
      setLetter(res.letter);
      setDirty(false);
      toast.success("Paragraph reworded — every other paragraph is unchanged.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rephrasing failed.");
    } finally {
      setBusy("");
    }
  }

  async function save() {
    if (!letterId) return;
    setBusy("save");
    try {
      await laxiiApi.coverLetterSave(letterId, letter);
      setDirty(false);
      toast.success("Letter saved.");
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy("");
    }
  }

  async function duplicate() {
    if (!letterId) return;
    setBusy("duplicate");
    try {
      const res = await laxiiApi.coverLetterDuplicate(letterId);
      await reload();
      await loadLetter(res.letterId);
      toast.success("Copy created.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not duplicate.");
    } finally {
      setBusy("");
    }
  }

  async function exportLetter(format: "pdf" | "docx") {
    if (!letterId) return;
    setBusy("export");
    try {
      const res = await laxiiApi.coverLetterExport(letterId, format);
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "Export failed.");
      }
      const verification = res.headers.get("X-Bean-Export-Verification") ?? "";
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? `cover-letter.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (verification === "passed") toast.success(`${format.toUpperCase()} exported — text round-trip verified.`);
      else if (verification === "warning") toast.warning(`${format.toUpperCase()} exported, but some text could not be re-read from the file — check it.`);
      else toast.warning(`${format.toUpperCase()} exported, but the file could not be decoded for verification — check it manually.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy("");
    }
  }

  const badge = (key: string) =>
    letter.aiTouched.includes(key) ? (
      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
        <Sparkles className="size-2.5" aria-hidden /> AI wording
      </span>
    ) : null;

  const paragraphs = letter.bodyParagraphs;
  const wordCount = [letter.opening, ...paragraphs, letter.closing].join(" ").trim().split(/\s+/).filter(Boolean).length;

  if (loading) {
    return (
      <div className="grid place-items-center py-20" data-testid="laxii-cover-letter-loading">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading cover letters" />
      </div>
    );
  }

  return (
    <div className="mx-auto grid h-full w-full max-w-7xl grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4 px-4 py-4 lg:grid-cols-[minmax(340px,440px)_1fr] lg:grid-rows-[minmax(0,1fr)]" data-testid="laxii-cover-letter-panel">
      {/* LEFT — editor */}
      <div className="laxii-scroll min-h-0 space-y-3 overflow-y-auto pb-6 pr-1">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={onBackToResume} data-testid="laxii-cover-letter-back">
            ← Resume studio
          </Button>
          <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">COVER LETTER</span>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Mail className="size-3.5 text-primary" aria-hidden /> Your letters
          </p>
          {library.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No letters yet — generate the first draft below.</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto laxii-scroll">
              {library.map((l) => (
                <li key={l.letterId}>
                  <button
                    type="button"
                    onClick={() => void loadLetter(l.letterId)}
                    className={cn(
                      "w-full rounded-lg border px-2.5 py-1.5 text-left text-[11.5px] transition-colors",
                      letterId === l.letterId ? "border-primary/50 bg-primary/10 text-primary" : "border-white/10 bg-white/[0.03] text-foreground/80 hover:border-white/25"
                    )}
                  >
                    <span className="block truncate">{l.label || l.targetRole || "Cover letter"}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{new Date(l.updatedAt).toLocaleString()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Briefcase className="size-3.5 text-primary" aria-hidden /> New letter from a resume
          </p>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Source resume (facts come only from this)</span>
            <Select value={genSource || "none"} onValueChange={(v) => setGenSource(v === "none" ? "" : v)}>
              <SelectTrigger className="h-9 w-full min-w-0 border-white/10 bg-white/[0.04] text-sm" aria-label="Source resume" data-testid="laxii-cl-source">
                <SelectValue placeholder="Pick a resume" />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-2rem)]">
                {resumeLibrary.length === 0 ? <SelectItem value="none" disabled>No resumes yet — create one first</SelectItem> : null}
                {resumeLibrary.map((r) => (
                  <SelectItem key={r.conversationId} value={r.conversationId} className="whitespace-normal">
                    <span className="block whitespace-normal">{r.title}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Field label="Target role" value={genRole} onChange={setGenRole} placeholder="Senior Frontend Engineer" testid="laxii-cl-role" />
            <Field label="Company (optional)" value={genCompany} onChange={setGenCompany} placeholder="Leave empty if unknown" testid="laxii-cl-company" />
            <Field label="Hiring contact (optional)" value={genContact} onChange={setGenContact} placeholder="Only if you know the name" />
            <Field label="Date" value={genDate} onChange={setGenDate} placeholder="2026-11-25" />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Tone</span>
              <Select value={genTone} onValueChange={(v) => setGenTone(v as Tone)}>
                <SelectTrigger className="h-9 w-full min-w-0 border-white/10 bg-white/[0.04] text-sm" aria-label="Tone"><SelectValue /></SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  {TONES.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">Length</span>
              <Select value={genLength} onValueChange={(v) => setGenLength(v as Length)}>
                <SelectTrigger className="h-9 w-full min-w-0 border-white/10 bg-white/[0.04] text-sm" aria-label="Length"><SelectValue /></SelectTrigger>
                <SelectContent className="max-w-[calc(100vw-2rem)]">
                  {LENGTHS.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
          <div className="mt-2">
            <Textarea
              value={genJd}
              onChange={(e) => setGenJd(e.target.value)}
              rows={4}
              placeholder="Paste the job description — the letter answers it using only your real experience."
              aria-label="Job description"
              className="resize-none border-white/10 bg-white/[0.04] text-sm"
            />
          </div>
          <Button onClick={() => void runGenerate()} disabled={busy === "generate"} className="mt-2.5 h-10 w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90" data-testid="laxii-cl-generate">
            {busy === "generate" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            {busy === "generate" ? "Writing the letter…" : "Generate letter draft"}
          </Button>
          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            The guard rejects invented companies, names and numbers — a failed draft saves nothing. Missing company/contact stays a neutral placeholder you can edit.
          </p>
        </div>

        {letterId ? (
          <>
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Letter details</p>
              <Field label="Library name" value={letter.label} onChange={(v) => patch({ label: v })} placeholder="Acme — Senior PM — Nov" />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label="Target role" value={letter.targetRole} onChange={(v) => patch({ targetRole: v })} />
                <Field label="Company" value={letter.companyName} onChange={(v) => patch({ companyName: v })} />
                <Field label="Hiring contact" value={letter.hiringContactName} onChange={(v) => patch({ hiringContactName: v })} />
                <Field label="Date" value={letter.date} onChange={(v) => patch({ date: v })} />
              </div>
              <div className="mt-2">
                <Field label="Salutation" value={letter.salutation} onChange={(v) => patch({ salutation: v })} />
                {!letter.companyName && !letter.hiringContactName ? (
                  <p className="mt-1 text-[10.5px] text-amber-400/90">
                    Placeholder greeting in use — no company or contact was confirmed. Edit it before sending.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Opening {badge("opening")}
                <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-[10.5px]" onClick={() => void runRephrase("opening")} disabled={busy !== ""}>
                  <Sparkles className="size-3" aria-hidden /> Rephrase
                </Button>
              </p>
              <Textarea value={letter.opening} onChange={(e) => patch({ opening: e.target.value })} rows={4} aria-label="Opening paragraph" className="resize-none border-white/10 bg-white/[0.04] text-[12.5px]" />
            </div>

            {paragraphs.map((p, i) => (
              <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Paragraph {i + 1} {badge(`body:${i}`)}
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" aria-label="Move paragraph up" disabled={i === 0} onClick={() => patch({ bodyParagraphs: [...paragraphs.map((x, j) => (j === i - 1 ? x : j === i ? paragraphs[i - 1] : x))] })} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowUp className="size-3.5" aria-hidden /></button>
                    <button type="button" aria-label="Move paragraph down" disabled={i === paragraphs.length - 1} onClick={() => patch({ bodyParagraphs: [...paragraphs.map((x, j) => (j === i + 1 ? x : j === i ? paragraphs[i + 1] : x))] })} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowDown className="size-3.5" aria-hidden /></button>
                    <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[10.5px]" onClick={() => void runRephrase(`body:${i}`)} disabled={busy !== ""}>
                      <Sparkles className="size-3" aria-hidden /> Rephrase
                    </Button>
                    <button type="button" aria-label={`Remove paragraph ${i + 1}`} onClick={() => patch({ bodyParagraphs: paragraphs.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" aria-hidden /></button>
                  </span>
                </p>
                <Textarea value={p} onChange={(e) => patch({ bodyParagraphs: paragraphs.map((x, j) => (j === i ? e.target.value : x)) })} rows={5} aria-label={`Body paragraph ${i + 1}`} className="resize-none border-white/10 bg-white/[0.04] text-[12.5px]" />
              </div>
            ))}

            <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => patch({ bodyParagraphs: [...paragraphs, ""] })} disabled={paragraphs.length >= 6}>
              <Plus className="size-3" aria-hidden /> Add paragraph
            </Button>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Closing {badge("closing")}
                <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-1.5 text-[10.5px]" onClick={() => void runRephrase("closing")} disabled={busy !== ""}>
                  <Sparkles className="size-3" aria-hidden /> Rephrase
                </Button>
              </p>
              <Textarea value={letter.closing} onChange={(e) => patch({ closing: e.target.value })} rows={2} aria-label="Closing" className="resize-none border-white/10 bg-white/[0.04] text-[12.5px]" />
              <div className="mt-2">
                <Field label="Signature" value={letter.signatureName} onChange={(v) => patch({ signatureName: v })} />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => void save()} disabled={busy !== "" || !dirty} variant="outline" className="h-10 flex-1 gap-2 border-white/15 bg-white/[0.04]" data-testid="laxii-cl-save">
                {busy === "save" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
                {dirty ? "Save letter" : "Saved"}
              </Button>
              <Button onClick={() => void duplicate()} disabled={busy !== ""} variant="outline" className="h-10 flex-1 gap-2 border-white/15 bg-white/[0.04]">
                {busy === "duplicate" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Copy className="size-4" aria-hidden />} Duplicate
              </Button>
              <Button onClick={() => void exportLetter("pdf")} disabled={busy !== ""} className="h-10 flex-1 gap-2 bg-primary text-primary-foreground hover:bg-primary/90" data-testid="laxii-cl-export-pdf">
                {busy === "export" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />} PDF
              </Button>
              <Button onClick={() => void exportLetter("docx")} disabled={busy !== ""} variant="outline" className="h-10 flex-1 gap-2 border-primary/40 bg-primary/10 text-primary hover:bg-primary/20" data-testid="laxii-cl-export-docx">
                DOCX
              </Button>
            </div>
          </>
        ) : (
          <div className="grid min-h-[200px] place-items-center rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
            <div>
              <FileText className="mx-auto size-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Your letter appears here</p>
              <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                Pick the resume that holds your facts, paste the job description, and generate a draft. Everything stays editable before export.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT — paper preview */}
      <div className="laxii-scroll min-h-0 space-y-3 overflow-y-auto pb-6 pr-1">
        <div className="mx-auto w-full max-w-[640px] rounded-sm bg-white px-10 py-8 text-neutral-800 shadow-2xl" data-testid="laxii-cover-letter-preview">
          <p className="text-lg font-bold text-neutral-900">{letter.basics.name || "Your Name"}</p>
          {[letter.basics.email, letter.basics.phone, letter.basics.location, letter.basics.website].some(Boolean) ? (
            <p className="mt-0.5 text-[11px] text-neutral-500">{[letter.basics.email, letter.basics.phone, letter.basics.location, letter.basics.website].filter(Boolean).join("  ·  ")}</p>
          ) : null}
          <p className="mt-4 text-[12px] text-neutral-700">{letter.date}</p>
          {letter.hiringContactName || letter.companyName ? (
            <p className="mt-3 whitespace-pre-line text-[12px] text-neutral-700">{[letter.hiringContactName, letter.companyName].filter(Boolean).join("\n")}</p>
          ) : null}
          <p className="mt-3 text-[12.5px] text-neutral-800">{letter.salutation}{letter.salutation.trim() ? "," : ""}</p>
          <p className="mt-3 whitespace-pre-wrap text-[12.5px] leading-relaxed">{letter.opening || "The opening paragraph appears here."}</p>
          {paragraphs.map((p, i) => (
            <p key={i} className="mt-3 whitespace-pre-wrap text-[12.5px] leading-relaxed">{p}</p>
          ))}
          <p className="mt-3 whitespace-pre-wrap text-[12.5px] leading-relaxed">{letter.closing}</p>
          <p className="mt-4 text-[12.5px] font-semibold text-neutral-900">{letter.signatureName || letter.basics.name || ""}</p>
        </div>
        <p className="flex items-start gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[11px] leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
          Drafts and files stay private until you send them yourself. Always read the final letter — you are responsible for every claim it makes.
        </p>
        <p className="text-right text-[10.5px] text-muted-foreground">{wordCount} words {letter.wordCount ? `(saved: ${letter.wordCount})` : ""}</p>
      </div>
    </div>
  );
}
