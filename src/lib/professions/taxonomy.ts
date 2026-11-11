/**
 * BEAN Folio — Universal Profession Taxonomy (single source of truth).
 *
 * A pure-data leaf module: no imports, no server dependencies, safe for both
 * client bundles and server code. The DB (Profession / ProfessionFamily /
 * Specialism) is seeded from here via `syncTaxonomyToDb()` in ./service.ts;
 * run `bun scripts/seed-professions.ts` after editing this file.
 *
 * Structure:
 *   PROFESSION_FAMILIES  — 13 families → professions → specialisms
 *   LEGACY_PROFESSIONS   — the 18 original slugs, frozen 1:1 (slug+label+group+order)
 *
 * Backward-compatibility contract (see docs/PROFESSION_TAXONOMY.md):
 *   - The 18 legacy slugs MUST NEVER be renamed, re-labeled, or regrouped.
 *     They keep their historical flat `group` label; new professions use the
 *     family label as their flat `group`.
 *   - Legacy entries appear inside their family below (legacy first), but
 *     their identity comes from LEGACY_PROFESSIONS.
 */

export interface SpecialismSeed {
  slug: string;
  label: string;
}

export interface ProfessionSeed {
  slug: string;
  label: string;
  /** One-line scope note (planner grounding / directory detail view). */
  description: string;
  /** Alternate display labels — search/matching only, never rendered as canonical. */
  aliases?: string[];
  /** Narrow skills within the profession (2-6 for key professions). */
  specialisms?: SpecialismSeed[];
}

export interface ProfessionFamilySeed {
  slug: string;
  label: string;
  description: string;
  /** Display order of the family (1..13). */
  order: number;
  /** Legacy entries first (historical order), then new professions. */
  professions: ProfessionSeed[];
}

/** Historical seed row shape — exactly what the legacy route used to create. */
export interface LegacyProfessionSeed {
  slug: string;
  label: string;
  group: string;
  order: number;
}

/** Compact builders keep this 200+ entry table readable. */
const p = (
  slug: string,
  label: string,
  description: string,
  extra?: { aliases?: string[]; specialisms?: SpecialismSeed[] }
): ProfessionSeed => ({ slug, label, description, ...extra });
const s = (slug: string, label: string): SpecialismSeed => ({ slug, label });

/**
 * The 18 legacy slugs — FROZEN. Values must match the original seed array in
 * src/app/api/professions/route.ts and CATEGORY_LABELS in src/lib/categories.ts
 * byte-for-byte. Tests pin these; never edit without a migration plan.
 */
export const LEGACY_PROFESSIONS: LegacyProfessionSeed[] = [
  { slug: "film-video", label: "Film & Video", group: "Film & Motion", order: 1 },
  { slug: "motion-design", label: "Motion Design", group: "Film & Motion", order: 2 },
  { slug: "photography", label: "Photography", group: "Visual Arts", order: 3 },
  { slug: "graphic-design", label: "Graphic Design", group: "Design", order: 4 },
  { slug: "ui-ux", label: "UI/UX Design", group: "Design", order: 5 },
  { slug: "product-design", label: "Product Design", group: "Design", order: 6 },
  { slug: "illustration", label: "Illustration", group: "Visual Arts", order: 7 },
  { slug: "art", label: "Fine Art", group: "Visual Arts", order: 8 },
  { slug: "software-dev", label: "Software Development", group: "Technology", order: 9 },
  { slug: "architecture", label: "Architecture", group: "Built Environment", order: 10 },
  { slug: "civil-engineering", label: "Civil Engineering", group: "Built Environment", order: 11 },
  { slug: "writing", label: "Writing & Journalism", group: "Media", order: 12 },
  { slug: "education", label: "Education & Research", group: "Media", order: 13 },
  { slug: "culinary", label: "Culinary & Hospitality", group: "Hospitality", order: 14 },
  { slug: "marketing", label: "Marketing & Business", group: "Business", order: 15 },
  { slug: "music", label: "Music & Audio", group: "Film & Motion", order: 16 },
  { slug: "fashion", label: "Fashion", group: "Design", order: 17 },
  { slug: "other", label: "Other", group: "Multi-discipline", order: 18 },
];

export const PROFESSION_FAMILIES: ProfessionFamilySeed[] = [
  // ------------------------------------------------ 1. creative-arts
  {
    slug: "creative-arts",
    label: "Creative Arts & Design",
    description:
      "Visual and applied arts — brand, interface, illustration, fine art, photography, fashion, and craft.",
    order: 1,
    professions: [
      // legacy (frozen identity — see LEGACY_PROFESSIONS)
      p("motion-design", "Motion Design", "Motion design — animated graphics, titles, and kinetic type.", {
        aliases: ["Motion Graphics"],
      }),
      p("photography", "Photography", "Photography as a discipline — image-making across genres.", {
        aliases: ["Photographer"],
      }),
      p("graphic-design", "Graphic Design", "Graphic design — visual communication across print and screen.", {
        aliases: ["Visual Design"],
      }),
      p("product-design", "Product Design", "Product design — digital and physical product design practice."),
      p("illustration", "Illustration", "Illustration — drawn and painted imagery for briefs and series."),
      p("art", "Fine Art", "Fine art — original works, exhibitions, and commissions.", {
        aliases: ["Fine Art Practice", "Visual Art"],
      }),
      p("fashion", "Fashion", "Fashion — apparel design and style.", { aliases: ["Fashion Design"] }),
      // new
      p("graphic-designer", "Graphic Designer", "Designs visual identities, print and digital layouts, and brand systems for products and organizations."),
      p("brand-designer", "Brand Designer", "Shapes brand identity systems — logos, typography, color, and voice guidelines."),
      p("ui-designer", "UI Designer", "Designs interface layouts, components, and visual systems for apps and websites."),
      p("ux-designer", "UX Designer", "Designs user flows, wireframes, and interaction patterns that make products easy to use."),
      p("product-designer", "Product Designer", "Owns end-to-end product design, from research and flows to polished interfaces."),
      p("illustrator", "Illustrator", "Creates commissioned and personal illustration for editorials, books, brands, and campaigns."),
      p("digital-artist", "Digital Artist", "Produces original artwork with digital tools, from concept pieces to commercial art."),
      p("painter", "Painter", "Makes fine-art paintings in traditional or contemporary media, for galleries and commissions."),
      p("sculptor", "Sculptor", "Creates three-dimensional works in clay, metal, stone, wood, or mixed media."),
      p("photographer", "Photographer", "Shoots portrait, editorial, commercial, or event photography and finishes images for delivery.", {
        specialisms: [
          s("photographer-portrait", "Portrait"),
          s("photographer-editorial", "Editorial"),
          s("photographer-commercial", "Commercial & Advertising"),
          s("photographer-events", "Events & Weddings"),
        ],
      }),
      p("videographer", "Videographer", "Films events, brand stories, and short-form video, often shooting and editing end to end."),
      p("animator", "Animator", "Brings characters and stories to life with 2D or 3D animation for film, games, and brands."),
      p("motion-designer", "Motion Designer", "Designs animated graphics, titles, and transitions for video, broadcast, and UI."),
      p("3d-artist", "3D Artist", "Models, textures, and renders 3D assets for games, film, product visualization, and archviz."),
      p("vfx-artist", "VFX Artist", "Creates visual effects — compositing, simulation, and CGI — for film, TV, and advertising."),
      p("fashion-designer", "Fashion Designer", "Designs clothing and accessory collections, from concept sketches to production."),
      p("interior-designer", "Interior Designer", "Plans interior spaces — layout, materials, lighting, and furnishing — for homes and businesses."),
      p("industrial-designer", "Industrial Designer", "Designs physical products, balancing form, function, ergonomics, and manufacturability."),
      p("stylist", "Stylist", "Curates wardrobe, props, and visual styling for shoots, shows, and productions."),
      p("makeup-artist", "Makeup Artist", "Applies beauty, editorial, and special-effects makeup for shoots, events, and screen."),
      p("hair-artist", "Hair Artist", "Creates hair styling and color work for editorial, bridal, stage, and salon clients."),
      p("craftsperson", "Craftsperson", "Makes handmade goods — ceramics, textiles, woodwork, jewelry — with artisan technique."),
    ],
  },

  // ------------------------------------------------ 2. technology
  {
    slug: "technology",
    label: "Technology & Software",
    description: "Software, data, and infrastructure work — building, shipping, and securing digital products and systems.",
    order: 2,
    professions: [
      // legacy
      p("software-dev", "Software Development", "Software development — building applications and systems.", {
        aliases: ["Full Stack Development", "Software Engineering"],
      }),
      p("ui-ux", "UI/UX Design", "UI/UX design — interfaces and experience for digital products.", {
        aliases: ["UI UX Design", "Interaction Design"],
      }),
      // new
      p("frontend-dev", "Frontend Developer", "Builds user-facing web interfaces with HTML, CSS, and JavaScript frameworks.", {
        aliases: ["Front End Developer", "Frontend Engineer"],
      }),
      p("backend-dev", "Backend Developer", "Builds server-side logic, APIs, and data layers behind applications.", {
        aliases: ["Back End Developer", "Backend Engineer"],
      }),
      p("fullstack-dev", "Full Stack Developer", "Ships features across the whole stack, from database to UI.", {
        aliases: ["Full-Stack Engineer"],
        specialisms: [
          s("fullstack-dev-web-apps", "Web Applications"),
          s("fullstack-dev-apis", "API Development"),
          s("fullstack-dev-indie", "Indie Products"),
        ],
      }),
      p("mobile-dev", "Mobile Developer", "Builds native or cross-platform apps for iOS and Android."),
      p("game-dev", "Game Developer", "Programmes gameplay, engines, and tools for video games."),
      p("software-engineer", "Software Engineer", "Designs and builds reliable software systems, from services to tooling.", {
        specialisms: [
          s("software-engineer-platforms", "Platform Engineering"),
          s("software-engineer-embedded", "Embedded Systems"),
          s("software-engineer-open-source", "Open Source"),
        ],
      }),
      p("ai-engineer", "AI Engineer", "Builds products and pipelines around machine learning and generative AI models.", {
        aliases: ["Artificial Intelligence Engineer"],
      }),
      p("ml-engineer", "ML Engineer", "Trains, evaluates, and deploys machine learning models in production.", {
        aliases: ["Machine Learning Engineer"],
      }),
      p("data-scientist", "Data Scientist", "Turns data into insight with statistics, modeling, and experimentation."),
      p("data-analyst", "Data Analyst", "Analyzes and visualizes data to answer business questions and guide decisions."),
      p("data-engineer", "Data Engineer", "Builds pipelines and warehouses that move and store data reliably."),
      p("cybersecurity", "Cybersecurity Specialist", "Protects systems and data — threat modeling, monitoring, incident response, and hardening.", {
        aliases: ["Security Engineer"],
      }),
      p("devops", "DevOps Engineer", "Automates build, deployment, and operations so teams can ship safely and fast.", {
        aliases: ["DevOps"],
      }),
      p("sre", "Site Reliability Engineer", "Keeps services reliable with SLOs, observability, and incident management.", {
        aliases: ["SRE"],
      }),
      p("cloud-architect", "Cloud Architect", "Designs cloud infrastructure and platform architecture for scale and cost."),
      p("network-engineer", "Network Engineer", "Designs and operates networks — routing, firewalls, and connectivity."),
      p("qa-engineer", "QA Engineer", "Plans and builds test suites and processes that catch defects before release.", {
        aliases: ["Quality Assurance Engineer"],
      }),
      p("automation-tester", "Automation Tester", "Writes automated end-to-end and regression tests for software releases."),
      p("blockchain-dev", "Blockchain Developer", "Builds smart contracts and decentralized applications on blockchain platforms."),
      p("technical-writer", "Technical Writer", "Writes documentation, guides, and API references that make software understandable."),
      p("product-manager", "Product Manager", "Owns product strategy and roadmap, turning user needs into shipped features.", {
        aliases: ["Product Owner"],
      }),
      p("ux-researcher", "UX Researcher", "Studies users through interviews and testing to ground design decisions in evidence.", {
        aliases: ["User Researcher"],
      }),
      p("solutions-architect", "Solutions Architect", "Designs end-to-end technical solutions that connect business needs to systems."),
    ],
  },

  // ------------------------------------------------ 3. journalism-media (mandated, richest)
  {
    slug: "journalism-media",
    label: "Journalism & Media",
    description: "News gathering and delivery across broadcast, print, and digital — reporting, editing, producing, and presenting.",
    order: 3,
    professions: [
      p("news-anchor", "News Anchor", "Presents live television or radio bulletins, anchoring breaking coverage and scripted segments on air.", {
        aliases: ["Newsreader", "Broadcast News Anchor"],
        specialisms: [
          s("news-anchor-evening-bulletin", "Evening Bulletin Anchor"),
          s("news-anchor-breaking-news", "Breaking News Anchor"),
          s("news-anchor-live-events", "Live Events Anchor"),
        ],
      }),
      p("broadcast-journalist", "Broadcast Journalist", "Researches, writes, and edits news stories for television or radio broadcast.", {
        aliases: ["Broadcast Reporter"],
      }),
      p("news-presenter", "News Presenter", "Delivers news programmes on air, linking reports, interviews, and live segments."),
      p("television-presenter", "Television Presenter", "Hosts television programmes, guiding audiences through segments and interviews."),
      p("radio-presenter", "Radio Presenter", "Hosts radio shows, mixing music, talk, and news for a live audience."),
      p("reporter", "Reporter", "Gathers facts, interviews sources, and files news stories on deadline.", {
        aliases: ["News Reporter", "Journalist"],
        specialisms: [
          s("reporter-beat", "Beat Reporter"),
          s("reporter-general-assignment", "General Assignment Reporter"),
          s("reporter-live", "Live Reporting"),
        ],
      }),
      p("field-reporter", "Field Reporter", "Reports on location from breaking news scenes, events, and assignments."),
      p("correspondent", "Correspondent", "Covers a beat or region in depth, filing regular dispatches for news outlets.", {
        aliases: ["Foreign Correspondent"],
      }),
      p("political-journalist", "Political Journalist", "Reports on politics — campaigns, policy, power, and the people behind decisions."),
      p("sports-journalist", "Sports Journalist", "Covers sport — matches, athletes, and the business behind the games."),
      p("business-journalist", "Business Journalist", "Reports on companies, markets, and the economy for general and trade audiences."),
      p("financial-journalist", "Financial Journalist", "Covers finance — markets, banking, and investment — with precision and speed."),
      p("science-journalist", "Science Journalist", "Translates research and discovery into accurate, engaging news coverage."),
      p("technology-journalist", "Technology Journalist", "Reports on technology — products, platforms, policy, and the people building them."),
      p("environment-journalist", "Environment Journalist", "Covers climate, nature, and environmental policy from local to global scale."),
      p("investigative-journalist", "Investigative Journalist", "Pursues long-form, evidence-driven investigations into matters of public interest."),
      p("photojournalist", "Photojournalist", "Tells news stories through photographs shot on assignment for press and editorial use.", {
        aliases: ["Press Photographer", "News Photographer"],
        specialisms: [
          s("photojournalist-news", "News Photography"),
          s("photojournalist-sports", "Sports Photography"),
          s("photojournalist-documentary", "Documentary Photography"),
        ],
      }),
      p("video-journalist", "Video Journalist", "Shoots, edits, and reports video news packages, often single-handedly in the field.", {
        aliases: ["VJ"],
      }),
      p("documentary-journalist", "Documentary Journalist", "Produces long-form documentary journalism on complex subjects."),
      p("news-editor", "News Editor", "Runs the news desk — deciding coverage, editing copy, and steering the daily bulletin."),
      p("copy-editor", "Copy Editor", "Edits copy for accuracy, clarity, style, and house rules before publication."),
      p("sub-editor", "Sub-Editor", "Trims, corrects, and headlines stories to fit layout and deadline."),
      p("assignment-editor", "Assignment Editor", "Assigns crews and reporters to stories, running the daily news budget."),
      p("news-producer", "News Producer", "Produces news programmes — rundown, script, footage, and live coordination."),
      p("executive-producer", "Executive Producer", "Owns editorial and production strategy for news programmes and series."),
      p("newsroom-researcher", "Newsroom Researcher", "Verifies background, archives, and context so stories stand up to scrutiny."),
      p("fact-checker", "Fact-Checker", "Systematically verifies claims and sources before and after publication.", {
        aliases: ["Fact Checker", "Verification Specialist"],
      }),
      p("scriptwriter", "Scriptwriter", "Writes broadcast scripts — bulletins, packages, intros, and interview questions."),
      p("news-analyst", "News Analyst", "Analyzes and interprets news events on air, offering context and expert perspective."),
      p("media-commentator", "Media Commentator", "Provides expert commentary on news and current affairs across programmes."),
      p("podcast-host", "Podcast Host", "Hosts and produces podcast shows, from interview formats to narrative series.", {
        aliases: ["Podcaster", "Podcast Presenter"],
      }),
      p("radio-host", "Radio Host", "Leads radio programmes with talk, interviews, and audience interaction."),
      p("digital-news-creator", "Digital News Creator", "Creates news content for digital platforms — video explainers, newsletters, and social formats.", {
        aliases: ["Digital Journalist"],
      }),
      p("social-media-journalist", "Social Media Journalist", "Reports, verifies, and publishes news natively for social platforms and communities."),
      p("freelance-journalist", "Freelance Journalist", "Files independent reporting on commission for multiple outlets.", {
        aliases: ["Freelance Reporter", "Stringer"],
      }),
    ],
  },

  // ------------------------------------------------ 4. writing-publishing
  {
    slug: "writing-publishing",
    label: "Writing & Publishing",
    description: "The written craft — books, long-form, marketing copy, translation, and the editorial work that shapes it.",
    order: 4,
    professions: [
      // legacy
      p("writing", "Writing & Journalism", "Writing and journalism — the written craft across formats.", {
        aliases: ["Writer", "Journalism"],
      }),
      // new
      p("author", "Author", "Writes books and long-form works, from concept through drafting and publication."),
      p("novelist", "Novelist", "Writes fiction — novels, novellas, and serialized storytelling."),
      p("poet", "Poet", "Writes poetry collections, commissions, and performed verse."),
      p("copywriter", "Copywriter", "Writes persuasive copy for brands — ads, landing pages, campaigns, and slogans.", {
        aliases: ["Advertising Copywriter"],
      }),
      p("content-writer", "Content Writer", "Writes articles, guides, and site content that informs and ranks."),
      p("editor", "Editor", "Edits manuscripts and publications — structure, style, and substance."),
      p("proofreader", "Proofreader", "Catches typos, grammar, and formatting errors before print or publish."),
      p("translator", "Translator", "Translates written work between languages, preserving tone and intent."),
      p("interpreter", "Interpreter", "Interprets spoken language live for meetings, courts, and conferences."),
      p("blogger", "Blogger", "Publishes a blog, building an audience around a subject and voice."),
      p("screenwriter", "Screenwriter", "Writes scripts for film, television, and streaming."),
      p("researcher", "Researcher", "Conducts research and synthesis for publications, studios, and organizations."),
      p("ghostwriter", "Ghostwriter", "Writes books, speeches, and content credited to others."),
    ],
  },

  // ------------------------------------------------ 5. film-audio-entertainment
  {
    slug: "film-audio-entertainment",
    label: "Film, Audio & Entertainment",
    description: "Film, video, music, audio, and live performance — directors, crews, performers, and sound crafts.",
    order: 5,
    professions: [
      // legacy
      p("film-video", "Film & Video", "Film and video production — shoots, edits, and delivers moving-image work.", {
        aliases: ["Filmmaking", "Videography"],
      }),
      p("music", "Music & Audio", "Music and audio — music-making and sound work.", {
        aliases: ["Music Production", "Audio"],
      }),
      // new
      p("film-director", "Film Director", "Directs films — creative vision, performances, and the shot from prep through post."),
      p("cinematographer", "Cinematographer", "Shoots film and TV — camera, lighting, and visual language.", {
        aliases: ["Director of Photography", "DoP"],
      }),
      p("video-editor", "Video Editor", "Assembles footage into finished edits — pacing, structure, and story."),
      p("colorist", "Colorist", "Grades footage — color correction and look creation for film and video."),
      p("sound-designer", "Sound Designer", "Designs sound worlds — effects, atmosphere, and sonic identity for screen."),
      p("audio-engineer", "Audio Engineer", "Records, mixes, and masters audio for music, film, and broadcast."),
      p("music-producer", "Music Producer", "Produces records — arrangement, recording, and the finished sound."),
      p("singer", "Singer", "Performs vocals — recording sessions, live shows, and session work.", {
        aliases: ["Vocalist"],
      }),
      p("musician", "Musician", "Plays instruments live and in the studio, across genres and sessions."),
      p("composer", "Composer", "Writes music — scores for screen, songs, and concert works."),
      p("dj", "DJ", "Performs DJ sets — live mixing, curation, and crowd reading.", {
        aliases: ["Disc Jockey"],
      }),
      p("actor", "Actor", "Performs roles on screen and stage, from audition to final take."),
      p("voice-artist", "Voice Artist", "Performs voiceover for ads, animation, games, and dubbing.", {
        aliases: ["Voice Actor", "Voiceover Artist"],
      }),
      p("dancer", "Dancer", "Performs dance across styles — stage, camera, and commercial work."),
      p("choreographer", "Choreographer", "Creates and teaches choreography for stage, screen, and video."),
      p("theatre-performer", "Theatre Performer", "Performs live theatre — plays, musicals, and devised work."),
      p("casting-professional", "Casting Professional", "Runs casting — sourcing, auditioning, and matching talent to roles."),
    ],
  },

  // ------------------------------------------------ 6. business-practice
  {
    slug: "business-practice",
    label: "Business & Practice",
    description: "Commercial and organizational work — strategy, growth, operations, finance, and people.",
    order: 6,
    professions: [
      // legacy
      p("marketing", "Marketing & Business", "Marketing and business — growth, brand, and commerce.", {
        aliases: ["Marketing", "Business"],
      }),
      // new
      p("entrepreneur", "Entrepreneur", "Builds ventures — products, customers, and teams — from idea to operation."),
      p("founder", "Founder", "Founds and leads companies, owning vision, fundraising, and early execution."),
      p("consultant", "Consultant", "Advises organizations on strategy, operations, and change."),
      p("business-strategist", "Business Strategist", "Develops strategy — positioning, growth plans, and competitive analysis."),
      p("marketer", "Marketer", "Plans and runs marketing — positioning, channels, and campaigns."),
      p("digital-marketer", "Digital Marketer", "Runs digital channels — SEO, paid media, email, and funnels."),
      p("sales-professional", "Sales Professional", "Sells — pipeline, relationships, negotiation, and closed deals."),
      p("recruiter", "Recruiter", "Sources and places candidates, running hiring pipelines end to end."),
      p("hr-professional", "HR Professional", "Runs people operations — hiring, policies, culture, and employee care.", {
        aliases: ["Human Resources Professional"],
      }),
      p("project-manager", "Project Manager", "Delivers projects — scope, schedule, stakeholders, and risk."),
      p("business-analyst", "Business Analyst", "Analyzes processes and requirements, bridging business and technical teams."),
      p("coach", "Coach", "Coaches individuals and teams on performance, leadership, and goals."),
      p("trainer", "Trainer", "Delivers training programs and workshops that build skills."),
      p("accountant", "Accountant", "Keeps books and accounts — reporting, compliance, and tax."),
      p("financial-professional", "Financial Professional", "Advises on money — planning, investments, and financial strategy."),
      p("real-estate-professional", "Real Estate Professional", "Advises on property — sales, leasing, and market guidance."),
      p("legal-professional", "Legal Professional", "Practices law — contracts, counsel, compliance, and representation.", {
        aliases: ["Lawyer", "Attorney"],
        specialisms: [
          s("legal-corporate", "Corporate Law"),
          s("legal-litigation", "Litigation"),
          s("legal-ip", "Intellectual Property"),
          s("legal-family", "Family Law"),
        ],
      }),
      p("event-planner", "Event Planner", "Plans events — venues, vendors, budgets, and on-the-day delivery."),
    ],
  },

  // ------------------------------------------------ 7. architecture-engineering
  {
    slug: "architecture-engineering",
    label: "Architecture & Engineering",
    description: "The built world — architecture, planning, and the engineering disciplines that make it stand.",
    order: 7,
    professions: [
      // legacy
      p("architecture", "Architecture", "Architecture — designing the built environment.", {
        aliases: ["Architectural Design"],
      }),
      p("civil-engineering", "Civil Engineering", "Civil engineering — infrastructure and structural works."),
      // new
      p("architect", "Architect", "Designs buildings — concept to construction documents, balancing beauty, code, and budget.", {
        specialisms: [
          s("architect-residential", "Residential"),
          s("architect-commercial", "Commercial"),
          s("architect-restoration", "Restoration & Heritage"),
          s("architect-sustainable", "Sustainable Design"),
        ],
      }),
      p("landscape-architect", "Landscape Architect", "Designs outdoor spaces — parks, campuses, and landscapes that work with nature."),
      p("urban-planner", "Urban Planner", "Plans cities and districts — land use, zoning, and public space."),
      p("civil-engineer", "Civil Engineer", "Engineers infrastructure — roads, water, structures, and site works."),
      p("mechanical-engineer", "Mechanical Engineer", "Designs mechanical systems and machines, from HVAC to product hardware."),
      p("electrical-engineer", "Electrical Engineer", "Designs electrical systems — power, lighting, and distribution."),
      p("electronics-engineer", "Electronics Engineer", "Designs circuits and electronic hardware, from PCBs to embedded systems."),
      p("chemical-engineer", "Chemical Engineer", "Engineers processes that turn materials into products at scale."),
      p("biomedical-engineer", "Biomedical Engineer", "Engineers medical devices and systems at the intersection of biology and machines."),
      p("structural-engineer", "Structural Engineer", "Ensures structures stand — analysis, loads, and structural design."),
      p("surveyor", "Surveyor", "Measures land and buildings — boundaries, levels, and condition."),
      p("construction-manager", "Construction Manager", "Runs construction sites — schedule, cost, safety, and quality."),
      p("bim-specialist", "BIM Specialist", "Builds and manages BIM models and workflows for the built environment.", {
        aliases: ["Building Information Modeling Specialist"],
      }),
      p("cad-specialist", "CAD Specialist", "Produces precise CAD drawings and documentation for design and construction."),
    ],
  },

  // ------------------------------------------------ 8. education-research
  {
    slug: "education-research",
    label: "Education & Research",
    description: "Teaching, learning, and inquiry — classrooms, academia, and the design of learning itself.",
    order: 8,
    professions: [
      // legacy
      p("education", "Education & Research", "Education and research — teaching and academic work.", {
        aliases: ["Teaching", "Academia"],
      }),
      // new
      p("teacher", "Teacher", "Teaches and inspires students in classrooms, planning lessons and assessment.", {
        aliases: ["Educator", "Schoolteacher"],
        specialisms: [
          s("teacher-primary", "Primary Education"),
          s("teacher-secondary", "Secondary Education"),
          s("teacher-stem", "STEM Education"),
          s("teacher-special-education", "Special Education"),
        ],
      }),
      p("professor", "Professor", "Teaches and researches at university level, publishing and supervising."),
      p("academic", "Academic", "Works in higher education and research — papers, teaching, and peer review."),
      p("phd-scholar", "PhD Scholar", "Pursues doctoral research, contributing original work to a field."),
      p("student", "Student", "Studies formally — coursework, projects, and early portfolio building."),
      p("tutor", "Tutor", "Tutors learners one-to-one or in small groups, closing gaps and building confidence."),
      p("instructional-designer", "Instructional Designer", "Designs courses and learning experiences grounded in how people learn."),
      p("curriculum-developer", "Curriculum Developer", "Builds curricula — standards, sequencing, and assessment design."),
      p("lab-scientist", "Lab Scientist", "Runs laboratory work — experiments, protocols, and analysis."),
      p("education-consultant", "Education Consultant", "Advises schools and organizations on teaching, learning, and education strategy."),
    ],
  },

  // ------------------------------------------------ 9. health-wellness
  {
    slug: "health-wellness",
    label: "Health & Wellness",
    description:
      "Clinical and wellbeing work — diagnosis, care, therapy, and fitness. IMPORTANT: health work is bound by patient confidentiality — never include patient details, records, or identifiable cases in portfolio content.",
    order: 9,
    professions: [
      p("doctor", "Doctor", "Diagnoses and treats patients as a physician — consultations, care plans, and referrals. Bound by patient confidentiality.", {
        aliases: ["Physician", "Medical Doctor"],
        specialisms: [
          s("doctor-general-practice", "General Practice"),
          s("doctor-internal-medicine", "Internal Medicine"),
          s("doctor-pediatrics", "Pediatrics"),
          s("doctor-surgery", "Surgery"),
        ],
      }),
      p("nurse", "Nurse", "Delivers hands-on patient care — monitoring, treatment, and advocacy."),
      p("dentist", "Dentist", "Cares for teeth and oral health — treatment, surgery, and prevention."),
      p("pharmacist", "Pharmacist", "Dispenses medication and advises on safe, effective use."),
      p("physiotherapist", "Physiotherapist", "Restores movement and function through assessment and physical therapy."),
      p("occupational-therapist", "Occupational Therapist", "Helps people regain daily living and working skills after illness or injury."),
      p("dietitian", "Dietitian", "Advises on nutrition and diet for health conditions and performance."),
      p("psychologist", "Psychologist", "Assesses and treats mental health and behavior through psychological practice."),
      p("counselor", "Counselor", "Supports clients through talk-based counseling on life, work, and mental health.", {
        aliases: ["Counsellor", "Therapist"],
      }),
      p("fitness-trainer", "Fitness Trainer", "Coaches clients toward fitness goals with tailored training and programming.", {
        aliases: ["Personal Trainer"],
      }),
      p("wellness-practitioner", "Wellness Practitioner", "Offers wellbeing services — massage, mindfulness, and holistic care."),
    ],
  },

  // ------------------------------------------------ 10. science-environment-agriculture
  {
    slug: "science-environment-agriculture",
    label: "Science, Environment & Agriculture",
    description: "Field and lab science, conservation, sustainability, and agriculture.",
    order: 10,
    professions: [
      p("scientist", "Scientist", "Conducts scientific research — hypotheses, experiments, and publication."),
      p("marine-biologist", "Marine Biologist", "Studies ocean life and ecosystems, from reef surveys to lab analysis."),
      p("geologist", "Geologist", "Studies the Earth — rocks, hazards, resources, and deep time."),
      p("environmental-scientist", "Environmental Scientist", "Assesses environmental conditions and impact — air, water, soil, and ecology."),
      p("sustainability-consultant", "Sustainability Consultant", "Advises organizations on sustainability — footprint, strategy, and reporting."),
      p("conservationist", "Conservationist", "Protects species and habitats through fieldwork, research, and programs."),
      p("agronomist", "Agronomist", "Improves crop production — soil, yield, and sustainable farming practice."),
      p("agricultural-researcher", "Agricultural Researcher", "Researches agriculture — crops, livestock, and farming systems."),
      p("farmer", "Farmer", "Runs a farm — crops or livestock, seasons, markets, and land stewardship."),
      p("ecologist", "Ecologist", "Studies ecosystems and species interactions, informing conservation and planning."),
      p("field-researcher", "Field Researcher", "Collects data in the field — surveys, sampling, and observation."),
    ],
  },

  // ------------------------------------------------ 11. public-service-community
  {
    slug: "public-service-community",
    label: "Public Service & Community",
    description: "Public interest and community work — policy, civic service, NGOs, and social care.",
    order: 11,
    professions: [
      p("ngo-professional", "NGO Professional", "Works in non-governmental organizations — programs, advocacy, and impact."),
      p("community-organizer", "Community Organizer", "Organizes communities — campaigns, coalitions, and local change."),
      p("policy-analyst", "Policy Analyst", "Analyzes public policy — evidence, trade-offs, and recommendations."),
      p("civil-servant", "Civil Servant", "Works in government administration, delivering public programs and services."),
      p("public-speaker", "Public Speaker", "Speaks professionally — keynotes, moderation, and public engagement."),
      p("social-worker", "Social Worker", "Supports people and families through assessment, care planning, and advocacy."),
      p("nonprofit-leader", "Nonprofit Leader", "Leads nonprofits — mission, funding, teams, and governance."),
      p("emergency-services-professional", "Emergency Services Professional", "Responds to emergencies — fire, medical, rescue, and disaster response."),
    ],
  },

  // ------------------------------------------------ 12. skilled-trades-services
  {
    slug: "skilled-trades-services",
    label: "Skilled Trades & Services",
    description: "Hands-on trades and personal services — kitchens, workshops, sites, and studios of craft.",
    order: 12,
    professions: [
      // legacy
      p("culinary", "Culinary & Hospitality", "Culinary and hospitality — kitchens and guest service.", {
        aliases: ["Culinary Arts", "Cooking"],
      }),
      // new
      p("chef", "Chef", "Runs professional kitchens — menus, cooking, and kitchen leadership.", {
        aliases: ["Cook"],
        specialisms: [
          s("chef-head", "Head Chef"),
          s("chef-sous", "Sous Chef"),
          s("chef-pastry", "Pastry & Desserts"),
          s("chef-private", "Private Chef"),
        ],
      }),
      p("baker", "Baker", "Bakes bread and pastry, from dawn ovens to patisserie."),
      p("tailor", "Tailor", "Makes and alters garments with precision cutting and fitting."),
      p("carpenter", "Carpenter", "Builds with wood — framing, joinery, and fine finish."),
      p("electrician", "Electrician", "Installs and maintains electrical systems safely to code."),
      p("plumber", "Plumber", "Installs and repairs water, gas, and heating systems."),
      p("mechanic", "Mechanic", "Diagnoses and repairs vehicles — engines, brakes, and electronics."),
      p("barber", "Barber", "Cuts and styles hair, with shave and grooming craft."),
      p("beautician", "Beautician", "Provides beauty treatments — skin, nails, and care."),
      p("tattoo-artist", "Tattoo Artist", "Designs and applies tattoos with sterile, custom artistry."),
      p("florist", "Florist", "Designs floral arrangements and installations for occasions and spaces."),
      p("artisan", "Artisan", "Makes handmade goods with traditional craft techniques."),
      p("gardener", "Gardener", "Designs and maintains gardens — planting, care, and seasons."),
      p("hospitality-professional", "Hospitality Professional", "Delivers guest experiences in hotels, restaurants, and venues."),
      p("repair-specialist", "Repair Specialist", "Repairs devices, furniture, and equipment, extending what exists."),
    ],
  },

  // ------------------------------------------------ 13. career-development
  {
    slug: "career-development",
    label: "Career Development",
    description: "Where people are on their working journey — students, career changers, freelancers, and hybrids.",
    order: 13,
    professions: [
      // legacy
      p("other", "Other", "Other — practice outside the named categories.", {
        aliases: ["Generalist"],
      }),
      // new — `student` lives in education-research (deduped; not repeated here)
      p("fresher", "Fresher", "Early in a career — first roles, internships, and a growing portfolio.", {
        aliases: ["Graduate", "Entry Level"],
      }),
      p("intern", "Intern", "Learning through internships — real work, mentorship, and credits."),
      p("career-changer", "Career Changer", "Moving into a new field — transferable skills and a fresh portfolio.", {
        aliases: ["Career Switcher"],
      }),
      p("freelancer", "Freelancer", "Works independently across clients — self-managed projects and clients.", {
        aliases: ["Freelance Professional", "Self-Employed"],
      }),
      p("independent-creator", "Independent Creator", "Creates and publishes independently — audience, products, and craft.", {
        aliases: ["Indie Creator"],
      }),
      p("multidisciplinary-professional", "Multidisciplinary Professional", "Works across disciplines, combining several crafts in one practice.", {
        aliases: ["Multi-Disciplinary", "Hybrid Professional"],
      }),
    ],
  },
];

// ---------- Derived helpers (pure, no DB) ----------

/** Flat view of every seeded profession with its family — legacy group/order applied. */
export function flattenTaxonomy(): (ProfessionSeed & {
  familySlug: string;
  familyLabel: string;
  group: string;
  order: number;
})[] {
  const legacyBySlug = new Map(LEGACY_PROFESSIONS.map((l) => [l.slug, l]));
  const out: (ProfessionSeed & {
    familySlug: string;
    familyLabel: string;
    group: string;
    order: number;
  })[] = [];
  for (const family of PROFESSION_FAMILIES) {
    let newOrder = 0;
    for (const seed of family.professions) {
      const legacy = legacyBySlug.get(seed.slug);
      const order = legacy ? legacy.order : 20 + newOrder++;
      out.push({
        ...seed,
        familySlug: family.slug,
        familyLabel: family.label,
        group: legacy?.group ?? family.label,
        order,
      });
    }
  }
  return out;
}
