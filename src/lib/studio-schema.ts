/**
 * BEAN Folio — Universal Studio profession-aware schema (single source of truth).
 *
 * Pure-data leaf module: imports only the profession taxonomy (itself a pure
 * leaf), so it is safe for client bundles and server code alike. The existing
 * Studio stays ONE workspace — this module only makes its forms, project
 * kinds, field labels and template recommendations adapt to the creator's
 * profession family. Supporting a future profession never requires code
 * changes: add it to the taxonomy (data) and it inherits its family profile.
 *
 * Rules:
 *  - Suggestions, never requirements. Everything here shapes labels,
 *    placeholders and recommendations; the user's real content is always
 *    authoritative and nothing is ever fabricated on their behalf.
 *  - The storage model is the EXISTING Project record. Field overrides
 *    relabel existing columns; profession-specific structured fields and
 *    user-defined custom fields live in the additive `customFields` JSON
 *    envelope — no per-profession pages, tables or schemas.
 *  - A field hidden for a family still renders when it holds data
 *    (backward compatibility: an old project's repoUrl is never lost).
 */

import { PROFESSION_FAMILIES, flattenTaxonomy } from "@/lib/professions/taxonomy";

// ----------------------------------------------------------------- shapes

/** Existing Project columns the Studio form can adapt. */
export type StudioFieldKey =
  | "brief"
  | "process"
  | "challenges"
  | "outcome"
  | "role"
  | "externalUrl"
  | "repoUrl"
  | "tools"
  | "skills";

export interface FieldOverride {
  label?: string;
  placeholder?: string;
  help?: string;
  urlPlaceholder?: string;
}

/** A profession-specific structured field, stored in customFields.fields. */
export interface SuggestedField {
  /** Stable key inside the customFields envelope. */
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

/** The kind of professional work a project records (per family). */
export interface ProjectKind {
  slug: string;
  label: string;
  description: string;
}

export interface FamilyWorkProfile {
  familySlug: string;
  /** Ordered — the family's most representative work first. */
  projectKinds: ProjectKind[];
  fieldOverrides: Partial<Record<StudioFieldKey, FieldOverride>>;
  /** Existing columns hidden for this family while they hold no data. */
  hiddenFields: StudioFieldKey[];
  /** Profession-specific structured fields (stored, rendered on detail). */
  suggestedFields: SuggestedField[];
  /** Suggestions for the skills tag input (never auto-applied). */
  skills: string[];
  /** Suggestions for the tools tag input (never auto-applied). */
  tools: string[];
}

// ------------------------------------------------------- universal kinds

/** Available to every profession (career-development + fallback profile). */
export const UNIVERSAL_PROJECT_KINDS: ProjectKind[] = [
  { slug: "portfolio-piece", label: "Portfolio piece", description: "A representative work sample with its story." },
  { slug: "case-study", label: "Case study", description: "A structured walkthrough — context, approach, result." },
  { slug: "personal-project", label: "Personal project", description: "Self-directed work that shows initiative." },
  { slug: "freelance-work", label: "Freelance work", description: "A client deliverable or commissioned job." },
  { slug: "learning-project", label: "Learning project", description: "Coursework, a bootcamp build or upskilling work." },
  { slug: "internship-work", label: "Internship work", description: "Work produced during an internship or traineeship." },
  { slug: "career-milestone", label: "Career milestone", description: "An achievement, credential or transition worth recording." },
];

// ------------------------------------------------------- family profiles

/**
 * The 13 family work profiles, keyed by the EXACT slugs in taxonomy.ts.
 * Kinds reuse family-playbook vocabulary where it exists so Studio, the
 * public profile and Code Giftz speak the same language about a family's work.
 */
export const FAMILY_WORK_PROFILES: Record<string, FamilyWorkProfile> = {
  // ------------------------------------------------ 1. creative-arts
  "creative-arts": {
    familySlug: "creative-arts",
    projectKinds: [
      { slug: "commissioned-piece", label: "Commissioned piece", description: "Work made for a client or commission." },
      { slug: "personal-collection", label: "Personal collection", description: "A self-initiated series or body of work." },
      { slug: "client-identity", label: "Identity project", description: "Branding, identity or visual language work." },
      { slug: "editorial-series", label: "Editorial series", description: "Work published in or made for an editorial context." },
      { slug: "exhibition-work", label: "Exhibition / show", description: "Work shown in a gallery, fair or exhibition." },
      { slug: "process-case-study", label: "Process case study", description: "The making behind a finished piece." },
    ],
    fieldOverrides: {
      brief: { label: "The brief", placeholder: "Who commissioned it, or what did you set out to explore?" },
      process: { label: "Process & making", placeholder: "Materials, techniques, iterations, studio decisions…" },
      outcome: { label: "Where it lived", placeholder: "Exhibition, publication, client delivery, collection…" },
      role: { label: "Your role", placeholder: "e.g. Art direction, illustration, print production" },
      externalUrl: { label: "See the work", urlPlaceholder: "https://gallery-exhibition.com/…" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "medium", label: "Medium", placeholder: "e.g. Oil on canvas, 3D render, risograph print" },
      { key: "client", label: "Client / commissioner", placeholder: "Only if you can name them publicly" },
      { key: "year", label: "Year", placeholder: "e.g. 2025" },
      { key: "dimensions", label: "Dimensions / scope", placeholder: "e.g. 120 × 90 cm, 24-page zine" },
    ],
    skills: ["Art direction", "Composition", "Color theory", "Typography", "Print production"],
    tools: ["Adobe Photoshop", "Procreate", "Figma", "Blender"],
  },

  // ------------------------------------------------ 2. technology
  technology: {
    familySlug: "technology",
    projectKinds: [
      { slug: "web-app", label: "Web application", description: "A product, site or tool built for the browser." },
      { slug: "mobile-app", label: "Mobile application", description: "An iOS, Android or cross-platform app." },
      { slug: "api-backend", label: "API / backend", description: "Services, infrastructure or data platforms." },
      { slug: "open-source", label: "Open-source project", description: "A library, tool or contribution made in the open." },
      { slug: "ai-ml-project", label: "AI / ML project", description: "Models, agents, pipelines or applied AI work." },
      { slug: "technical-case-study", label: "Technical case study", description: "An engineering problem, decisions and measurable outcome." },
    ],
    fieldOverrides: {
      brief: { label: "Problem & objective", placeholder: "What problem did this solve? Who was it for?" },
      process: { label: "Architecture & approach", placeholder: "Stack, key decisions, trade-offs, data flow…" },
      challenges: { label: "Hard problems", placeholder: "Scaling, correctness, performance — what was genuinely difficult?" },
      outcome: { label: "Results & impact", placeholder: "Adoption, performance numbers, what shipped — only what you can back up." },
      role: { label: "Your role", placeholder: "e.g. Backend lead — API design, data model, deploys" },
      externalUrl: { label: "Live site / demo", urlPlaceholder: "https://your-deployment.app" },
      repoUrl: { label: "Repository", urlPlaceholder: "https://github.com/you/your-repo" },
    },
    hiddenFields: [],
    suggestedFields: [
      { key: "stack", label: "Stack", placeholder: "e.g. TypeScript, Next.js, Postgres, Redis" },
      { key: "my-contribution", label: "Scope of contribution", placeholder: "Which parts were yours on a team effort?" },
      { key: "status", label: "Status", placeholder: "e.g. In production, archived, active OSS" },
      { key: "metrics", label: "Metrics", placeholder: "Users, uptime, throughput — only figures you can verify" },
    ],
    skills: ["System design", "TypeScript", "API design", "Databases", "Testing"],
    tools: ["Git", "Docker", "VS Code", "GitHub Actions"],
  },

  // ------------------------------------------------ 3. journalism-media
  "journalism-media": {
    familySlug: "journalism-media",
    projectKinds: [
      { slug: "news-report", label: "News report", description: "A published news story or broadcast segment." },
      { slug: "investigative-report", label: "Investigative report", description: "Long-form, evidence-driven investigative work." },
      { slug: "interview-feature", label: "Interview / feature", description: "A profile, interview or human-interest feature." },
      { slug: "publication", label: "Publication", description: "A bylined article, column or published piece." },
      { slug: "editorial-project", label: "Editorial project", description: "Editing, commissioning or newsroom production work." },
      { slug: "documentary", label: "Documentary", description: "A documentary film, audio series or photo story." },
    ],
    fieldOverrides: {
      brief: { label: "The story", placeholder: "What was the assignment, angle or investigation?" },
      process: { label: "Reporting & production", placeholder: "Research, interviews, verification, production timeline…" },
      challenges: { label: "Editorial challenges", placeholder: "Access, verification, ethics, deadlines…" },
      outcome: { label: "Publication & reach", placeholder: "Where it ran, dates, response — only what is public." },
      role: { label: "Your byline / role", placeholder: "e.g. Reporter, video journalist, editor" },
      externalUrl: { label: "Read / watch", urlPlaceholder: "https://publication.com/your-story" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "publication", label: "Publication / outlet", placeholder: "Where it was published or broadcast" },
      { key: "published-date", label: "Date published", placeholder: "e.g. 12 March 2025" },
      { key: "format", label: "Format", placeholder: "e.g. Text, video, audio, photo essay" },
      { key: "language", label: "Language", placeholder: "e.g. English, Malayalam" },
    ],
    skills: ["Investigative research", "Interviewing", "Fact-checking", "News writing", "Field production"],
    tools: ["Recorder & field kit", "Adobe Premiere Pro", "Google Pinpoint", "CMS"],
  },

  // ------------------------------------------------ 4. writing-publishing
  "writing-publishing": {
    familySlug: "writing-publishing",
    projectKinds: [
      { slug: "published-article", label: "Published article", description: "An essay, feature or article in print or online." },
      { slug: "book", label: "Book / long-form", description: "A book, novella, thesis or long-form work." },
      { slug: "copy-campaign", label: "Copy campaign", description: "Commercial copy — ads, web, email, brand voice." },
      { slug: "translation", label: "Translation", description: "A translated work or interpreting engagement." },
      { slug: "edited-volume", label: "Edited work", description: "Editing, proofreading or curating others' writing." },
      { slug: "personal-writing", label: "Personal writing", description: "A blog, newsletter or self-published piece." },
    ],
    fieldOverrides: {
      brief: { label: "The brief", placeholder: "What was commissioned, or what did you set out to write?" },
      process: { label: "Research & drafting", placeholder: "Sources, drafts, edits, revisions…" },
      outcome: { label: "Publication", placeholder: "Where it appeared, when, in what form — as recorded in your materials." },
      role: { label: "Your role", placeholder: "e.g. Author, ghostwriter, translator, editor" },
      externalUrl: { label: "Read it", urlPlaceholder: "https://outlet.com/your-piece" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "publisher", label: "Publisher / outlet", placeholder: "As it appears in your materials" },
      { key: "word-count", label: "Length", placeholder: "e.g. 2,400 words, 80,000-word manuscript" },
      { key: "genre", label: "Genre / form", placeholder: "e.g. Literary fiction, B2B copy, memoir" },
      { key: "rights", label: "Rights / availability", placeholder: "e.g. First serial rights available" },
    ],
    skills: ["Long-form writing", "Copywriting", "Editing", "Research", "Story structure"],
    tools: ["Google Docs", "Scrivener", "Grammarly", "Notion"],
  },

  // ------------------------------------------------ 5. film-audio-entertainment
  "film-audio-entertainment": {
    familySlug: "film-audio-entertainment",
    projectKinds: [
      { slug: "video-project", label: "Video project", description: "A finished video work — short, promo or episode." },
      { slug: "showreel", label: "Showreel", description: "A curated reel of your best moments." },
      { slug: "advertisement", label: "Advertisement", description: "A commercial, PSA or branded spot." },
      { slug: "motion-graphics", label: "Motion graphics", description: "Animated titles, Idents, explainer motion." },
      { slug: "color-grading", label: "Color grading", description: "Grade work on a film, ad or series." },
      { slug: "film-project", label: "Film project", description: "A film — feature, short or documentary." },
      { slug: "music-release", label: "Music release", description: "A track, score, album or sound design piece." },
      { slug: "live-performance", label: "Live performance", description: "A concert, set, stage or screen performance." },
    ],
    fieldOverrides: {
      brief: { label: "The production", placeholder: "What was the project — format, length, purpose?" },
      process: { label: "Production & post", placeholder: "Shoot, edit, grade, mix — the pipeline you ran." },
      challenges: { label: "Production challenges", placeholder: "Schedule, locations, technical constraints…" },
      outcome: { label: "Screenings & credits", placeholder: "Festivals, broadcasts, releases — only from your records." },
      role: { label: "Your credit", placeholder: "e.g. Editor, colorist, DOP, composer" },
      externalUrl: { label: "Watch / listen", urlPlaceholder: "https://vimeo.com/your-reel" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "runtime", label: "Runtime", placeholder: "e.g. 4:32, 1h 48m" },
      { key: "format", label: "Format", placeholder: "e.g. 4K ProRes, 24fps, stereo mix" },
      { key: "production", label: "Production / client", placeholder: "As credited in your materials" },
      { key: "year", label: "Year", placeholder: "e.g. 2025" },
    ],
    skills: ["Editing", "Color grading", "Sound design", "Storytelling", "Cinematography"],
    tools: ["DaVinci Resolve", "Adobe Premiere Pro", "After Effects", "Ableton Live"],
  },

  // ------------------------------------------------ 6. business-practice
  "business-practice": {
    familySlug: "business-practice",
    projectKinds: [
      { slug: "venture", label: "Venture / business", description: "A company, product or initiative you built or run." },
      { slug: "product-launch", label: "Product launch", description: "Taking a product or service to market." },
      { slug: "client-engagement", label: "Client engagement", description: "Consulting, advisory or agency work." },
      { slug: "campaign", label: "Campaign", description: "A marketing, growth or brand campaign." },
      { slug: "case-study", label: "Business case study", description: "A problem, strategy and measured result." },
      { slug: "leadership-record", label: "Leadership record", description: "Teams built, P&Ls run, transformations led." },
    ],
    fieldOverrides: {
      brief: { label: "The mandate", placeholder: "What was the business goal or engagement scope?" },
      process: { label: "Strategy & execution", placeholder: "Approach, operating plan, how you executed…" },
      challenges: { label: "Constraints", placeholder: "Market, budget, timing — what made it hard?" },
      outcome: { label: "Results", placeholder: "Growth, revenue, adoption — only figures you can substantiate." },
      role: { label: "Your role", placeholder: "e.g. Founder, engagement lead, growth manager" },
      externalUrl: { label: "Link", urlPlaceholder: "https://your-company.com" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "organization", label: "Organization", placeholder: "Only if publicly attributable" },
      { key: "timeframe", label: "Timeframe", placeholder: "e.g. 2023–2025" },
      { key: "scope", label: "Scope", placeholder: "e.g. Team of 8, ₹1.2Cr budget, 3 markets" },
      { key: "engagement-type", label: "Engagement type", placeholder: "e.g. Retainer, advisory, full-time" },
    ],
    skills: ["Strategy", "Stakeholder management", "Go-to-market", "Financial planning", "Negotiation"],
    tools: ["CRM", "Google Analytics", "Figma", "Excel / Sheets"],
  },

  // ------------------------------------------------ 7. architecture-engineering
  "architecture-engineering": {
    familySlug: "architecture-engineering",
    projectKinds: [
      { slug: "architectural-project", label: "Architectural project", description: "A building design — built or unbuilt." },
      { slug: "building-design", label: "Building design", description: "Concept, schematic or detailed design work." },
      { slug: "floor-plans", label: "Floor plans", description: "Plan sets, layouts and spatial documentation." },
      { slug: "3d-renders", label: "3D renders", description: "Visualization, renders and walkthroughs." },
      { slug: "interior-design", label: "Interior design", description: "Interior architecture and fit-out work." },
      { slug: "project-documentation", label: "Project documentation", description: "Drawings, BOQs, site documentation." },
      { slug: "engineering-design", label: "Engineering design", description: "Structural, civil, MEP or systems design." },
    ],
    fieldOverrides: {
      brief: { label: "The project", placeholder: "Site, programme, client brief, scale…" },
      process: { label: "Design & engineering", placeholder: "Concept → development → drawings → site…" },
      challenges: { label: "Site & technical challenges", placeholder: "Structure, climate, regulation, budget…" },
      outcome: { label: "Status", placeholder: "Concept, approved, under construction, completed — as recorded." },
      role: { label: "Your role", placeholder: "e.g. Design architect, structural lead, BIM coordinator" },
      externalUrl: { label: "Project link", urlPlaceholder: "https://studio.com/projects/…" },
    },
    hiddenFields: [],
    suggestedFields: [
      { key: "location", label: "Location", placeholder: "e.g. Kochi, Kerala" },
      { key: "site-area", label: "Site / built area", placeholder: "e.g. 4,200 sq ft site · 6,800 sq ft built" },
      { key: "typology", label: "Typology", placeholder: "e.g. Residential, institutional, mixed-use" },
      { key: "stage", label: "Stage", placeholder: "e.g. Completed 2024, under construction" },
    ],
    skills: ["Spatial design", "Drafting", "Structural coordination", "Site analysis", "3D visualization"],
    tools: ["AutoCAD", "Revit", "SketchUp", "Rhino", "Lumion"],
  },

  // ------------------------------------------------ 8. education-research
  "education-research": {
    familySlug: "education-research",
    projectKinds: [
      { slug: "teaching-record", label: "Teaching experience", description: "Courses taught, levels, and your approach." },
      { slug: "course", label: "Course / curriculum", description: "A course, module or curriculum you designed." },
      { slug: "educational-resource", label: "Educational resource", description: "Materials, guides or tools for learning." },
      { slug: "research", label: "Research", description: "A study, paper or ongoing research program." },
      { slug: "certification", label: "Certification", description: "A credential, qualification or fellowship." },
      { slug: "academic-achievement", label: "Academic achievement", description: "Awards, distinctions, funded positions." },
      { slug: "lecture-talk", label: "Lecture / talk", description: "A lecture, workshop or invited talk." },
    ],
    fieldOverrides: {
      brief: { label: "Overview", placeholder: "What did you teach, research or build — for whom?" },
      process: { label: "Method / pedagogy", placeholder: "Approach, methods, materials, assessment…" },
      outcome: { label: "Outcomes", placeholder: "Grants, publications, student outcomes — as documented." },
      role: { label: "Your role", placeholder: "e.g. Course designer, lead researcher, teaching assistant" },
      externalUrl: { label: "Link", urlPlaceholder: "https://institution.edu/your-page" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "institution", label: "Institution", placeholder: "As recorded in your materials" },
      { key: "level", label: "Level / grade", placeholder: "e.g. Grade 9–10, undergraduate, postgraduate" },
      { key: "subject", label: "Subject", placeholder: "e.g. Physics, English literature" },
      { key: "year", label: "Year / duration", placeholder: "e.g. 2024 · one semester" },
    ],
    skills: ["Curriculum design", "Instruction", "Assessment", "Academic writing", "Mentoring"],
    tools: ["Google Classroom", "LaTeX", "Moodle", "Jupyter"],
  },

  // ------------------------------------------------ 9. health-wellness
  "health-wellness": {
    familySlug: "health-wellness",
    projectKinds: [
      { slug: "qualification", label: "Qualification", description: "A degree, license or registration." },
      { slug: "clinical-experience", label: "Clinical experience", description: "Rotations, practice settings, caseload scope." },
      { slug: "research-publication", label: "Research publication", description: "A paper, case report or review you authored." },
      { slug: "certification", label: "Certification", description: "A professional certification or CME record." },
      { slug: "achievement", label: "Professional achievement", description: "Awards, fellowships, recognitions." },
      { slug: "healthcare-project", label: "Healthcare project", description: "A program, camp, audit or quality initiative." },
      { slug: "public-education", label: "Public education", description: "Health content or education for the public." },
    ],
    fieldOverrides: {
      brief: { label: "Overview", placeholder: "What is this record — a credential, program or experience?" },
      process: { label: "Scope of practice", placeholder: "Setting, responsibilities, protocols — no patient-identifiable details." },
      outcome: { label: "Outcome", placeholder: "Credential granted, program reach, findings — as documented." },
      role: { label: "Your role", placeholder: "e.g. Attending physician, program lead, volunteer" },
      externalUrl: { label: "Link", urlPlaceholder: "https://journal.com/your-publication" },
    },
    hiddenFields: ["repoUrl", "tools"],
    suggestedFields: [
      { key: "institution", label: "Institution / board", placeholder: "University, hospital or licensing board" },
      { key: "credential-id", label: "Credential", placeholder: "e.g. MBBS, MD, RN — registration number only if public" },
      { key: "year", label: "Year", placeholder: "e.g. 2024" },
      { key: "setting", label: "Setting", placeholder: "e.g. Tertiary care hospital, community clinic" },
    ],
    skills: ["Clinical practice", "Patient education", "Evidence-based medicine", "Case documentation", "Public health"],
    tools: [],
  },

  // ------------------------------------------------ 10. science-environment-agriculture
  "science-environment-agriculture": {
    familySlug: "science-environment-agriculture",
    projectKinds: [
      { slug: "field-study", label: "Field study", description: "Fieldwork — surveys, sampling, observation." },
      { slug: "research-project", label: "Research project", description: "A study, experiment or analysis." },
      { slug: "conservation-program", label: "Conservation program", description: "Protection, restoration or monitoring work." },
      { slug: "dataset", label: "Survey / dataset", description: "A dataset, survey or monitoring series." },
      { slug: "agronomy-trial", label: "Farm / agronomy trial", description: "Cultivation, yield or soil trials." },
      { slug: "publication", label: "Publication", description: "A paper, report or dataset publication." },
    ],
    fieldOverrides: {
      brief: { label: "The question", placeholder: "What were you investigating or restoring?" },
      process: { label: "Methods", placeholder: "Design, sampling, instruments, analysis…" },
      challenges: { label: "Field challenges", placeholder: "Access, weather, permits, data quality…" },
      outcome: { label: "Findings", placeholder: "What the data showed — methods before claims." },
      role: { label: "Your role", placeholder: "e.g. Field lead, analyst, co-investigator" },
      externalUrl: { label: "Link", urlPlaceholder: "https://doi.org/…" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "site", label: "Study site", placeholder: "e.g. Western Ghats, Kerala" },
      { key: "period", label: "Period", placeholder: "e.g. Jan–Jun 2025" },
      { key: "funder", label: "Funder / affiliation", placeholder: "Only if publicly acknowledged" },
      { key: "species-focus", label: "Focus", placeholder: "e.g. Species, crop, pollutant" },
    ],
    skills: ["Field methods", "Data analysis", "GIS", "Scientific writing", "Statistical modeling"],
    tools: ["QGIS", "R", "Python", "Excel"],
  },

  // ------------------------------------------------ 11. public-service-community
  "public-service-community": {
    familySlug: "public-service-community",
    projectKinds: [
      { slug: "community-program", label: "Community program", description: "A program you designed, ran or supported." },
      { slug: "campaign", label: "Campaign", description: "An awareness, advocacy or mobilization campaign." },
      { slug: "policy-analysis", label: "Policy analysis", description: "A policy brief, analysis or recommendation." },
      { slug: "public-talk", label: "Public talk", description: "A talk, panel or community session." },
      { slug: "volunteer-initiative", label: "Volunteer initiative", description: "Organized volunteer or service work." },
      { slug: "partnership-project", label: "Partnership project", description: "Cross-org collaboration or consortium work." },
    ],
    fieldOverrides: {
      brief: { label: "The initiative", placeholder: "What community need did this address?" },
      process: { label: "Approach", placeholder: "How it was organized, delivered, coordinated…" },
      outcome: { label: "Outcomes", placeholder: "Participation, coverage, decisions — without naming beneficiaries." },
      role: { label: "Your role", placeholder: "e.g. Organizer, program officer, volunteer lead" },
      externalUrl: { label: "Link", urlPlaceholder: "https://organisation.org/programme" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "organization", label: "Organization", placeholder: "Only if publicly attributable" },
      { key: "beneficiaries", label: "Reach (aggregate)", placeholder: "e.g. ~300 households — never personal details" },
      { key: "location", label: "Location", placeholder: "e.g. Ernakulam district" },
      { key: "period", label: "Period", placeholder: "e.g. 2024–ongoing" },
    ],
    skills: ["Community organizing", "Program design", "Stakeholder coordination", "Public speaking", "Grant writing"],
    tools: ["Spreadsheets", "Survey tools", "Social media"],
  },

  // ------------------------------------------------ 12. skilled-trades-services
  "skilled-trades-services": {
    familySlug: "skilled-trades-services",
    projectKinds: [
      { slug: "completed-job", label: "Completed job", description: "A finished job with photos and scope." },
      { slug: "custom-build", label: "Custom build", description: "A bespoke build, make or fabrication." },
      { slug: "installation", label: "Installation", description: "Fitted work — electrical, plumbing, fittings." },
      { slug: "menu-program", label: "Menu / seasonal program", description: "A menu, seasonal offer or service program." },
      { slug: "restoration", label: "Restoration", description: "Repair or restoration work." },
      { slug: "commission", label: "Commission", description: "A commissioned piece or service." },
    ],
    fieldOverrides: {
      brief: { label: "The job", placeholder: "What did the client need — scope and site?" },
      process: { label: "How you did it", placeholder: "Materials, method, timeline, crew…" },
      challenges: { label: "Site challenges", placeholder: "Access, old wiring, weather, custom fits…" },
      outcome: { label: "Result", placeholder: "Handover, snags, before/after — as documented." },
      role: { label: "Your role", placeholder: "e.g. Lead electrician, sole trader, head chef" },
      externalUrl: { label: "Link", urlPlaceholder: "https://your-business.com" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "service-area", label: "Service area", placeholder: "e.g. Kochi city + 25 km" },
      { key: "duration", label: "Duration", placeholder: "e.g. 3 days on site" },
      { key: "materials", label: "Materials", placeholder: "e.g. BRIO plywood, Asian Paints, SS 304 fittings" },
      { key: "warranty", label: "Warranty / aftercare", placeholder: "e.g. 1-year workmanship warranty" },
    ],
    skills: ["Craftsmanship", "Site safety", "Client service", "Estimation", "Installation"],
    tools: ["Hand & power tools", "Measuring kit", "Vehicle & logistics"],
  },

  // ------------------------------------------------ 13. career-development
  "career-development": {
    familySlug: "career-development",
    projectKinds: UNIVERSAL_PROJECT_KINDS,
    fieldOverrides: {
      brief: { label: "What this is", placeholder: "A learning project, freelance job or milestone — what is it?" },
      process: { label: "How it went", placeholder: "What you did, what you learned, what's next…" },
      outcome: { label: "Where it stands", placeholder: "Shipped, ongoing, submitted, achieved…" },
      role: { label: "Your role", placeholder: "e.g. Solo build, intern, volunteer" },
      externalUrl: { label: "Link", urlPlaceholder: "https://…" },
    },
    hiddenFields: ["repoUrl"],
    suggestedFields: [
      { key: "context", label: "Context", placeholder: "e.g. Final-year project, first freelance client" },
      { key: "mentors", label: "Guidance / mentors", placeholder: "Only if you can credit them" },
      { key: "next-step", label: "Next step", placeholder: "e.g. Seeking similar work" },
    ],
    skills: ["Self-direction", "Communication", "Time management"],
    tools: [],
  },
};

/** Fallback for users with no (or an unmapped) profession — fully generic. */
export const DEFAULT_WORK_PROFILE: FamilyWorkProfile = {
  familySlug: "*",
  projectKinds: UNIVERSAL_PROJECT_KINDS,
  fieldOverrides: {},
  hiddenFields: [],
  suggestedFields: [],
  skills: [],
  tools: [],
};

// ------------------------------------------------------------- helpers

const FAMILY_BY_PROFESSION = new Map<string, string>();
for (const p of flattenTaxonomy()) FAMILY_BY_PROFESSION.set(p.slug, p.familySlug);

/** The family a profession slug belongs to (null for unknown slugs). */
export function familyForProfession(professionSlug: string): string | null {
  return FAMILY_BY_PROFESSION.get(professionSlug) ?? null;
}

/** The work profile for one family slug — falls back to the generic profile. */
export function workProfileForFamily(familySlug: string | null | undefined): FamilyWorkProfile {
  if (!familySlug) return DEFAULT_WORK_PROFILE;
  return FAMILY_WORK_PROFILES[familySlug] ?? DEFAULT_WORK_PROFILE;
}

/**
 * The merged work profile for a creator's declared professions: the first
 * resolvable profession's family leads (its kinds and field schema win);
 * later families only contribute kinds the earlier ones lack, so a
 * multi-profession user still sees a coherent, ordered studio.
 */
export function workProfileForProfessions(professionSlugs: string[]): FamilyWorkProfile {
  const kinds: ProjectKind[] = [];
  const seenKinds = new Set<string>();
  let fieldProfile: FamilyWorkProfile | null = null;
  const suggestedFields: SuggestedField[] = [];
  const seenFieldKeys = new Set<string>();

  for (const slug of professionSlugs) {
    const familySlug = FAMILY_BY_PROFESSION.get(slug);
    if (!familySlug) continue;
    const profile = FAMILY_WORK_PROFILES[familySlug];
    if (!profile) continue;
    if (!fieldProfile) fieldProfile = profile;
    for (const kind of profile.projectKinds) {
      if (!seenKinds.has(kind.slug)) {
        seenKinds.add(kind.slug);
        kinds.push(kind);
      }
    }
    for (const field of profile.suggestedFields) {
      if (!seenFieldKeys.has(field.key)) {
        seenFieldKeys.add(field.key);
        suggestedFields.push(field);
      }
    }
  }

  // Universal kinds close the list so every user can always classify work.
  for (const kind of UNIVERSAL_PROJECT_KINDS) {
    if (!seenKinds.has(kind.slug)) {
      seenKinds.add(kind.slug);
      kinds.push(kind);
    }
  }

  if (!fieldProfile) return { ...DEFAULT_WORK_PROFILE, projectKinds: kinds };
  return {
    familySlug: fieldProfile.familySlug,
    projectKinds: kinds,
    fieldOverrides: fieldProfile.fieldOverrides,
    hiddenFields: fieldProfile.hiddenFields,
    suggestedFields,
    skills: fieldProfile.skills,
    tools: fieldProfile.tools,
  };
}

/** Label for a kind slug within a profile (kind slug itself when unknown). */
export function kindLabel(profile: FamilyWorkProfile, kindSlug: string | null | undefined): string {
  if (!kindSlug) return "";
  return profile.projectKinds.find((k) => k.slug === kindSlug)?.label ?? kindSlug;
}

/**
 * Field visibility rule: a form field is offered when the family schema says
 * it is relevant OR it already holds data (an old value must stay editable,
 * never silently disappear). This is what keeps the doctor's form free of a
 * GitHub field while preserving a developer project's repo link.
 */
export function fieldIsRelevant(profile: FamilyWorkProfile, key: StudioFieldKey, hasValue: boolean): boolean {
  if (hasValue) return true;
  return !profile.hiddenFields.includes(key);
}

// ------------------------------------------------- customFields envelope

/**
 * The additive JSON envelope stored in Project.customFields. Parsed
 * defensively everywhere — a corrupt or legacy value degrades to null,
 * never to a crash.
 */
export interface StudioCustomFields {
  /** Project kind slug (from the profile's projectKinds). */
  kind?: string;
  /** Template that produced the project (provenance only). */
  templateId?: string;
  /** Profession-specific structured fields (key → value). */
  fields?: Record<string, string>;
  /** User-defined custom fields. */
  custom?: { label: string; value: string }[];
}

const MAX_FIELDS = 12;
const MAX_CUSTOM = 8;

export function parseStudioCustomFields(raw: string | null | undefined): StudioCustomFields | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const out: StudioCustomFields = {};

    if (typeof obj.kind === "string" && obj.kind.trim()) out.kind = obj.kind.trim().slice(0, 60);
    if (typeof obj.templateId === "string" && obj.templateId.trim()) out.templateId = obj.templateId.trim().slice(0, 60);

    if (obj.fields !== null && typeof obj.fields === "object" && !Array.isArray(obj.fields)) {
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
          fields[k.slice(0, 60)] = v.slice(0, 600);
        }
        if (Object.keys(fields).length >= MAX_FIELDS) break;
      }
      if (Object.keys(fields).length > 0) out.fields = fields;
    }

    if (Array.isArray(obj.custom)) {
      const custom: { label: string; value: string }[] = [];
      for (const item of obj.custom) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const label = (item as Record<string, unknown>).label;
          const value = (item as Record<string, unknown>).value;
          if (typeof label === "string" && typeof value === "string" && label.trim() && value.trim()) {
            custom.push({ label: label.trim().slice(0, 60), value: value.trim().slice(0, 600) });
          }
        }
        if (custom.length >= MAX_CUSTOM) break;
      }
      if (custom.length > 0) out.custom = custom;
    }

    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function stringifyStudioCustomFields(input: StudioCustomFields): string | null {
  const cleaned = parseStudioCustomFields(JSON.stringify(input));
  if (!cleaned) return null;
  return JSON.stringify(cleaned);
}

/** Cap constants shared with the API validation layer. */
export const STUDIO_CUSTOM_FIELDS_LIMITS = { MAX_FIELDS, MAX_CUSTOM };
