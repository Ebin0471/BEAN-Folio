"use client";

/**
 * LAXII Resume Studio — M33.5-B analysis panel.
 *
 * Two clearly separated deterministic reports (never an "ATS score"):
 *  - "Document readability" — structural checks with measured evidence and
 *    an explicit untested list (what no tool can know about vendor ATSs).
 *  - "Job evidence" — the requirement evidence map against the pasted JD:
 *    supported / partial / missing / not_assessable, each citing resume
 *    facts, with questions (never claims) for gaps.
 * Plus export round-trip verification of the exact produced bytes.
 */

import { useCallback, useState } from "react";
import { FileSearch, Loader2, ListChecks, ShieldQuestion, RefreshCw, CircleCheck, CircleAlert, CircleHelp, CircleMinus, Download } from "lucide-react";

import { cn } from "@/lib/utils";
import { laxiiApi, type ExportVerification, type JobEvidenceMap, type ReadabilityReport } from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const VERDICT_STYLE: Record<JobEvidenceMap["evidence"][number]["verdict"], { label: string; cls: string; Icon: typeof CircleCheck }> = {
  supported: { label: "Supported by your resume", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400", Icon: CircleCheck },
  partial: { label: "Partial evidence", cls: "border-amber-500/40 bg-amber-500/10 text-amber-400", Icon: CircleAlert },
  missing: { label: "No evidence found", cls: "border-rose-500/40 bg-rose-500/10 text-rose-400", Icon: CircleMinus },
  not_assessable: { label: "Not assessable", cls: "border-white/20 bg-white/[0.06] text-muted-foreground", Icon: ShieldQuestion },
};

const CHECK_STATUS_CLS: Record<ReadabilityReport["checks"][number]["status"], string> = {
  pass: "text-emerald-400",
  warning: "text-amber-400",
  fail: "text-rose-400",
  "not-run": "text-muted-foreground",
};

function PanelShell({ children, busy }: { children: React.ReactNode; busy: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3.5" data-testid="laxii-analysis-panel">
      {children}
      {busy ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Running deterministic checks…
        </p>
      ) : null}
    </div>
  );
}

export function LaxiiResumeAnalysisPanel({
  conversationId,
  savedJobDescription,
}: {
  conversationId: string;
  savedJobDescription: string;
}) {
  const [tab, setTab] = useState<"readability" | "job" | "export">("readability");
  const [busy, setBusy] = useState(false);
  const [readability, setReadability] = useState<ReadabilityReport | null>(null);
  const [evidenceMap, setEvidenceMap] = useState<JobEvidenceMap | null>(null);
  const [error, setError] = useState("");
  const [jd, setJd] = useState(savedJobDescription);
  const [exportVerification, setExportVerification] = useState<ExportVerification | null>(null);
  const [exportFormat, setExportFormat] = useState<"pdf" | "docx">("pdf");

  const runReadability = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await laxiiApi.resumeAnalyze(conversationId);
      setReadability(res.readability);
      if (res.evidenceMap) setEvidenceMap(res.evidenceMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }, [conversationId]);

  const runJobMap = useCallback(async () => {
    if (!jd.trim()) {
      setError("Paste the job description first — the evidence map compares it with your confirmed facts.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await laxiiApi.resumeAnalyze(conversationId, jd);
      setEvidenceMap(res.evidenceMap ?? null);
      setReadability(res.readability);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }, [conversationId, jd]);

  const runExportVerify = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await laxiiApi.resumeExportVerify(conversationId, exportFormat);
      setExportVerification(res.verification);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }, [conversationId, exportFormat]);

  return (
    <PanelShell busy={busy}>
      <div className="mb-3 flex min-h-7 items-center gap-2">
        <span className="text-primary"><FileSearch className="size-4" aria-hidden /></span>
        <h4 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Analysis</h4>
        <div className="flex shrink-0 gap-1" role="tablist" aria-label="Analysis sections">
          {([
            ["readability", "Readability"],
            ["job", "Job evidence"],
            ["export", "Export check"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] transition-colors",
                tab === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="mb-2 rounded-lg border border-rose-500/30 bg-rose-500/[0.07] px-2.5 py-1.5 text-[11.5px] text-rose-400" role="alert">{error}</p>
      ) : null}

      {tab === "readability" ? (
        <div data-testid="laxii-analysis-readability">
          {!readability ? (
            <div className="space-y-2">
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Deterministic structural checks on your saved document — text, headings, dates, links and layout. This is
                a practical diagnostic; it never predicts a real employer's applicant-tracking result.
              </p>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 border-white/15 bg-white/[0.04] text-[11.5px]" onClick={() => void runReadability()} disabled={busy} data-testid="laxii-analysis-run">
                <ListChecks className="size-3.5" aria-hidden /> Run readability checks
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10.5px] font-medium",
                    readability.status === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                      : readability.status === "review" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                      : readability.status === "problem" ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                      : "border-white/20 text-muted-foreground"
                  )}
                >
                  {readability.status === "good" ? "No structural problems found" : readability.status === "review" ? "Items to review" : readability.status === "problem" ? "Problems found" : "Not run"}
                </span>
                <span className="text-[10.5px] text-muted-foreground">evaluator {readability.evaluator} · report v{readability.reportVersion}</span>
                <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-2 text-[11px]" onClick={() => void runReadability()} disabled={busy}>
                  <RefreshCw className="size-3" aria-hidden /> Re-run
                </Button>
              </div>
              <ul className="space-y-1.5">
                {readability.checks.map((c) => (
                  <li key={c.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                    <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed">
                      <span className={cn("mt-0.5 shrink-0 font-semibold uppercase", CHECK_STATUS_CLS[c.status])}>{c.status}</span>
                      <span className="text-foreground/85">{c.detail}</span>
                    </p>
                    {c.remediation ? <p className="mt-0.5 pl-1 text-[10.5px] text-muted-foreground">Fix: {c.remediation}</p> : null}
                  </li>
                ))}
              </ul>
              <details className="rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5">
                <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">What this report cannot know</summary>
                <ul className="mt-1.5 space-y-1 text-[10.5px] leading-relaxed text-muted-foreground">
                  {readability.untested.map((u, i) => (
                    <li key={i}>· {u}</li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      ) : null}

      {tab === "job" ? (
        <div data-testid="laxii-analysis-job">
          <Textarea
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            rows={4}
            placeholder="Paste the job description — requirements are mapped against your confirmed facts only."
            aria-label="Job description for evidence mapping"
            className="resize-none border-white/10 bg-white/[0.04] text-[12.5px]"
          />
          <Button variant="outline" size="sm" className="mt-2 h-8 gap-1.5 border-primary/40 bg-primary/10 text-[11.5px] text-primary hover:bg-primary/20" onClick={() => void runJobMap()} disabled={busy} data-testid="laxii-analysis-map">
            <ListChecks className="size-3.5" aria-hidden /> Map requirements to my evidence
          </Button>
          {evidenceMap ? (
            <div className="mt-3 space-y-2">
              {evidenceMap.profile.roleTitle ? (
                <p className="text-[11.5px] text-foreground/80">
                  Role parsed: <span className="font-medium">{evidenceMap.profile.roleTitle}</span>
                  {evidenceMap.profile.organization ? <> · {evidenceMap.profile.organization}</> : null}
                </p>
              ) : null}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Descriptive coverage {Math.round(evidenceMap.weightedCoverage.value * 100)}% — a transparent calculation
                (required ×1, preferred ×0.5; supported ×1, partial ×0.5, missing ×0), not a prediction of any screening
                outcome. {evidenceMap.weightedCoverage.excludedNotAssessable} requirement(s) were not assessable.
              </p>
              <ul className="space-y-1.5">
                {evidenceMap.evidence.map((e, i) => {
                  const v = VERDICT_STYLE[e.verdict];
                  return (
                    <li key={i} className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
                      <p className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                        <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium", v.cls)}>
                          <v.Icon className="size-2.5" aria-hidden /> {v.label}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{e.requirement.importance} · {e.requirement.kind}</span>
                      </p>
                      <p className="mt-1 text-[11.5px] text-foreground/85">{e.requirement.text}</p>
                      {e.citations.length > 0 ? (
                        <ul className="mt-0.5 space-y-0.5">
                          {e.citations.map((c, j) => (
                            <li key={j} className="text-[10.5px] text-muted-foreground">↳ [{c.section}] “{c.fact.slice(0, 120)}”</li>
                          ))}
                        </ul>
                      ) : null}
                      {e.followUp ? (
                        <p className="mt-1 flex items-start gap-1 text-[10.5px] text-amber-400/90">
                          <CircleHelp className="mt-0.5 size-3 shrink-0" aria-hidden /> {e.followUp}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {evidenceMap.profile.parseWarnings.length > 0 ? (
                <p className="text-[10.5px] text-muted-foreground">{evidenceMap.profile.parseWarnings.join(" ")}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "export" ? (
        <div data-testid="laxii-analysis-export">
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Renders your saved resume, then decodes the produced bytes and checks that names, companies and headings
            survived in order — verification of OUR export, not of any employer system.
          </p>
          <div className="mt-2 flex gap-2">
            {(["pdf", "docx"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setExportFormat(f)}
                aria-pressed={exportFormat === f}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11px] uppercase",
                  exportFormat === f ? "border-primary/50 bg-primary/15 text-primary" : "border-white/15 text-muted-foreground hover:text-foreground"
                )}
              >
                {f}
              </button>
            ))}
            <Button variant="outline" size="sm" className="h-8 gap-1.5 border-white/15 bg-white/[0.04] text-[11.5px]" onClick={() => void runExportVerify()} disabled={busy} data-testid="laxii-analysis-verify">
              <Download className="size-3.5" aria-hidden /> Verify export
            </Button>
          </div>
          {exportVerification ? (
            <div className="mt-2.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[11.5px] leading-relaxed" data-testid="laxii-export-verification">
              <p className="flex items-center gap-1.5 font-medium">
                {exportVerification.decodeOk ? (
                  <CircleCheck className="size-3.5 text-emerald-400" aria-hidden />
                ) : (
                  <CircleAlert className="size-3.5 text-rose-400" aria-hidden />
                )}
                {exportVerification.decodeOk ? "Decoded successfully" : "Could not decode the produced file"}
                <span className="ml-auto text-[10.5px] font-normal text-muted-foreground">
                  {exportVerification.format.toUpperCase()} · {(exportVerification.byteLength / 1024).toFixed(1)} KB · {exportVerification.extractedChars.toLocaleString()} chars re-extracted
                </span>
              </p>
              <p className="mt-1 text-muted-foreground">
                {exportVerification.checkedFacts} key facts checked · {exportVerification.missingFacts.length} missing
                {exportVerification.missingFacts.length > 0 ? `: ${exportVerification.missingFacts.slice(0, 4).join(", ")}` : ""}
                {exportVerification.decodeOk ? ` · reading order ${exportVerification.readingOrderOk ? "intact" : "suspicious"}` : ""}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </PanelShell>
  );
}
