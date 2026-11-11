/**
 * LAXII Resume Studio — Universal Profession Taxonomy (resume-side).
 *
 * Pure-data leaf module: no imports, safe for client bundles. Distinct from
 * the portfolio-side taxonomy (src/lib/professions/taxonomy.ts), which is
 * frozen by its own compatibility contract — this module serves the RESUME
 * builder only and may evolve freely.
 *
 * Each of the 26 profession families adapts the resume builder:
 *   - `sectionLabels` renames core sections in the form AND in the exported
 *     document (e.g. Experience → "Newsroom Experience" for journalists).
 *   - `customSections` offers profession-specific document sections
 *     (publications, licences, showreels, registration bodies…). Users may
 *     add, remove, reorder and rename every section regardless of profession.
 *   - `skillPlaceholder` adapts the skills input hint.
 *   - `suggestedFormats` steers the format preselect.
 *   - `confidentialityNote` (healthcare etc.) is appended to the AI system
 *     prompt — content rules, never fabricated detail.
 */

export interface ResumeCustomSectionDef {
  /** Stable key — persisted in the document as `custom:<key>` refs. */
  key: string;
  /** Default display title (user-renameable). */
  label: string;
  /** What belongs in this section (shown as the add-chip tooltip/empty hint). */
  blurb: string;
  /** Placeholder for a new entry's title field. */
  entryHint: string;
}

export type ResumeCoreSectionKey = "summary" | "work" | "education" | "skills" | "projects" | "certificates" | "awards";

export interface ResumeProfessionFamily {
  slug: string;
  label: string;
  blurb: string;
  /** Example roles/specialisms (form helper text). */
  roles: string[];
  /** Format slugs suggested for this profession. */
  suggestedFormats: string[];
  skillPlaceholder: string;
  sectionLabels?: Partial<Record<ResumeCoreSectionKey, string>>;
  customSections?: ResumeCustomSectionDef[];
  /** Appended verbatim to the AI system prompt (content rules only). */
  confidentialityNote?: string;
}

const cs = (key: string, label: string, blurb: string, entryHint: string): ResumeCustomSectionDef => ({
  key,
  label,
  blurb,
  entryHint,
});

export const RESUME_PROFESSION_FAMILIES: ResumeProfessionFamily[] = [
  {
    slug: "technology",
    label: "Technology, Software & IT",
    blurb: "Software engineering, IT operations, QA, security, DevOps and support.",
    roles: ["Frontend Engineer", "Backend Engineer", "DevOps Engineer", "QA Analyst", "IT Support Specialist"],
    suggestedFormats: ["technical", "modern", "ats"],
    skillPlaceholder: "TypeScript, React, PostgreSQL, Kubernetes, Terraform",
    sectionLabels: { skills: "Technical Skills", projects: "Projects" },
    customSections: [
      cs("github", "GitHub & Open Source", "Repositories, contributions and open-source involvement.", "Repository or project name"),
      cs("architecture", "Architecture & Systems", "Systems you designed or operated: scale, stack, decisions.", "System or platform"),
      cs("deployment", "Deployment & Tooling", "Pipelines, environments and release practices you have run.", "Pipeline or toolchain"),
    ],
  },
  {
    slug: "ai-data",
    label: "AI, Machine Learning & Data Science",
    blurb: "ML engineering, data science, analytics, research engineering and MLOps.",
    roles: ["ML Engineer", "Data Scientist", "Data Analyst", "MLOps Engineer", "AI Researcher"],
    suggestedFormats: ["technical", "research-cv", "modern"],
    skillPlaceholder: "Python, PyTorch, SQL, TensorFlow, dbt, Airflow",
    sectionLabels: { skills: "Technical Skills", projects: "Models & Analyses" },
    customSections: [
      cs("publications", "Publications", "Papers, preprints, technical blogs and talks (with venues and years).", "Paper or article title"),
      cs("datasets", "Datasets & Benchmarks", "Datasets built or benchmarks you designed/maintained.", "Dataset or benchmark"),
    ],
  },
  {
    slug: "engineering",
    label: "Engineering & Architecture",
    blurb: "Mechanical, civil, electrical, chemical engineering and licensed architects.",
    roles: ["Civil Engineer", "Mechanical Engineer", "Electrical Engineer", "Architect", "Process Engineer"],
    suggestedFormats: ["engineering-cv", "ats", "modern"],
    skillPlaceholder: "AutoCAD, Revit, STAAD.Pro, MATLAB, ISO standards",
    sectionLabels: { skills: "Tools & Standards" },
    customSections: [
      cs("licences", "Licences & Registrations", "PE, RIBA, PMP or equivalent licences with jurisdictions.", "Licence or registration"),
      cs("safety", "Safety & Compliance", "Safety record, audits, codes and compliance work.", "Programme or standard"),
    ],
  },
  {
    slug: "design-creative",
    label: "Design, Creative Arts & Photography",
    blurb: "Graphic, product, UX, illustration, fine art, photography and fashion design.",
    roles: ["UI/UX Designer", "Product Designer", "Photographer", "Illustrator", "Art Director"],
    suggestedFormats: ["portfolio-cv", "creative", "modern"],
    skillPlaceholder: "Figma, Adobe CC, Blender, Procreate, typography",
    sectionLabels: { projects: "Case Studies", work: "Client & Studio Experience" },
    customSections: [
      cs("portfolio", "Visual Portfolio", "Links to portfolio sites, Behance, Dribbble or Instagram.", "Portfolio piece or link"),
      cs("exhibitions", "Exhibitions & Features", "Shows, publications and features of your work.", "Exhibition or feature"),
    ],
  },
  {
    slug: "journalism-media",
    label: "Journalism, Newsreading, Broadcasting & Media",
    blurb: "Reporters, correspondents, newsreaders, presenters, producers and editors.",
    roles: ["Reporter", "News Anchor", "Video Journalist", "Producer", "Sub-editor"],
    suggestedFormats: ["journalism-cv", "modern", "creative"],
    skillPlaceholder: "Investigative research, ENPS, Avid, live broadcasting, Hindi, English",
    sectionLabels: { work: "Newsroom Experience", skills: "Editorial & Language Skills" },
    customSections: [
      cs("clips", "Published Articles & Clips", "Links or titles of standout stories, packages and segments.", "Headline or package title"),
      cs("bylines", "Publications & Bylines", "Outlets you write or broadcast for, with cadence.", "Outlet name"),
      cs("beats", "Reporting Beats", "Areas you cover and off-beat breadth (politics, business, sport…).", "Beat or subject area"),
      cs("investigations", "Investigations", "Major investigations, impact and collaborations.", "Investigation title"),
      cs("broadcast", "Broadcast & Field Reporting", "Live presenting, studio shows and field reporting credits.", "Programme or event"),
      cs("showreel", "Showreel", "Links to your latest showreel or demo tape.", "Showreel link or title"),
      cs("languages", "Languages", "Languages with proficiency for on-air and field work.", "Language"),
    ],
  },
  {
    slug: "writing-publishing",
    label: "Writing, Publishing & Communications",
    blurb: "Authors, copywriters, editors, technical writers and communications specialists.",
    roles: ["Copywriter", "Editor", "Technical Writer", "Communications Officer", "Author"],
    suggestedFormats: ["journalism-cv", "creative", "modern"],
    skillPlaceholder: "SEO writing, AP style, editing, CMS, research",
    sectionLabels: { work: "Writing & Editorial Experience", skills: "Writing Skills" },
    customSections: [
      cs("publications", "Publications", "Books, features, essays and anthologies (with years).", "Title"),
      cs("bylines", "Bylines & Outlets", "Regular outlets, columns and mastheads.", "Outlet or column"),
    ],
  },
  {
    slug: "performing-arts",
    label: "Film, Television, Music & Performing Arts",
    blurb: "Actors, directors, musicians, dancers, technicians and production crews.",
    roles: ["Actor", "Director", "Musician", "Dancer", "Camera Operator"],
    suggestedFormats: ["portfolio-cv", "creative", "minimal"],
    skillPlaceholder: "Stage combat, sight-reading, Pro Tools, lighting design",
    sectionLabels: { work: "Performance & Production Credits", skills: "Performance Skills" },
    customSections: [
      cs("credits", "Credits", "Film, TV, stage and recording credits (role, production, year).", "Production name"),
      cs("showreel", "Showreel & Recordings", "Links to reels, tracks and recordings.", "Reel or track"),
      cs("training", "Training & Coaches", "Drama schools, conservatoires, masterclasses and coaches.", "School or coach"),
    ],
  },
  {
    slug: "business",
    label: "Business, Management & Entrepreneurship",
    blurb: "General management, strategy, operations, founders and C-suite leadership.",
    roles: ["General Manager", "Strategy Lead", "Founder", "Operations Director", "Chief of Staff"],
    suggestedFormats: ["executive", "experienced", "modern"],
    skillPlaceholder: "P&L ownership, OKRs, negotiations, vendor management",
    sectionLabels: { work: "Leadership Experience" },
    customSections: [cs("ventures", "Ventures & Board Roles", "Companies founded, directorships and advisory seats.", "Company or board")],
  },
  {
    slug: "finance",
    label: "Finance, Accounting & Banking",
    blurb: "Accountants, analysts, auditors, bankers, controllers and CFOs.",
    roles: ["Financial Analyst", "Chartered Accountant", "Auditor", "Investment Banker", "Controller"],
    suggestedFormats: ["ats", "experienced", "executive"],
    skillPlaceholder: "IFRS, GAAP, Excel modelling, SAP, risk analysis",
    customSections: [
      cs("licences", "Licences & Memberships", "CPA, CFA, ACCA or equivalent memberships with numbers/years.", "Licence or membership"),
    ],
  },
  {
    slug: "marketing-sales",
    label: "Marketing, Sales & Public Relations",
    blurb: "Brand, growth, performance marketing, account management and PR.",
    roles: ["Marketing Manager", "Sales Executive", "PR Specialist", "Growth Lead", "Account Manager"],
    suggestedFormats: ["modern", "creative", "ats"],
    skillPlaceholder: "SEO/SEM, GA4, HubSpot, copywriting, pipeline management",
    sectionLabels: { work: "Campaign & Account Experience" },
    customSections: [
      cs("campaigns", "Selected Campaigns", "Campaigns with channels, budgets handled and outcomes you can evidence.", "Campaign name"),
    ],
  },
  {
    slug: "hr-recruitment",
    label: "Human Resources & Recruitment",
    blurb: "HR business partners, talent acquisition, L&D and people operations.",
    roles: ["HR Business Partner", "Technical Recruiter", "L&D Specialist", "People Ops Lead"],
    suggestedFormats: ["ats", "modern", "experienced"],
    skillPlaceholder: "Workday, Greenhouse, employment law, comp & benefits",
    customSections: [
      cs("programmes", "People Programmes", "Programmes you built: onboarding, reviews, D&I, L&D.", "Programme name"),
    ],
  },
  {
    slug: "education",
    label: "Education, Teaching & Academia",
    blurb: "Teachers, lecturers, professors, school leaders and instructional designers.",
    roles: ["Secondary Teacher", "Lecturer", "Professor", "Head of Department", "Instructional Designer"],
    suggestedFormats: ["academic-cv", "ats", "modern"],
    skillPlaceholder: "Curriculum design, IB/CBSE, LMS platforms, pedagogy",
    sectionLabels: { work: "Teaching Experience", certificates: "Certifications & Licensure" },
    customSections: [
      cs("teaching", "Courses Taught", "Courses, curricula and levels you have taught.", "Course name"),
    ],
  },
  {
    slug: "research-science",
    label: "Research & Science",
    blurb: "Researchers, lab scientists, postdocs and R&D specialists across disciplines.",
    roles: ["Research Scientist", "Postdoctoral Researcher", "Lab Technician", "R&D Engineer"],
    suggestedFormats: ["research-cv", "academic-cv", "ats"],
    skillPlaceholder: "PCR, chromatography, R, grant writing, statistics",
    sectionLabels: { work: "Research Experience", projects: "Research Projects" },
    customSections: [
      cs("publications", "Publications", "Peer-reviewed papers, preprints and theses (full citations).", "Paper title"),
      cs("grants", "Grants & Funding", "Awards you secured or supported, with amounts and roles.", "Grant or funder"),
      cs("conferences", "Conferences & Talks", "Presentations, posters and panels.", "Conference name"),
      cs("interests", "Research Interests", "Current research interests and questions.", "Area"),
    ],
  },
  {
    slug: "healthcare",
    label: "Healthcare & Wellness",
    blurb: "Doctors, nurses, therapists, technicians, nutritionists and fitness pros.",
    roles: ["Registered Nurse", "Physician", "Physiotherapist", "Lab Technician", "Dietitian"],
    suggestedFormats: ["healthcare-cv", "ats", "minimal"],
    skillPlaceholder: "Phlebotomy, EHR systems, patient assessment, BLS",
    sectionLabels: { work: "Clinical Experience", education: "Qualifications", skills: "Clinical Skills" },
    confidentialityNote:
      "HEALTHCARE CONFIDENTIALITY: never include patient names, identifiers, case details or any health information. Describe scope, settings and responsibilities only.",
    customSections: [
      cs("registration", "Professional Registration", "Council/board registrations and licence numbers where lawful to share.", "Registration body"),
      cs("rotations", "Rotations & Placements", "Clinical rotations, placements and departments served.", "Department or rotation"),
    ],
  },
  {
    slug: "legal",
    label: "Legal & Compliance",
    blurb: "Advocates, solicitors, in-house counsel, paralegals and compliance officers.",
    roles: ["Advocate", "Corporate Counsel", "Compliance Manager", "Paralegal", "Company Secretary"],
    suggestedFormats: ["ats", "experienced", "international-cv"],
    skillPlaceholder: "Due diligence, contract drafting, SEBI/RBI filings, research",
    customSections: [
      cs("bar", "Bar & Admissions", "Bar admissions, courts and jurisdictions.", "Admission"),
      cs("matters", "Selected Matters", "Representative matters you may disclose (anonymised).", "Matter type"),
    ],
  },
  {
    slug: "government-ngo",
    label: "Government, Public Service & NGOs",
    blurb: "Civil servants, policy officers, programme managers and field workers.",
    roles: ["Policy Analyst", "Programme Officer", "Field Coordinator", "Administrative Officer"],
    suggestedFormats: ["ats", "international-cv", "experienced"],
    skillPlaceholder: "Policy analysis, M&E, grant management, community outreach",
    sectionLabels: { work: "Public Service Experience" },
    customSections: [
      cs("programmes", "Programmes & Missions", "Schemes, missions and programmes you delivered.", "Programme name"),
    ],
  },
  {
    slug: "construction-trades",
    label: "Construction & Skilled Trades",
    blurb: "Electricians, plumbers, carpenters, site supervisors and heavy-equipment operators.",
    roles: ["Electrician", "Plumber", "Carpenter", "Site Supervisor", "Welder"],
    suggestedFormats: ["ats", "minimal", "fresher"],
    skillPlaceholder: "Conduit bending, blueprint reading, OSHA, MIG/TIG welding",
    sectionLabels: { skills: "Practical Skills", projects: "Completed Projects" },
    customSections: [
      cs("licences", "Licences & Tickets", "Trade licences, safety cards and equipment tickets.", "Licence or ticket"),
      cs("tools", "Tools & Equipment", "Machines, tools and equipment you are trained on.", "Tool or machine"),
    ],
  },
  {
    slug: "manufacturing",
    label: "Manufacturing & Operations",
    blurb: "Production supervisors, plant managers, supply planners and process leads.",
    roles: ["Production Supervisor", "Plant Manager", "Quality Inspector", "Supply Planner"],
    suggestedFormats: ["ats", "experienced", "minimal"],
    skillPlaceholder: "Lean, Six Sigma, ERP systems, ISO 9001, scheduling",
    customSections: [
      cs("process", "Process Improvements", "Improvements you led with the metric they moved.", "Improvement"),
    ],
  },
  {
    slug: "agriculture-environment",
    label: "Agriculture & Environmental Work",
    blurb: "Farmers, agronomists, conservationists, foresters and sustainability officers.",
    roles: ["Agronomist", "Farm Manager", "Conservation Officer", "Sustainability Lead"],
    suggestedFormats: ["ats", "minimal", "freelance-cv"],
    skillPlaceholder: "Crop planning, soil analysis, GIS, certification audits",
    customSections: [
      cs("land", "Land & Crop Management", "Acreage, crops, livestock or projects you have managed.", "Operation or project"),
    ],
  },
  {
    slug: "hospitality-tourism",
    label: "Hospitality, Food & Tourism",
    blurb: "Chefs, hotel staff, travel guides, event managers and restaurant crews.",
    roles: ["Chef de Partie", "Hotel Manager", "Travel Guide", "Event Coordinator", "Barista"],
    suggestedFormats: ["minimal", "creative", "ats"],
    skillPlaceholder: "HACCP, F&B service, POS systems, menu design, languages",
    sectionLabels: { work: "Industry Experience" },
    customSections: [
      cs("venues", "Venues & Establishments", "Named venues, hotels or routes you have worked.", "Venue"),
    ],
  },
  {
    slug: "logistics-transport",
    label: "Logistics & Transportation",
    blurb: "Drivers, dispatchers, warehouse leads, fleet managers and logistics analysts.",
    roles: ["HGV Driver", "Dispatcher", "Warehouse Lead", "Fleet Manager", "Logistics Analyst"],
    suggestedFormats: ["ats", "minimal", "fresher"],
    skillPlaceholder: "Route planning, WMS, forklift certification, DOT compliance",
    customSections: [
      cs("licences", "Licences & Endorsements", "Driving classes, forklift tickets, hazmat and endorsements.", "Licence"),
    ],
  },
  {
    slug: "real-estate",
    label: "Real Estate & Property",
    blurb: "Agents, brokers, property managers, appraisers and developers.",
    roles: ["Real Estate Agent", "Property Manager", "Appraiser", "Leasing Consultant"],
    suggestedFormats: ["modern", "ats", "freelance-cv"],
    skillPlaceholder: "RERA, CRM pipelines, valuations, negotiation",
    customSections: [
      cs("licences", "Licences & Registrations", "Brokerage licences and registrations with jurisdictions.", "Licence"),
      cs("listings", "Selected Listings & Deals", "Notable listings or portfolio you represented (disclosable only).", "Property or deal"),
    ],
  },
  {
    slug: "sports-fitness",
    label: "Sports & Fitness",
    blurb: "Athletes, coaches, personal trainers, referees and sports therapists.",
    roles: ["Personal Trainer", "Head Coach", "Professional Athlete", "Sports Therapist"],
    suggestedFormats: ["minimal", "creative", "ats"],
    skillPlaceholder: "NASM/ACE, strength programming, physio support, analytics",
    sectionLabels: { work: "Playing & Coaching Experience" },
    customSections: [
      cs("achievements", "Competitive Record", "Placings, titles and representative honours.", "Competition"),
      cs("certifications-body", "Certifications", "Coaching and training certifications with bodies.", "Certification"),
    ],
  },
  {
    slug: "beauty-fashion",
    label: "Beauty, Fashion & Personal Services",
    blurb: "Hairstylists, makeup artists, stylists, models, aestheticians and tailors.",
    roles: ["Hair Stylist", "Makeup Artist", "Fashion Stylist", "Beautician", "Tailor"],
    suggestedFormats: ["portfolio-cv", "creative", "minimal"],
    skillPlaceholder: "Balayage, HD makeup, draping, pattern making, hygiene standards",
    customSections: [
      cs("portfolio", "Portfolio", "Links to shoots, shows and lookbooks.", "Shoot or lookbook"),
      cs("licences", "Licences", "Cosmetology or state board licences.", "Licence"),
    ],
  },
  {
    slug: "students-graduates",
    label: "Students, Graduates & Career Changers",
    blurb: "Entry-level candidates, interns and professionals changing direction.",
    roles: ["Intern", "Graduate Applicant", "Career Changer", "Campus Leader"],
    suggestedFormats: ["fresher", "ats", "modern"],
    skillPlaceholder: "Coursework, tools, languages, societies, volunteering",
    sectionLabels: { projects: "Academic & Personal Projects" },
    customSections: [
      cs("activities", "Extracurricular Activities", "Societies, volunteering, sports and leadership roles.", "Activity"),
    ],
  },
  {
    slug: "freelance-consulting",
    label: "Freelancers & Independent Consultants",
    blurb: "Independent professionals across every discipline and engagements.",
    roles: ["Freelance Designer", "Independent Consultant", "Contract Developer", "Fractional CFO"],
    suggestedFormats: ["freelance-cv", "portfolio-cv", "modern"],
    skillPlaceholder: "Your core services and toolset",
    sectionLabels: { work: "Clients & Engagements" },
    customSections: [
      cs("clients", "Selected Clients", "Client names you may disclose, with engagement scope.", "Client or engagement"),
      cs("testimonials", "Testimonials", "Short quotes from clients (with attribution).", "Quote"),
    ],
  },
];

export function findResumeProfession(slug: string | null | undefined): ResumeProfessionFamily | null {
  if (!slug) return null;
  return RESUME_PROFESSION_FAMILIES.find((p) => p.slug === slug) ?? null;
}

/** Ordered suggestion list for the profession select (grouped client-side). */
export function resumeProfessionOptions(): { slug: string; label: string; blurb: string }[] {
  return RESUME_PROFESSION_FAMILIES.map((p) => ({ slug: p.slug, label: p.label, blurb: p.blurb }));
}
