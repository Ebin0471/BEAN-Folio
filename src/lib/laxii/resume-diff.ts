/**
 * LAXII Resume Studio — M33.5-C resume document diff.
 *
 * Pure structural comparison between two ResumeData documents, used by the
 * "Create tailored copy" flow (spec §5.4.5: "Show a before/after diff and
 * exact facts removed/de-emphasized/reworded") and by revision compare in
 * the UI. Deterministic, PII-safe output (the caller decides what to show).
 */

import type { ResumeData } from "./resume-schema";

export interface ResumeDiff {
  /** Sections whose wording actually changed. */
  changedSections: string[];
  /** Work entries present before but absent after (company — position). */
  removedWork: string[];
  /** Work entries whose summary/highlights were reworded. */
  rewordedWork: string[];
  /** Education entries removed. */
  removedEducation: string[];
  /** Skills present before but absent after — tailoring may de-emphasize, never silently delete. */
  removedSkills: string[];
  /** Skills added (allowed only when the USER did it; AI tailoring must not add). */
  addedSkills: string[];
  /** Pure reordering (same sets, different order) — de-emphasis, not deletion. */
  skillsReordered: boolean;
  /** Basics/summary rewording. */
  summaryChanged: boolean;
  basicsChanged: boolean;
  customSectionsChanged: boolean;
  /** Human-readable summary lines for notes/UI (bounded). */
  summary: string[];
}

function setOf<T>(arr: T[], key: (x: T) => string): Set<string> {
  return new Set(arr.map(key));
}

function workKey(w: { company: string; position: string }): string {
  return `${w.company.trim()}|${w.position.trim()}`.toLowerCase();
}

export function diffResumeDocuments(before: ResumeData, after: ResumeData): ResumeDiff {
  const changedSections: string[] = [];
  const summary: string[] = [];

  const summaryChanged = before.basics.summary.trim() !== after.basics.summary.trim();
  if (summaryChanged) changedSections.push("summary");

  const basicsChanged =
    before.basics.name !== after.basics.name ||
    before.basics.email !== after.basics.email ||
    before.basics.phone !== after.basics.phone ||
    before.basics.location !== after.basics.location ||
    before.basics.website !== after.basics.website ||
    before.basics.label !== after.basics.label;
  if (basicsChanged) changedSections.push("basics");

  const beforeWorkKeys = setOf(before.work, workKey);
  const afterWorkKeys = setOf(after.work, workKey);
  const removedWork = before.work.filter((w) => !afterWorkKeys.has(workKey(w))).map((w) => [w.company, w.position].filter(Boolean).join(" — "));
  const rewordedWork = before.work
    .filter((w) => afterWorkKeys.has(workKey(w)))
    .filter((w) => {
      const a = after.work.find((x) => workKey(x) === workKey(w))!;
      return w.summary !== a.summary || JSON.stringify(w.highlights) !== JSON.stringify(a.highlights);
    })
    .map((w) => [w.company, w.position].filter(Boolean).join(" — "));
  if (removedWork.length > 0 || rewordedWork.length > 0) changedSections.push("work");

  const beforeEduKeys = setOf(before.education, (e) => e.institution.trim().toLowerCase());
  const afterEduKeys = setOf(after.education, (e) => e.institution.trim().toLowerCase());
  const removedEducation = before.education.filter((e) => !afterEduKeys.has(e.institution.trim().toLowerCase())).map((e) => e.institution.trim());
  if (removedEducation.length > 0) changedSections.push("education");

  const beforeSkills = before.skills.map((s) => s.name.trim().toLowerCase()).filter(Boolean);
  const afterSkills = after.skills.map((s) => s.name.trim().toLowerCase()).filter(Boolean);
  const beforeSet = new Set(beforeSkills);
  const afterSet = new Set(afterSkills);
  const removedSkills = before.skills.filter((s) => !afterSet.has(s.name.trim().toLowerCase())).map((s) => s.name.trim());
  const addedSkills = after.skills.filter((s) => !beforeSet.has(s.name.trim().toLowerCase())).map((s) => s.name.trim());
  const skillsReordered =
    beforeSkills.length === afterSkills.length &&
    beforeSkills.every((s) => afterSet.has(s)) &&
    beforeSkills.join("\u0000") !== afterSkills.join("\u0000");
  if (removedSkills.length > 0 || addedSkills.length > 0 || skillsReordered) changedSections.push("skills");

  const projectsChanged = JSON.stringify(before.projects) !== JSON.stringify(after.projects);
  if (projectsChanged) changedSections.push("projects");
  const certsChanged = JSON.stringify(before.certificates) !== JSON.stringify(after.certificates);
  if (certsChanged) changedSections.push("certificates");
  const awardsChanged = JSON.stringify(before.awards) !== JSON.stringify(after.awards);
  if (awardsChanged) changedSections.push("awards");

  const beforeCustom = JSON.stringify(before.custom);
  const afterCustom = JSON.stringify(after.custom);
  const customSectionsChanged = beforeCustom !== afterCustom;

  if (summaryChanged) summary.push("Professional summary reworded for the target role.");
  if (rewordedWork.length > 0) summary.push(`Experience wording adjusted for ${rewordedWork.length} role(s): ${rewordedWork.slice(0, 3).join(", ")}${rewordedWork.length > 3 ? "…" : ""}.`);
  if (skillsReordered) summary.push("Skills reordered — the most relevant evidence leads.");
  if (removedSkills.length > 0) summary.push(`Skills de-emphasized (content kept in the master): ${removedSkills.slice(0, 5).join(", ")}.`);
  if (addedSkills.length > 0) summary.push(`Skills added: ${addedSkills.slice(0, 5).join(", ")}.`);
  if (removedWork.length > 0) summary.push(`Roles removed from this copy (master keeps them): ${removedWork.slice(0, 3).join(", ")}.`);
  if (removedEducation.length > 0) summary.push(`Education removed from this copy (master keeps it): ${removedEducation.slice(0, 3).join(", ")}.`);
  if (customSectionsChanged) summary.push("Custom sections changed.");
  if (summary.length === 0) summary.push("No content changes — the copy starts identical to the master.");

  return {
    changedSections: Array.from(new Set(changedSections)),
    removedWork,
    rewordedWork,
    removedEducation,
    removedSkills,
    addedSkills,
    skillsReordered,
    summaryChanged,
    basicsChanged,
    customSectionsChanged,
    summary: summary.slice(0, 10),
  };
}
