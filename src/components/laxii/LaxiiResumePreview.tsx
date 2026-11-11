"use client";

/**
 * LAXII Resume Studio — template-aware paper preview.
 * Pure presentation of the stored ResumeData: what you see is exactly what
 * the PDF/DOCX exporter renders (both consume the same document JSON).
 * Templates change typography and accents only — never content. Section
 * order, renames and custom sections come from the document itself
 * (orderedResumeSections), so universal formats produce genuinely different
 * document structures here as on paper.
 */

import type { ResumeData } from "@/lib/laxii-client";
import { orderedResumeSections } from "@/lib/laxii/resume-schema";
import { cn } from "@/lib/utils";

type TemplateId = "classic" | "modern" | "minimal" | "creative";

function joinParts(parts: (string | undefined | null)[], sep = " · "): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(sep);
}

function dateRange(start: string, end: string, current: boolean): string {
  return joinParts([start.trim(), current ? "Present" : end.trim()], " – ");
}

const TEMPLATES: Record<TemplateId, { nameClass: string; headingClass: string; rule: boolean; accentBar: boolean; bodyClass: string }> = {
  classic: {
    nameClass: "text-2xl font-bold tracking-wide text-neutral-900",
    headingClass: "text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-900 border-b border-neutral-300 pb-1",
    rule: false,
    accentBar: false,
    bodyClass: "font-serif text-neutral-800",
  },
  modern: {
    nameClass: "text-2xl font-bold text-neutral-900",
    headingClass: "text-[11px] font-bold uppercase tracking-[0.12em] text-[#A8842C] border-b-2 border-[#A8842C] pb-1",
    rule: true,
    accentBar: true,
    bodyClass: "text-neutral-800",
  },
  minimal: {
    nameClass: "text-xl font-medium tracking-wide text-neutral-800",
    headingClass: "text-[10px] font-semibold uppercase tracking-[0.22em] text-neutral-500",
    rule: false,
    accentBar: false,
    bodyClass: "text-neutral-700",
  },
  creative: {
    nameClass: "text-2xl font-extrabold text-white",
    headingClass: "text-[11px] font-bold uppercase tracking-[0.12em] text-[#A8842C]",
    rule: false,
    accentBar: true,
    bodyClass: "text-neutral-800",
  },
};

export function LaxiiResumePreview({ data, template }: { data: ResumeData; template: TemplateId }) {
  const t = TEMPLATES[template] ?? TEMPLATES.classic;
  const contact = joinParts([data.basics.email, data.basics.phone, data.basics.location, data.basics.website]);
  const sections = orderedResumeSections(data);

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[640px] rounded-sm bg-white px-8 py-7 text-neutral-800 shadow-2xl",
        t.bodyClass
      )}
      data-testid="laxii-resume-preview"
    >
      {t.accentBar && template === "creative" ? (
        <div className="-mx-8 -mt-7 mb-5 rounded-t-sm bg-neutral-900 px-8 py-5">
          <p className={cn(t.nameClass)}>{data.basics.name || "Your Name"}</p>
          {contact ? <p className="mt-1 text-xs text-neutral-300">{joinParts([data.basics.label, contact])}</p> : null}
        </div>
      ) : (
        <div className={cn(t.nameClass, t.rule && "border-b-2 border-[#A8842C] pb-3", template === "classic" && "text-center")}>
          {data.basics.name || "Your Name"}
          <div className={cn("mt-1 text-xs font-normal text-neutral-500", template === "classic" && "text-center")}>
            {joinParts([data.basics.label, contact])}
          </div>
        </div>
      )}

      {sections.map((s, idx) => (
        <section key={`${s.kind}-${idx}`} className={cn(idx === 0 ? "mt-4" : "mt-5")}>
          <h3 className={t.headingClass}>{s.title}</h3>

          {s.kind === "summary" ? (
            <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed">{data.basics.summary}</p>
          ) : null}

          {s.kind === "work" ? (
            <div className="mt-2 space-y-3">
              {data.work.map((w, i) => (
                <div key={i}>
                  <p className="text-[13px] font-semibold text-neutral-900">{w.position || w.company}</p>
                  <p className="text-[11.5px] italic text-neutral-500">
                    {joinParts([w.company !== w.position ? w.company : "", dateRange(w.startDate, w.endDate, w.current)])}
                  </p>
                  {w.summary ? <p className="mt-1 text-[12px] leading-relaxed">{w.summary}</p> : null}
                  {w.highlights.filter(Boolean).length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {w.highlights.filter(Boolean).map((h, j) => (
                        <li key={j} className="text-[12px] leading-relaxed">{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {s.kind === "education" ? (
            <div className="mt-2 space-y-2">
              {data.education.map((e, i) => (
                <div key={i}>
                  <p className="text-[13px] font-semibold text-neutral-900">{joinParts([e.studyType, e.area]) || e.institution}</p>
                  <p className="text-[11.5px] italic text-neutral-500">
                    {joinParts([e.institution, joinParts([e.startDate, e.endDate], " – "), e.score ? `Score: ${e.score}` : ""])}
                  </p>
                </div>
              ))}
            </div>
          ) : null}

          {s.kind === "skills" ? (
            <p className="mt-2 text-[12px] leading-relaxed">
              {data.skills.map((sk) => sk.name.trim()).filter(Boolean).join("  ·  ")}
            </p>
          ) : null}

          {s.kind === "projects" ? (
            <div className="mt-2 space-y-2">
              {data.projects.map((p, i) => (
                <div key={i}>
                  <p className="text-[13px] font-semibold text-neutral-900">{joinParts([p.name, p.url])}</p>
                  {p.description ? <p className="text-[12px] leading-relaxed">{p.description}</p> : null}
                  {p.highlights.filter(Boolean).length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {p.highlights.filter(Boolean).map((h, j) => (
                        <li key={j} className="text-[12px] leading-relaxed">{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {s.kind === "certificates" ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {data.certificates.map((c, i) => (
                <li key={i} className="text-[12px] leading-relaxed">{joinParts([c.name, c.issuer, c.date])}</li>
              ))}
            </ul>
          ) : null}

          {s.kind === "awards" ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {data.awards.map((a, i) => (
                <li key={i} className="text-[12px] leading-relaxed">{joinParts([a.title, a.awarder, a.date, a.summary])}</li>
              ))}
            </ul>
          ) : null}

          {s.kind === "custom" ? (
            <div className="mt-2 space-y-2">
              {s.section.entries.map((e, i) => (
                <div key={i}>
                  <p className="text-[13px] font-semibold text-neutral-900">{joinParts([e.title, e.url])}</p>
                  {joinParts([e.subtitle, e.meta]) ? (
                    <p className="text-[11.5px] italic text-neutral-500">{joinParts([e.subtitle, e.meta])}</p>
                  ) : null}
                  {e.summary ? <p className="mt-0.5 text-[12px] leading-relaxed">{e.summary}</p> : null}
                  {e.highlights.filter(Boolean).length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {e.highlights.filter(Boolean).map((h, j) => (
                        <li key={j} className="text-[12px] leading-relaxed">{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
