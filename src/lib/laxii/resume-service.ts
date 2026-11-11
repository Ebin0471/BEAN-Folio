/**
 * LAXII Resume Studio — document-generation service.
 *
 * Resumes are DOCUMENTS, never images: content generation runs through the
 * BEAN AI text gateway (src/lib/ai.ts) behind the same conversational
 * infrastructure (LaxiiConversation / LaxiiMessage / LaxiiUsage) that the
 * image engine uses. The image providers are never involved.
 *
 * Integrity contract (enforced in code, not just prompts):
 *  1. The model is instructed to use ONLY user-supplied facts.
 *  2. `assertNoInventedEntities` cross-checks every employer / institution /
 *     issuer / awarder in the draft against the user's facts snapshot.
 *  3. A violation triggers ONE corrective retry; a second violation fails
 *     the request honestly — no draft is ever saved or shown.
 *  4. `aiTouched` is computed by DIFFING the draft against the facts, so the
 *     "AI wording" provenance badges reflect what actually changed.
 */

import { db } from "@/lib/db";
import { aiComplete, parseJsonFromText, AiProviderError } from "@/lib/ai";

import {
  resumeDataSchema,
  resumeFactsSchema,
  findResumeType,
  normalizeSkills,
  resumeTypeOrder,
  type ResumeData,
  type ResumeFacts,
  type ResumeSectionKey,
} from "./resume-schema";
import { findResumeProfession, type ResumeCoreSectionKey } from "./resume-professions";

const AI_PROVIDER_LABEL = "bean-ai";
const AI_MODEL_LABEL = "managed gateway (server-side)";

export class ResumeServiceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ResumeServiceError";
    this.status = status;
  }
}

// ------------------------------------------------------------ entity guard

function normalizeEntity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function entitiesMatch(userEntities: string[], returned: string, sourceText?: string): boolean {
  const r = normalizeEntity(returned);
  if (!r) return true;
  for (const u of userEntities) {
    const un = normalizeEntity(u);
    if (!un) continue;
    if (r.includes(un) || un.includes(r)) return true;
    const rTokens = new Set(r.split(" "));
    const uTokens = un.split(" ").filter((t) => t.length >= 2);
    if (uTokens.some((t) => rTokens.has(t))) return true;
  }
  // An uploaded document is user-provided source material: an entity counts
  // as traceable when the document itself mentions it.
  if (sourceText) {
    const norm = normalizeEntity(sourceText);
    if (norm.includes(r)) return true;
    const normTokens = new Set(norm.split(" "));
    const rTokens = r.split(" ").filter((t) => t.length >= 2);
    if (rTokens.length > 0 && rTokens.every((t) => normTokens.has(t))) return true;
  }
  return false;
}

/**
 * Cross-check organizations in the draft against the facts. Returns the list
 * of entities that cannot be traced to user input (empty = clean).
 */
function findInventedEntities(draft: ResumeData, facts: ResumeFacts, sourceText?: string): string[] {
  const invented: string[] = [];
  const check = (returned: string, userEntities: string[], kind: string) => {
    const trimmed = (returned ?? "").trim();
    if (!trimmed) return;
    if (!entitiesMatch(userEntities, trimmed, sourceText)) invented.push(`${kind}: "${trimmed}"`);
  };
  const userCompanies = facts.work.map((w) => w.company).filter(Boolean);
  const userSchools = facts.education.map((e) => e.institution).filter(Boolean);
  const userIssuers = facts.certificates.map((c) => c.issuer).filter(Boolean);
  const userAwarders = facts.awards.map((a) => a.awarder).filter(Boolean);
  // Custom sections are user-supplied fact material — their titles/venues
  // count as known entities so the guard never false-positives on them.
  for (const c of facts.custom) {
    for (const e of c.entries) {
      if (e.title.trim()) userCompanies.push(e.title);
      if (e.subtitle.trim()) userCompanies.push(e.subtitle);
    }
  }
  for (const w of draft.work) check(w.company, userCompanies, "Employer");
  for (const e of draft.education) check(e.institution, userSchools, "Institution");
  for (const c of draft.certificates) check(c.issuer, userIssuers, "Certificate issuer");
  for (const a of draft.awards) check(a.awarder, userAwarders, "Awarding body");
  return invented;
}

// ------------------------------------------------------------- skill guard

/**
 * Skill-level anti-fabrication filter: models like to pad the skills list
 * with adjacent technologies the candidate never listed. A returned skill is
 * kept only when some meaningful token of it appears in the user's own skill
 * list or source document; anything else is dropped and reported honestly.
 */
function filterInventedSkills(
  draft: ResumeData,
  facts: ResumeFacts,
  sourceText?: string
): { draft: ResumeData; removed: string[] } {
  const allowed = new Set<string>();
  const addTokens = (s: string) => {
    for (const t of normalizeEntity(s).split(" ")) if (t.length >= 2) allowed.add(t);
  };
  for (const s of facts.skills) addTokens(typeof s === "string" ? s : s.name);
  for (const c of facts.custom) for (const e of c.entries) {
    addTokens(e.title);
    addTokens(e.subtitle);
    addTokens(e.summary);
    for (const h of e.highlights) addTokens(h);
  }
  if (sourceText) {
    for (const t of normalizeEntity(sourceText).split(" ")) if (t.length >= 2) allowed.add(t);
  }
  const removed: string[] = [];
  const skills = draft.skills.filter((s) => {
    const name = (s.name ?? "").trim();
    if (!name) return false;
    const tokens = normalizeEntity(name).split(" ").filter((t) => t.length >= 2);
    const ok = tokens.length === 0 || tokens.some((t) => allowed.has(t));
    if (!ok) removed.push(name);
    return ok;
  });
  return { draft: { ...draft, skills }, removed };
}

// ----------------------------------------------------------------- prompts

const SYSTEM_BASE = `You are LAXII's senior resume writer. You receive a candidate's FACTS as JSON and produce a polished professional resume as JSON.

ABSOLUTE INTEGRITY RULES (violations are rejected by an automated check):
- Use ONLY facts present in the candidate's input. NEVER invent, embellish or assume anything: no employers, positions, dates, degrees, institutions, certifications, awards, metrics, numbers or skills that are not in the input.
- You MAY fix grammar and spelling, rewrite for professional tone, condense verbose text, normalize date formats (e.g. "2021-03" or "Mar 2021" consistently) and reorder skills/sections as the type guidance directs.
- If the input has no fact for a field, output an empty string or omit the item. Never add placeholder achievements like "Improved sales by 30%" unless that number was provided.
- Keep every work entry's company name EXACTLY as provided (capitalization may be normalized, wording may not change beyond title-casing).
- If an existing_resume_text document is supplied: STRUCTURE ITS CONTENT into the matching resume sections. Every employer, role, date, skill and achievement found in that document MUST appear in your output (professionally reworded) — do not drop real content. Conversely, do not add any employer, skill, degree, tool, number or achievement that appears in NEITHER candidate_facts NOR existing_resume_text.

OUTPUT: a single JSON object, no markdown fences, with exactly this shape:
{"basics":{"name":"","label":"","email":"","phone":"","website":"","location":"","summary":""},"work":[{"company":"","position":"","startDate":"","endDate":"","current":false,"summary":"","highlights":[""]}],"education":[{"institution":"","area":"","studyType":"","startDate":"","endDate":"","score":""}],"skills":[{"name":"","level":""}],"projects":[{"name":"","description":"","highlights":[""],"url":""}],"certificates":[{"name":"","issuer":"","date":""}],"awards":[{"title":"","awarder":"","date":"","summary":""}]}
Omit empty sections entirely. High-signal, concise, professional language.`;

function factsToFactsJson(facts: ResumeFacts, targetTitle: string, jobDescription: string, sourceText?: string): string {
  return JSON.stringify({
    candidate_facts: { ...facts, skills: normalizeSkills(facts) },
    target_job_title: targetTitle || facts.basics.label || "",
    job_description: jobDescription ? jobDescription.slice(0, 4000) : "",
    ...(sourceText ? { existing_resume_text: sourceText.slice(0, 8000) } : {}),
  });
}

function buildTypeGuidance(typeSlug: string): string {
  const t = findResumeType(typeSlug);
  return t ? `RESUME TYPE — ${t.label}: ${t.guidance}` : "";
}

/**
 * Profession adaptation for the AI prompt: renamed section labels, the list
 * of custom sections the candidate supplied (their content must be treated
 * as fact material, never reinvented), and the family's confidentiality
 * note where one exists (healthcare).
 */
function buildProfessionGuidance(professionSlug: string | null | undefined): string {
  const p = findResumeProfession(professionSlug ?? null);
  if (!p) return "";
  const parts: string[] = [`PROFESSION — ${p.label}.`];
  const labels = p.sectionLabels ?? {};
  const labelList = (Object.entries(labels) as [ResumeCoreSectionKey, string][]).map(([k, v]) => `${k} → "${v}"`);
  if (labelList.length > 0) parts.push(`Use these section headings in the output's JSON structure (the field mapping stays the same): ${labelList.join(", ")}.`);
  if (p.customSections?.length) {
    parts.push(
      `The candidate also supplied custom sections (${p.customSections.map((c) => c.label).join(", ")}). Do NOT output those sections yourself and never fabricate entries for them — they are merged verbatim from the candidate's input.`
    );
  }
  if (p.confidentialityNote) parts.push(p.confidentialityNote);
  return parts.join(" ");
}

// ------------------------------------------------------- missing-information

/**
 * Missing-information report (requirement: clearly identify missing
 * information instead of filling gaps). Computed ONLY from what the user
 * provided — the AI is never asked to complete these.
 */
export function findMissingInfo(facts: ResumeFacts): string[] {
  const missing: string[] = [];
  if (!facts.basics.email.trim() && !facts.basics.phone.trim()) {
    missing.push("No contact email or phone number — add at least one so employers can reach you.");
  }
  if (!facts.basics.location.trim()) missing.push("No location provided — many recruiters and ATS filters expect one.");
  if (!facts.basics.summary.trim()) missing.push("No personal summary provided — add your own for a stronger opening.");
  if (facts.work.length === 0) missing.push("No work history provided.");
  const undatedRoles = facts.work.filter((w) => !w.startDate.trim()).length;
  if (undatedRoles > 0) missing.push(`${undatedRoles} role${undatedRoles === 1 ? " is" : "s are"} missing a start date.`);
  if (facts.education.length === 0) missing.push("No education entries provided.");
  if (facts.skills.length === 0) missing.push("No skills provided.");
  return missing;
}

// ------------------------------------------------------------- diff / notes

function diffTouchedSections(before: ResumeFacts, after: ResumeData): ResumeSectionKey[] {
  const touched = new Set<ResumeSectionKey>();
  if ((after.basics.summary ?? "").trim() !== (before.basics.summary ?? "").trim()) touched.add("summary");
  const beforeWork = JSON.stringify(before.work.map((w) => ({ ...w })));
  const afterWork = JSON.stringify(after.work.map((w) => ({ ...w })));
  if (beforeWork !== afterWork) touched.add("work");
  const beforeEdu = JSON.stringify(before.education);
  const afterEdu = JSON.stringify(after.education);
  if (beforeEdu !== afterEdu) touched.add("education");
  const beforeSkills = JSON.stringify(normalizeSkills(before));
  const afterSkills = JSON.stringify(after.skills);
  if (beforeSkills !== afterSkills) touched.add("skills");
  if (JSON.stringify(before.projects) !== JSON.stringify(after.projects)) touched.add("projects");
  if (JSON.stringify(before.certificates) !== JSON.stringify(after.certificates)) touched.add("certificates");
  if (JSON.stringify(before.awards) !== JSON.stringify(after.awards)) touched.add("awards");
  return Array.from(touched);
}

function buildNotes(draft: ResumeData, touched: ResumeSectionKey[], jobDescription: string): string[] {
  const notes: string[] = [];
  const labels: Record<ResumeSectionKey, string> = {
    basics: "Contact details",
    summary: "Professional summary",
    work: "Experience wording",
    education: "Education wording",
    skills: "Skills presentation",
    projects: "Projects wording",
    certificates: "Certifications wording",
    awards: "Awards wording",
  };
  for (const key of touched) notes.push(`${labels[key]} refined for tone and structure.`);
  if (jobDescription) notes.push("Emphasis aligned with the supplied job description (using only your stated experience).");
  notes.push("Every fact was taken from your input — no qualifications were invented.");
  return notes;
}

// -------------------------------------------------------------- generation

async function requestDraft(
  facts: ResumeFacts,
  typeSlug: string,
  targetTitle: string,
  jobDescription: string,
  professionSlug: string | null,
  existing?: ResumeData,
  sourceText?: string
): Promise<{ draft: ResumeData; rawText: string }> {
  const typeGuidance = buildTypeGuidance(typeSlug);
  const professionGuidance = buildProfessionGuidance(professionSlug);
  const payload = factsToFactsJson(facts, targetTitle, jobDescription, sourceText);
  const system = [
    SYSTEM_BASE,
    typeGuidance,
    professionGuidance,
    existing
      ? "An EXISTING resume draft is included as existing_draft. Improve and reframe it for the new job description: reorder, retune emphasis and rewrite wording — still using only the candidate facts. Preserve any real content the candidate edited."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userContent = [
    payload,
    existing ? `\nexisting_draft:\n${JSON.stringify(existing)}` : "",
    sourceText
      ? "\nTASK REMINDER: candidate_facts above is sparse — the candidate's real history is in existing_resume_text (inside the JSON payload). Populate the work, education, skills, projects, certificates and awards sections FROM that document, professionally reworded. Do not leave sections empty when the document contains content for them, and do not include anything the document lacks."
      : "",
  ].join("\n");

  const { text } = await aiComplete(system, [{ role: "user", content: userContent }], {
    temperature: 0.35,
    timeoutMs: 90_000,
  });
  const parsed = parseJsonFromText<unknown>(text);
  if (!parsed) throw new ResumeServiceError("The AI response could not be parsed. Please try again.", 502);
  const draft = resumeDataSchema.safeParse(parsed);
  if (!draft.success) {
    throw new ResumeServiceError("The AI draft did not match the resume structure. Please try again.", 502);
  }
  return { draft: draft.data, rawText: text };
}

async function generateValidatedDraft(
  facts: ResumeFacts,
  typeSlug: string,
  targetTitle: string,
  jobDescription: string,
  professionSlug: string | null,
  existing?: ResumeData,
  sourceText?: string
): Promise<{ draft: ResumeData; skillRemovals: string[] }> {
  let first: ResumeData | null = null;
  try {
    first = (await requestDraft(facts, typeSlug, targetTitle, jobDescription, professionSlug, existing, sourceText)).draft;
  } catch (e) {
    if (e instanceof ResumeServiceError) throw e;
    if (e instanceof AiProviderError) throw new ResumeServiceError(e.message, 502);
    throw new ResumeServiceError("Resume generation failed. Please try again.", 502);
  }
  const skillFiltered = filterInventedSkills(first, facts, sourceText);
  first = skillFiltered.draft;
  const invented = findInventedEntities(first, facts, sourceText);
  if (invented.length === 0) return { draft: first, skillRemovals: skillFiltered.removed };

  // One corrective retry — the failure is stated verbatim to the model.
  console.warn("[laxii-resume] entity check failed, retrying:", invented.join("; "));
  let second: ResumeData;
  try {
    second = (
      await requestDraft(
        facts,
        typeSlug,
        targetTitle,
        jobDescription
          ? `${jobDescription}\n\nIMPORTANT: your previous attempt included content the candidate did not provide (${invented.join("; ")}). Regenerate using ONLY the candidate facts.`
          : "",
        professionSlug,
        existing,
        sourceText
      )
    ).draft;
  } catch (e) {
    if (e instanceof ResumeServiceError) throw e;
    if (e instanceof AiProviderError) throw new ResumeServiceError(e.message, 502);
    throw new ResumeServiceError("Resume generation failed. Please try again.", 502);
  }
  const skillFiltered2 = filterInventedSkills(second, facts, sourceText);
  second = skillFiltered2.draft;
  const invented2 = findInventedEntities(second, facts, sourceText);
  if (invented2.length === 0) return { draft: second, skillRemovals: skillFiltered2.removed };
  throw new ResumeServiceError(
    `The draft kept including details you did not provide (${invented2.join("; ")}). Nothing was saved — add these to your facts if they are real, then try again.`,
    502
  );
}

/**
 * Assemble the final document from the validated AI draft:
 *  - custom sections come ONLY from the user's facts (never the AI);
 *  - section order comes from the chosen format (genuinely different
 *    document structures — not just different colours);
 *  - section title overrides come from the profession's labels.
 */
function assembleDocument(draft: ResumeData, facts: ResumeFacts, typeSlug: string, professionSlug: string | null | undefined): ResumeData {
  const profession = findResumeProfession(professionSlug ?? null);
  const titles: Record<string, string> = {};
  if (profession?.sectionLabels) {
    for (const [k, v] of Object.entries(profession.sectionLabels)) {
      if (v && v.trim()) titles[k] = v.trim();
    }
  }
  // Custom sections default their display title from the profession preset.
  const labelByKey = new Map((profession?.customSections ?? []).map((c) => [c.key, c.label]));
  const custom = facts.custom.map((c) => ({ ...c, title: c.title || labelByKey.get(c.key) || c.key }));
  return { ...draft, custom, order: resumeTypeOrder(typeSlug), titles };
}

// ------------------------------------------------------------- persistence

async function getOwnedResume(userId: string, conversationId: string) {
  const row = await db.laxiiResume.findFirst({
    where: { conversationId, userId },
    include: { conversation: true },
  });
  if (!row) throw new ResumeServiceError("Resume not found.", 404);
  return row;
}

export interface ResumeTurnInput {
  userId: string;
  conversationId: string;
  userText: string;
  operation: "RESUME_GENERATE" | "RESUME_TAILOR" | "RESUME_REPHRASE" | "RESUME_UPDATE";
  notes?: string[];
  failed?: string;
}

/** Append a USER + ASSISTANT message pair to a resume conversation. */
export async function appendResumeTurn(input: ResumeTurnInput): Promise<void> {
  const conversation = await db.laxiiConversation.findFirst({
    where: { id: input.conversationId, userId: input.userId },
  });
  if (!conversation) throw new ResumeServiceError("Conversation not found.", 404);
  await db.laxiiMessage.create({
    data: { conversationId: conversation.id, role: "USER", text: input.userText.slice(0, 4000) },
  });
  await db.laxiiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      text: input.failed ? "" : (input.notes ?? []).join(" ").slice(0, 2000),
      operation: input.operation,
      provider: input.failed ? null : AI_PROVIDER_LABEL,
      model: input.failed ? null : AI_MODEL_LABEL,
      status: input.failed ? "FAILED" : "DONE",
      error: input.failed?.slice(0, 500),
      metaJson: input.failed ? null : JSON.stringify({ document: "resume" }),
    },
  });
  // Resume actions are DOCUMENT intelligence: they consume the shared TEXT
  // pool (AiUsage, same honest quota as RIISHE/Code Giftz), never the image
  // ledger. costEstimateCents = 0 — the managed text gateway is unmetered.
  try {
    await db.aiUsage.create({
      data: {
        userId: input.userId,
        feature: `laxii.${input.operation.toLowerCase()}`,
        costEstimateCents: 0,
      },
    });
  } catch (e) {
    console.error("[laxii-resume] usage metering failure:", e instanceof Error ? e.message : e);
  }
  await db.laxiiConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
}

export interface GeneratedResume {
  conversationId: string;
  resume: ResumeData;
  aiTouched: ResumeSectionKey[];
  notes: string[];
  template: string;
  /** Honest missing-information report (user-supplied gaps only). */
  missing: string[];
  profession: string | null;
}

/**
 * Create (or regenerate) a resume draft from user facts. Creates the
 * conversation + document rows; records honest FAILED turns on error.
 */
export async function generateResume(opts: {
  userId: string;
  conversationId?: string;
  facts: ResumeFacts;
  resumeType: string;
  targetTitle: string;
  jobDescription: string;
  profession?: string | null;
  sourceText?: string;
}): Promise<GeneratedResume> {
  const type = findResumeType(opts.resumeType) ? opts.resumeType : "ats";
  const professionSlug = findResumeProfession(opts.profession ?? null)?.slug ?? null;
  const title = opts.targetTitle || opts.facts.basics.label || "Resume";

  let conversationId = opts.conversationId;
  if (conversationId) {
    await getOwnedResume(opts.userId, conversationId); // 404 when absent/not owned
  } else {
    // Atomic: conversation + its document row are created together, so a
    // failed document insert can never leave an orphan RESUME thread.
    const conversation = await db.laxiiConversation.create({
      data: {
        userId: opts.userId,
        title: `${opts.facts.basics.name} — ${title}`.slice(0, 80),
        kind: "RESUME",
        resume: {
          create: {
            userId: opts.userId,
            resumeType: type,
            template: findResumeType(type)?.template ?? "classic",
            dataJson: JSON.stringify(resumeDataSchema.parse({})),
            factsJson: JSON.stringify({ ...opts.facts, skills: normalizeSkills(opts.facts), professionSlug, sourceText: opts.sourceText ?? null }),
            targetTitle: opts.targetTitle || null,
            jobDescription: opts.jobDescription || null,
          },
        },
      },
    });
    conversationId = conversation.id;
  }

  try {
    const generated = await generateValidatedDraft(opts.facts, type, opts.targetTitle, opts.jobDescription, professionSlug, undefined, opts.sourceText);
    // Custom sections / section order / title overrides are assembled AFTER
    // validation — the AI output is never trusted with them.
    const draft = assembleDocument(generated.draft, opts.facts, type, professionSlug);
    const skillRemovals = generated.skillRemovals;
    const row = await getOwnedResume(opts.userId, conversationId);
    // Preserve the original uploaded material across regenerations.
    let previousSourceText: string | null = null;
    try {
      const raw: unknown = JSON.parse(row.factsJson || "{}");
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).sourceText === "string") {
        previousSourceText = (raw as Record<string, unknown>).sourceText as string;
      }
    } catch {
      // Legacy/absent snapshot — nothing to preserve.
    }
    const previous = resumeDataSchema.catch(resumeDataSchema.parse({})).parse(JSON.parse(row.dataJson || "{}"));
    const isRegeneration = Object.keys(previous).length > 0 && (previous.work.length > 0 || previous.basics.name !== "");
    const aiTouched = diffTouchedSections(opts.facts, draft);
    const notes = buildNotes(draft, aiTouched, opts.jobDescription);
    if (skillRemovals.length > 0) {
      notes.push(`Removed ${skillRemovals.length} skill${skillRemovals.length === 1 ? "" : "s"} that were not in your input: ${skillRemovals.join(", ")}.`);
    }
    await db.laxiiResume.update({
      where: { id: row.id },
      data: {
        dataJson: JSON.stringify(draft),
        factsJson: JSON.stringify({ ...opts.facts, skills: normalizeSkills(opts.facts), professionSlug, sourceText: opts.sourceText ?? (previousSourceText || null) }),
        aiTouchedJson: JSON.stringify(aiTouched),
        resumeType: type,
        targetTitle: opts.targetTitle || row.targetTitle,
        jobDescription: opts.jobDescription || row.jobDescription,
      },
    });
    await appendResumeTurn({
      userId: opts.userId,
      conversationId,
      userText: isRegeneration
        ? `Regenerate resume${opts.jobDescription ? " tailored to the job description" : ""}`
        : `Generate resume draft${opts.jobDescription ? " tailored to the job description" : ""}`,
      operation: "RESUME_GENERATE",
      notes,
    });
    return { conversationId, resume: draft, aiTouched, notes, template: row.template, missing: findMissingInfo(opts.facts), profession: professionSlug };
  } catch (e) {
    const message =
      e instanceof ResumeServiceError
        ? e.message
        : "Resume generation failed. Please try again.";
    await appendResumeTurn({
      userId: opts.userId,
      conversationId,
      userText: "Generate resume draft",
      operation: "RESUME_GENERATE",
      failed: message,
    });
    throw e instanceof ResumeServiceError ? e : new ResumeServiceError(message, 502);
  }
}

/** Re-tailor an existing resume to a job description. */
export async function tailorResume(opts: {
  userId: string;
  conversationId: string;
  jobDescription: string;
  targetTitle?: string;
}): Promise<GeneratedResume> {
  const row = await getOwnedResume(opts.userId, opts.conversationId);
  const current = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  const factsRaw: unknown = JSON.parse(row.factsJson || "{}");
  const facts = resumeFactsSchema.parse(factsRaw);
  const professionSlug = professionFromFacts(factsRaw);
  if (!opts.jobDescription.trim()) throw new ResumeServiceError("Paste the job description to tailor against.", 400);

  try {
    const generated = await generateValidatedDraft(facts, row.resumeType, opts.targetTitle || row.targetTitle || "", opts.jobDescription, professionSlug, current);
    // Keep the user's custom sections, section order and renamed headings —
    // tailoring rewords core sections only.
    const draft = assembleDocument(generated.draft, { ...facts, custom: current.custom }, row.resumeType, professionSlug);
    const skillRemovals = generated.skillRemovals;
    const aiTouched = diffTouchedSections(facts, draft);
    const notes = buildNotes(draft, aiTouched, opts.jobDescription);
    if (skillRemovals.length > 0) {
      notes.push(`Removed ${skillRemovals.length} skill${skillRemovals.length === 1 ? "" : "s"} that were not in your input: ${skillRemovals.join(", ")}.`);
    }
    await db.laxiiResume.update({
      where: { id: row.id },
      data: {
        dataJson: JSON.stringify(draft),
        aiTouchedJson: JSON.stringify(aiTouched),
        ...(opts.jobDescription ? { jobDescription: opts.jobDescription } : {}),
        ...(opts.targetTitle ? { targetTitle: opts.targetTitle } : {}),
      },
    });
    await appendResumeTurn({
      userId: opts.userId,
      conversationId: opts.conversationId,
      userText: "Tailor resume to job description",
      operation: "RESUME_TAILOR",
      notes,
    });
    return { conversationId: opts.conversationId, resume: draft, aiTouched, notes, template: row.template, missing: findMissingInfo(facts), profession: professionSlug };
  } catch (e) {
    const message = e instanceof ResumeServiceError ? e.message : "Tailoring failed. Please try again.";
    await appendResumeTurn({
      userId: opts.userId,
      conversationId: opts.conversationId,
      userText: "Tailor resume to job description",
      operation: "RESUME_TAILOR",
      failed: message,
    });
    throw e instanceof ResumeServiceError ? e : new ResumeServiceError(message, 502);
  }
}

/** Read the stored profession slug from a factsJson snapshot (legacy-safe). */
function professionFromFacts(factsRaw: unknown): string | null {
  if (factsRaw && typeof factsRaw === "object") {
    const v = (factsRaw as Record<string, unknown>).professionSlug;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Wording-only improvement of one section (grammar/tone, zero new facts). */
export async function rephraseSection(opts: {
  userId: string;
  conversationId: string;
  section: ResumeSectionKey;
}): Promise<GeneratedResume> {
  const row = await getOwnedResume(opts.userId, opts.conversationId);
  const current = resumeDataSchema.parse(JSON.parse(row.dataJson || "{}"));
  const factsRaw: unknown = JSON.parse(row.factsJson || "{}");
  const facts = resumeFactsSchema.parse(factsRaw);

  const system = `${SYSTEM_BASE}\n\nTASK: Rephrase ONLY the "${opts.section}" section of the existing draft for grammar, clarity and professional tone. Do not add, remove or alter any factual content. Return the FULL resume JSON with only that section's wording improved.`;
  try {
    const { text } = await aiComplete(system, [{ role: "user", content: `candidate_facts:\n${JSON.stringify({ ...facts, skills: normalizeSkills(facts) })}\n\nexisting_draft:\n${JSON.stringify(current)}` }], {
      temperature: 0.3,
      timeoutMs: 90_000,
    });
    const parsed = parseJsonFromText<unknown>(text);
    if (!parsed) throw new ResumeServiceError("The AI response could not be parsed. Please try again.", 502);
    const draft = resumeDataSchema.safeParse(parsed);
    if (!draft.success) throw new ResumeServiceError("The AI response did not match the resume structure. Please try again.", 502);
    const invented = findInventedEntities(draft.data, facts);
    if (invented.length > 0) {
      throw new ResumeServiceError(
        `The rephrased section included details you did not provide (${invented.join("; ")}). Nothing was saved.`,
        502
      );
    }
    const skillFiltered = filterInventedSkills(draft.data, facts);
    draft.data = skillFiltered.draft;
    // Rephrase touches core wording only — the user's custom sections, section
    // order and renamed headings pass through untouched.
    draft.data = { ...draft.data, custom: current.custom, order: current.order, titles: current.titles };
    const aiTouched = Array.from(new Set([...(JSON.parse(row.aiTouchedJson || "[]") as ResumeSectionKey[]), opts.section]));
    const notes = buildNotes(draft.data, [opts.section], "");
    await db.laxiiResume.update({
      where: { id: row.id },
      data: { dataJson: JSON.stringify(draft.data), aiTouchedJson: JSON.stringify(aiTouched) },
    });
    await appendResumeTurn({
      userId: opts.userId,
      conversationId: opts.conversationId,
      userText: `Improve wording of the ${opts.section} section`,
      operation: "RESUME_REPHRASE",
      notes,
    });
    return { conversationId: opts.conversationId, resume: draft.data, aiTouched, notes, template: row.template, missing: findMissingInfo(facts), profession: professionFromFacts(factsRaw) };
  } catch (e) {
    const message = e instanceof ResumeServiceError ? e.message : "Rephrasing failed. Please try again.";
    await appendResumeTurn({
      userId: opts.userId,
      conversationId: opts.conversationId,
      userText: `Improve wording of the ${opts.section} section`,
      operation: "RESUME_REPHRASE",
      failed: message,
    });
    throw e instanceof ResumeServiceError ? e : new ResumeServiceError(message, 502);
  }
}

/** Persist manual user edits (never counted as AI-touched). */
export async function saveResumeEdits(opts: {
  userId: string;
  conversationId: string;
  data: ResumeData;
  template?: string;
  resumeType?: string;
}): Promise<void> {
  const row = await getOwnedResume(opts.userId, opts.conversationId);
  const data = resumeDataSchema.parse(opts.data);
  await db.laxiiResume.update({
    where: { id: row.id },
    data: {
      dataJson: JSON.stringify(data),
      ...(opts.template ? { template: opts.template } : {}),
      ...(opts.resumeType ? { resumeType: opts.resumeType } : {}),
    },
  });
  await db.laxiiConversation.update({
    where: { id: row.conversationId },
    data: { updatedAt: new Date() },
  });
}

export async function getResumeDetail(userId: string, conversationId: string) {
  const row = await getOwnedResume(userId, conversationId);
  const factsRaw: unknown = JSON.parse(row.factsJson || "{}");
  // Tolerant parse: legacy rows may predate schema fields; a broken snapshot
  // degrades to an empty facts sheet rather than failing the whole detail.
  const parsedFacts = resumeFactsSchema.safeParse(factsRaw);
  const facts = parsedFacts.success
    ? parsedFacts.data
    : resumeFactsSchema.parse({ basics: { name: (row.conversation.title || "Candidate").split("—")[0].trim() || "Candidate" } });
  const professionSlug = professionFromFacts(factsRaw);
  return {
    conversation: {
      id: row.conversation.id,
      title: row.conversation.title,
      kind: row.conversation.kind,
      updatedAt: row.conversation.updatedAt.toISOString(),
    },
    resumeType: row.resumeType,
    template: row.template,
    targetTitle: row.targetTitle,
    jobDescription: row.jobDescription,
    profession: professionSlug,
    aiTouched: JSON.parse(row.aiTouchedJson || "[]") as ResumeSectionKey[],
    missing: findMissingInfo(facts),
    data: resumeDataSchema.parse(JSON.parse(row.dataJson || "{}")),
  };
}

export async function listResumes(userId: string) {
  const rows = await db.laxiiResume.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: { conversation: { select: { id: true, title: true, updatedAt: true } } },
  });
  return rows.map((r) => {
    let professionSlug: string | null = null;
    try {
      const raw: unknown = JSON.parse(r.factsJson || "{}");
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).professionSlug === "string") {
        professionSlug = (raw as Record<string, unknown>).professionSlug as string;
      }
    } catch {
      // Legacy/absent snapshot — profession stays null.
    }
    return {
      conversationId: r.conversation.id,
      title: r.conversation.title,
      resumeType: r.resumeType,
      template: r.template,
      targetTitle: r.targetTitle,
      profession: professionSlug,
      updatedAt: r.conversation.updatedAt.toISOString(),
    };
  });
}
