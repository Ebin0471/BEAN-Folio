"use client";

/**
 * LAXII Resume Studio — M33.5-A structured import review.
 *
 * The review gate between an uploaded resume and the facts form: the
 * deterministic extraction proposal is shown field-by-field with its
 * confidence bucket and source snippet; the user accepts, edits or skips
 * every field. NOTHING reaches the facts form (or the server) until the
 * user confirms here. Discarding throws the proposal and its raw text away.
 *
 * Honest framing: confidence buckets are deterministic pattern results —
 * "high" means a label/structural anchor matched, never that the value was
 * "verified". Every value stays editable inside the facts form afterwards.
 */

import { useMemo, useState } from "react";
import { CircleAlert, FileText, Sparkles, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  ImportProposalField,
  ResumeAwardItem,
  ResumeCertificateItem,
  ResumeEducationItem,
  ResumeImportProposal,
  ResumeProjectItem,
  ResumeWorkItem,
} from "@/lib/laxii-client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type BasicsKey = "name" | "label" | "email" | "phone" | "website" | "location" | "summary";

interface AcceptedBasics {
  key: BasicsKey;
  value: string;
}
export interface ApplyPayload {
  basics: AcceptedBasics[];
  work: ResumeWorkItem[];
  education: ResumeEducationItem[];
  skills: string[];
  projects: ResumeProjectItem[];
  certificates: ResumeCertificateItem[];
  awards: ResumeAwardItem[];
}

const CONFIDENCE_STYLE: Record<ImportProposalField["confidence"], string> = {
  high: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  review: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  low: "border-white/20 bg-white/[0.06] text-muted-foreground",
};

function ConfidenceBadge({ confidence }: { confidence: ImportProposalField["confidence"] }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium", CONFIDENCE_STYLE[confidence])}>
      {confidence === "high" ? "high confidence" : confidence === "review" ? "review" : "low confidence"}
    </span>
  );
}

function Snippet({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="mt-1 truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80" title={text}>
      source: {text}
    </p>
  );
}

function Row({ checked, onChecked, children }: {
  checked: boolean;
  onChecked: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5", !checked && "opacity-55")}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChecked(v === true)} className="mt-0.5" aria-label="Include this proposed field" />
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function LaxiiResumeImportReview({
  proposal,
  open,
  onApply,
  onDiscard,
}: {
  proposal: ResumeImportProposal | null;
  open: boolean;
  onApply: (payload: ApplyPayload) => void;
  onDiscard: () => void;
}) {
  const [basics, setBasics] = useState<Record<string, { accepted: boolean; value: string }>>({});
  const [work, setWork] = useState<{ accepted: boolean; value: ResumeWorkItem }[]>([]);
  const [education, setEducation] = useState<{ accepted: boolean; value: ResumeEducationItem }[]>([]);
  const [skills, setSkills] = useState<{ accepted: boolean; value: string }[]>([]);
  const [projects, setProjects] = useState<{ accepted: boolean; value: ResumeProjectItem }[]>([]);
  const [certificates, setCertificates] = useState<{ accepted: boolean; value: ResumeCertificateItem }[]>([]);
  const [awards, setAwards] = useState<{ accepted: boolean; value: ResumeAwardItem }[]>([]);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Seed the local (editable) review state once per proposal — React's
  // documented "adjusting state when a prop changes" render-phase pattern
  // (guarded by seededFor, so it converges immediately).
  const seedKey = proposal ? `${proposal.schemaVersion}:${proposal.source.fileName}:${proposal.source.charCount}` : null;
  if (proposal && open && seedKey && seededFor !== seedKey) {
    const seedBasics: Record<string, { accepted: boolean; value: string }> = {};
    const put = (k: string, f: ImportProposalField | null) => {
      if (f) seedBasics[k] = { accepted: f.confidence === "high", value: String(f.value ?? "") };
    };
    put("name", proposal.basics.name);
    put("label", proposal.basics.label);
    put("email", proposal.basics.email);
    put("phone", proposal.basics.phone);
    put("website", proposal.basics.website);
    put("location", proposal.basics.location);
    put("summary", proposal.basics.summary);
    setBasics(seedBasics);
    setWork(proposal.work.map((w) => ({ accepted: w.confidence === "high", value: { ...w.value } })));
    setEducation(proposal.education.map((e) => ({ accepted: e.confidence === "high", value: { ...e.value } })));
    setSkills(proposal.skills.map((s) => ({ accepted: s.confidence === "high", value: s.value })));
    setProjects(proposal.projects.map((p) => ({ accepted: false, value: { ...p.value } })));
    setCertificates(proposal.certificates.map((c) => ({ accepted: false, value: { ...c.value } })));
    setAwards(proposal.awards.map((a) => ({ accepted: false, value: { ...a.value } })));
    setSeededFor(seedKey);
  }

  const counts = useMemo(() => {
    const accepted =
      Object.values(basics).filter((b) => b.accepted).length +
      work.filter((w) => w.accepted).length +
      education.filter((e) => e.accepted).length +
      skills.filter((s) => s.accepted).length +
      projects.filter((p) => p.accepted).length +
      certificates.filter((c) => c.accepted).length +
      awards.filter((a) => a.accepted).length;
    const proposed =
      Object.keys(basics).length + work.length + education.length + skills.length + projects.length + certificates.length + awards.length;
    return { accepted, proposed };
  }, [basics, work, education, skills, projects, certificates, awards]);

  function selectAllHigh() {
    if (!proposal) return;
    const b: Record<string, { accepted: boolean; value: string }> = {};
    const put = (k: string, f: ImportProposalField | null) => {
      if (f) b[k] = { accepted: f.confidence === "high", value: basics[k]?.value ?? String(f.value ?? "") };
    };
    put("name", proposal.basics.name);
    put("label", proposal.basics.label);
    put("email", proposal.basics.email);
    put("phone", proposal.basics.phone);
    put("website", proposal.basics.website);
    put("location", proposal.basics.location);
    put("summary", proposal.basics.summary);
    setBasics(b);
    setWork((w) => w.map((x, i) => ({ ...x, accepted: proposal.work[i]?.confidence === "high" })));
    setEducation((e) => e.map((x, i) => ({ ...x, accepted: proposal.education[i]?.confidence === "high" })));
    setSkills((s) => s.map((x, i) => ({ ...x, accepted: proposal.skills[i]?.confidence === "high" })));
    setProjects((p) => p.map((x) => ({ ...x, accepted: false })));
    setCertificates((c) => c.map((x) => ({ ...x, accepted: false })));
    setAwards((a) => a.map((x) => ({ ...x, accepted: false })));
  }

  function confirm() {
    if (!proposal) return;
    onApply({
      basics: Object.entries(basics)
        .filter(([, v]) => v.accepted && v.value.trim())
        .map(([key, v]) => ({ key: key as BasicsKey, value: v.value })),
      work: work.filter((w) => w.accepted).map((w) => w.value),
      education: education.filter((e) => e.accepted).map((e) => e.value),
      skills: skills.filter((s) => s.accepted).map((s) => s.value.trim()).filter(Boolean),
      projects: projects.filter((p) => p.accepted).map((p) => p.value),
      certificates: certificates.filter((c) => c.accepted).map((c) => c.value),
      awards: awards.filter((a) => a.accepted).map((a) => a.value),
    });
  }

  if (!proposal) return null;
  const src = proposal.source;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDiscard(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" data-testid="laxii-import-review">
        <DialogHeader className="border-b border-white/10 px-4 py-3 text-left sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FileText className="size-4 text-primary" aria-hidden /> Review extracted facts
          </DialogTitle>
          <DialogDescription className="text-[11.5px] leading-relaxed">
            {src.fileName ? <span className="font-medium text-foreground/80">{src.fileName} — </span> : null}
            {src.charCount.toLocaleString()} characters ({src.method}
            {src.truncated ? ", truncated at 8,000" : ""}). Accept only what is correct — accepted fields fill the facts
            form, where everything stays editable. Nothing is saved until you generate a resume.
          </DialogDescription>
        </DialogHeader>

        <div className="laxii-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 sm:px-5">
          {proposal.warnings.length > 0 ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3" data-testid="laxii-import-warnings">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                <TriangleAlert className="size-3.5" aria-hidden /> Things to check
              </p>
              <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                {proposal.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Basics */}
          {Object.keys(basics).length > 0 ? (
            <section aria-label="Proposed personal details" className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Personal details</p>
              {(["name", "label", "email", "phone", "website", "location"] as BasicsKey[]).map((k) =>
                basics[k] ? (
                  <Row key={k} checked={basics[k].accepted} onChecked={(v) => setBasics((b) => ({ ...b, [k]: { ...b[k], accepted: v } }))}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium capitalize text-foreground/80">{k === "label" ? "target role" : k}</span>
                      <ConfidenceBadge confidence={proposal.basics[k]?.confidence ?? "review"} />
                    </div>
                    <Input
                      value={basics[k].value}
                      onChange={(e) => setBasics((b) => ({ ...b, [k]: { ...b[k], value: e.target.value } }))}
                      className="mt-1 h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Proposed ${k}`}
                    />
                    {proposal.basics[k]?.warnings.length ? (
                      <p className="mt-1 text-[10.5px] text-amber-400/90">{proposal.basics[k]!.warnings.join(" ")}</p>
                    ) : null}
                    <Snippet text={proposal.basics[k]?.snippet ?? ""} />
                  </Row>
                ) : null
              )}
              {basics.summary ? (
                <Row checked={basics.summary.accepted} onChecked={(v) => setBasics((b) => ({ ...b, summary: { ...b.summary, accepted: v } }))}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground/80">Summary</span>
                    <ConfidenceBadge confidence={proposal.basics.summary?.confidence ?? "review"} />
                  </div>
                  <Textarea
                    value={basics.summary.value}
                    onChange={(e) => setBasics((b) => ({ ...b, summary: { ...b.summary, value: e.target.value } }))}
                    rows={4}
                    className="mt-1 resize-none border-white/10 bg-white/[0.04] text-[12.5px]"
                    aria-label="Proposed summary"
                  />
                  <Snippet text={proposal.basics.summary?.snippet ?? ""} />
                </Row>
              ) : null}
            </section>
          ) : null}

          {/* Work */}
          {work.length > 0 ? (
            <section aria-label="Proposed experience" className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Experience</p>
              {work.map((w, i) => (
                <Row key={i} checked={w.accepted} onChecked={(v) => setWork((arr) => arr.map((x, j) => (j === i ? { ...x, accepted: v } : x)))}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground/80">Role {i + 1}</span>
                    <ConfidenceBadge confidence={proposal.work[i]?.confidence ?? "review"} />
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-1.5">
                    <Input
                      value={w.value.position}
                      onChange={(e) => setWork((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, position: e.target.value } } : x)))}
                      placeholder="Position"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Role ${i + 1} position`}
                    />
                    <Input
                      value={w.value.company}
                      onChange={(e) => setWork((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, company: e.target.value } } : x)))}
                      placeholder="Company"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Role ${i + 1} company`}
                    />
                    <Input
                      value={w.value.startDate}
                      onChange={(e) => setWork((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, startDate: e.target.value } } : x)))}
                      placeholder="Start"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Role ${i + 1} start date`}
                    />
                    <Input
                      value={w.value.current ? "Present" : w.value.endDate}
                      onChange={(e) => setWork((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, endDate: e.target.value, current: false } } : x)))}
                      placeholder="End"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Role ${i + 1} end date`}
                    />
                  </div>
                  {w.value.highlights.length > 0 ? (
                    <p className="mt-1 text-[10.5px] text-muted-foreground">{w.value.highlights.length} highlight bullet(s) extracted.</p>
                  ) : null}
                  {proposal.work[i]?.warnings.length ? (
                    <p className="mt-1 text-[10.5px] text-amber-400/90">{proposal.work[i]!.warnings.join(" ")}</p>
                  ) : null}
                  <Snippet text={proposal.work[i]?.snippet ?? ""} />
                </Row>
              ))}
            </section>
          ) : null}

          {/* Education */}
          {education.length > 0 ? (
            <section aria-label="Proposed education" className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Education</p>
              {education.map((e, i) => (
                <Row key={i} checked={e.accepted} onChecked={(v) => setEducation((arr) => arr.map((x, j) => (j === i ? { ...x, accepted: v } : x)))}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-foreground/80">{e.value.studyType || "Entry"} {e.value.institution ? `— ${e.value.institution}` : ""}</span>
                    <ConfidenceBadge confidence={proposal.education[i]?.confidence ?? "review"} />
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-1.5">
                    <Input
                      value={e.value.institution}
                      onChange={(ev) => setEducation((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, institution: ev.target.value } } : x)))}
                      placeholder="Institution"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Education ${i + 1} institution`}
                    />
                    <Input
                      value={e.value.studyType}
                      onChange={(ev) => setEducation((arr) => arr.map((x, j) => (j === i ? { ...x, value: { ...x.value, studyType: ev.target.value } } : x)))}
                      placeholder="Degree"
                      className="h-8 border-white/10 bg-white/[0.04] text-[12.5px]"
                      aria-label={`Education ${i + 1} degree`}
                    />
                  </div>
                  {proposal.education[i]?.warnings.length ? (
                    <p className="mt-1 text-[10.5px] text-amber-400/90">{proposal.education[i]!.warnings.join(" ")}</p>
                  ) : null}
                  <Snippet text={proposal.education[i]?.snippet ?? ""} />
                </Row>
              ))}
            </section>
          ) : null}

          {/* Skills */}
          {skills.length > 0 ? (
            <section aria-label="Proposed skills" className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Skills</p>
              <div className="flex flex-wrap gap-1.5">
                {skills.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSkills((arr) => arr.map((x, j) => (j === i ? { ...x, accepted: !x.accepted } : x)))}
                    aria-pressed={s.accepted}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                      s.accepted ? "border-primary/50 bg-primary/15 text-primary" : "border-white/15 bg-white/[0.03] text-muted-foreground hover:border-white/30"
                    )}
                  >
                    {s.value}
                    {proposal.skills[i]?.confidence === "review" ? <CircleAlert className="size-3" aria-hidden /> : null}
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] text-muted-foreground">Click to include or skip. Marked with a dot: pattern-detected, confirm the spelling.</p>
            </section>
          ) : null}

          {/* Projects / certificates / awards (compact lists) */}
          {(["projects", "certificates", "awards"] as const).map((group) => {
            const list = group === "projects" ? projects : group === "certificates" ? certificates : awards;
            const setList = group === "projects" ? setProjects : group === "certificates" ? setCertificates : setAwards;
            const prop = group === "projects" ? proposal.projects : group === "certificates" ? proposal.certificates : proposal.awards;
            if (list.length === 0) return null;
            const titleOf = (idx: number) => {
              const v = list[idx].value;
              return group === "projects" ? (v as ResumeProjectItem).name : group === "certificates" ? (v as ResumeCertificateItem).name : (v as ResumeAwardItem).title;
            };
            return (
              <section key={group} aria-label={`Proposed ${group}`} className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group === "projects" ? "Projects" : group === "certificates" ? "Certifications" : "Achievements"}
                </p>
                {list.map((item, i) => (
                  <Row key={i} checked={item.accepted} onChecked={(v) => setList((arr: typeof list) => arr.map((x, j) => (j === i ? { ...x, accepted: v } : x)))}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">{titleOf(i) || `${group} ${i + 1}`}</span>
                      <ConfidenceBadge confidence={prop[i]?.confidence ?? "review"} />
                    </div>
                    <Snippet text={prop[i]?.snippet ?? ""} />
                  </Row>
                ))}
              </section>
            );
          })}

          {counts.proposed === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center">
              <p className="text-[12.5px] font-medium">No structured fields could be proposed confidently.</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                The extracted text is still available below as source material — fill the facts form manually for the best result.
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex-col gap-2 border-t border-white/10 px-4 py-3 sm:flex-row sm:justify-between sm:px-5">
          <p className="text-[11px] text-muted-foreground" aria-live="polite">
            {counts.accepted} of {counts.proposed} proposed fields selected
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="h-8 text-[11.5px]" onClick={selectAllHigh}>
              <Sparkles className="size-3" aria-hidden /> Select high-confidence
            </Button>
            <Button variant="outline" size="sm" className="h-8 border-white/15 bg-white/[0.04] text-[11.5px]" onClick={onDiscard}>
              Discard
            </Button>
            <Button size="sm" className="h-8 bg-primary text-[11.5px] text-primary-foreground hover:bg-primary/90" onClick={confirm} disabled={counts.accepted === 0} data-testid="laxii-import-confirm">
              Use {counts.accepted} in form
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
