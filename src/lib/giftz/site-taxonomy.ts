/**
 * BEAN Folio — Universal website-family taxonomy (M33.2).
 *
 * The deterministic registry that maps the website taxonomy in
 * `docs/GIFTZ_UNIVERSAL_CREATIVE_STUDIO_GUIDE.md` §3 to BEAN's REAL capability
 * tiers. This is the honesty contract for the universal planner: every family
 * declares which dynamic capabilities it needs and at what tier — so the
 * planner can route requests to config mode, file mode, or an explicit
 * backend-required architecture request instead of generating dead buttons.
 *
 * Tier definitions (Guide §3, unchanged):
 *  - "static-ready": buildable + publishable as HTML/CSS/JS via config mode
 *    or the sandboxed project-file agent. No private data, no server writes.
 *  - "connected-ready": a real integration exists, credentials are configured
 *    AND test calls pass. NOTHING in this registry claims this tier today —
 *    `tests/giftz-site-planner.test.ts` fails if any feature is labelled
 *    connected-ready while no such integration exists.
 *  - "backend-required": needs the (future, separately reviewed) BEAN
 *    Application Runtime; the planner emits an architecture request, never a
 *    fake form.
 *  - "owner-setup-required": needs owner resources (domain/DNS/TLS,
 *    provider credentials, payment account) before it can go live.
 *  - "unsupported": the product does not implement it and says so plainly.
 *
 * Generated sites remain sandboxed static artifacts with
 * `connect-src 'none'` (src/lib/giftz/preview-serve.ts). No entry in this
 * registry loosens that boundary.
 */

export type FeatureTier =
  | "static-ready"
  | "connected-ready"
  | "backend-required"
  | "owner-setup-required"
  | "unsupported";

export interface FamilyFeature {
  /** Short feature name, e.g. "real booking slots". */
  feature: string;
  tier: FeatureTier;
  /** Honest one-line note; required for non-static tiers. */
  note?: string;
}

export interface WebsiteFamily {
  /** Stable kebab-case id (validated at registry definition time). */
  id: string;
  label: string;
  examples: string[];
  /** Core page slugs (validated `^[a-z0-9-]+$`, no duplicates). */
  corePages: string[];
  /** Lowercase keywords whose presence in a brief signals this family. */
  signals: string[];
  /** Dynamic capabilities users may ask for, with their honest tier. */
  dynamicFeatures: FamilyFeature[];
  /** Family-level honesty note (privacy/legal/owner gates). */
  note?: string;
}

const backendNote = "Requires the BEAN Application Runtime (Guide §5) — planned, not built; the planner returns an architecture request instead of a fake form.";
const ownerNote = "Needs owner-provisioned resources (credentials/account) — never provisioned automatically.";

export const WEBSITE_FAMILIES: WebsiteFamily[] = [
  {
    id: "personal-portfolio",
    label: "Personal & professional portfolio",
    examples: ["portfolio", "CV site", "photography portfolio", "filmmaker showreel", "consultant site"],
    corePages: ["home", "about", "work", "services", "contact"],
    signals: [
      "portfolio", "cv", "resume site", "personal site", "personal brand", "photographer",
      "photography", "filmmaker", "artist site", "designer portfolio", "developer portfolio", "consultant",
      "freelancer", "showreel", "my work", "case studies",
    ],
    dynamicFeatures: [
      { feature: "inquiry storage", tier: "backend-required", note: "Static exports map contact forms to mailto:; storing inquiries needs the M34 runtime." },
      { feature: "resume/profile sync", tier: "backend-required", note: backendNote },
      { feature: "private case studies", tier: "backend-required", note: backendNote },
      { feature: "client portal", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "business-corporate",
    label: "Business & corporate site",
    examples: ["company site", "agency site", "startup site", "studio site"],
    corePages: ["home", "services", "about", "case-studies", "team", "contact", "privacy"],
    signals: [
      "company", "corporate", "agency", "business site", "enterprise", "startup",
      "our services", "b2b", "consulting firm", "studio site", "brand site", "case studies",
    ],
    dynamicFeatures: [
      { feature: "CRM lead capture", tier: "backend-required", note: backendNote },
      { feature: "employee portal", tier: "backend-required", note: backendNote },
      { feature: "authenticated resources", tier: "backend-required", note: backendNote },
      { feature: "internal content management", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "local-services",
    label: "Local services business",
    examples: ["salon", "repair service", "clinic front page", "gym", "plumber"],
    corePages: ["home", "services", "pricing", "about", "contact", "faq"],
    signals: [
      "salon", "barber", "repair", "plumber", "electrician", "cleaning", "clinic",
      "gym", "fitness studio", "tutoring", "local business", "trade", "contractor",
      "lawncare", "auto shop",
    ],
    dynamicFeatures: [
      { feature: "real booking slots", tier: "backend-required", note: backendNote },
      { feature: "reminders", tier: "backend-required", note: backendNote },
      { feature: "payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "live inventory/availability", tier: "backend-required", note: backendNote },
      { feature: "maps embed", tier: "owner-setup-required", note: "Third-party embeds are blocked by the static-site CSP; a link card is the supported pattern." },
    ],
  },
  {
    id: "marketing-campaign",
    label: "Marketing & campaign landing",
    examples: ["landing page", "product launch", "waitlist", "event campaign"],
    corePages: ["home", "faq", "privacy", "terms"],
    signals: [
      "landing page", "launch", "waitlist", "campaign", "coming soon", "product announcement",
      "lead generation", "signup page", "conversion",
    ],
    dynamicFeatures: [
      { feature: "real lead capture", tier: "backend-required", note: backendNote },
      { feature: "email confirmation", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "campaign attribution", tier: "backend-required", note: backendNote },
      { feature: "A/B experimentation", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "saas-product",
    label: "SaaS & software product",
    examples: ["SaaS marketing site", "developer tool site", "API product"],
    corePages: ["home", "features", "pricing", "docs", "security", "changelog", "contact"],
    signals: [
      "saas", "software product", "app landing", "developer tool", "api product",
      "b2b software", "platform site", "pricing tiers", "product site",
    ],
    dynamicFeatures: [
      { feature: "user authentication", tier: "backend-required", note: backendNote },
      { feature: "subscription billing", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "usage metering", tier: "backend-required", note: backendNote },
      { feature: "tenant isolation", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "ecommerce",
    label: "E-commerce store",
    examples: ["product store", "digital products", "brand shop"],
    corePages: ["home", "shop", "product", "policies", "contact", "faq"],
    signals: [
      "store", "shop", "e-commerce", "ecommerce", "products for sale", "cart",
      "checkout", "sell online", "merch", "boutique", "digital downloads",
    ],
    dynamicFeatures: [
      { feature: "real product/stock data", tier: "backend-required", note: backendNote },
      { feature: "cart + checkout", tier: "backend-required", note: "A generated cart UI is demonstrative only; a real checkout needs the M34 runtime plus a payment provider." },
      { feature: "payment provider", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "order history/refunds", tier: "backend-required", note: backendNote },
    ],
    note: "Static storefront pages can be built; anything that takes money is backend-required + owner-setup and must never be presented as working.",
  },
  {
    id: "marketplace-directory",
    label: "Marketplace & directory",
    examples: ["freelancer marketplace", "property directory", "business listing"],
    corePages: ["home", "browse", "listing", "profile", "about", "contact"],
    signals: [
      "marketplace", "directory", "listings", "vendor portal", "classifieds",
      "freelance marketplace", "search and compare", "business directory",
    ],
    dynamicFeatures: [
      { feature: "accounts", tier: "backend-required", note: backendNote },
      { feature: "listing moderation", tier: "backend-required", note: backendNote },
      { feature: "search index", tier: "backend-required", note: backendNote },
      { feature: "messaging", tier: "backend-required", note: backendNote },
      { feature: "escrow/payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
    ],
  },
  {
    id: "booking-appointments",
    label: "Booking & appointments",
    examples: ["appointment booking", "class schedule", "consultation booking", "equipment rental"],
    corePages: ["home", "services", "staff", "locations", "policies", "contact"],
    signals: [
      "booking", "appointments", "schedule a", "book online", "reservations",
      "consultation", "rental", "time slots", "calendar",
    ],
    dynamicFeatures: [
      { feature: "live availability", tier: "backend-required", note: backendNote },
      { feature: "double-book prevention", tier: "backend-required", note: backendNote },
      { feature: "confirmations/reminders", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
    ],
  },
  {
    id: "food-travel-hospitality",
    label: "Food, travel & hospitality",
    examples: ["restaurant", "cafe", "resort", "tour operator", "travel guide"],
    corePages: ["home", "menu", "gallery", "location", "contact", "faq"],
    signals: [
      "restaurant", "cafe", "menu", "bakery", "hotel", "resort", "tour",
      "travel guide", "hostel", "b&b", "guest house", "itinerary",
    ],
    dynamicFeatures: [
      { feature: "reservations", tier: "backend-required", note: backendNote },
      { feature: "live pricing/availability", tier: "backend-required", note: backendNote },
      { feature: "payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "external channel sync", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "events-ticketing",
    label: "Events & ticketing",
    examples: ["conference", "wedding site", "festival", "workshop", "exhibition"],
    corePages: ["home", "schedule", "venue", "speakers", "faq", "contact"],
    signals: [
      "conference", "event", "wedding", "festival", "workshop", "meetup",
      "exhibition", "concert", "schedule", "speakers", "tickets",
    ],
    dynamicFeatures: [
      { feature: "ticket inventory", tier: "backend-required", note: backendNote },
      { feature: "payment", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "QR issuance/validation", tier: "backend-required", note: backendNote },
      { feature: "attendee check-in", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "education-learning",
    label: "Education & learning",
    examples: ["course site", "academy", "school site", "exam prep"],
    corePages: ["home", "programs", "instructors", "faq", "contact"],
    signals: [
      "course", "academy", "school", "training", "tutoring site", "lessons",
      "e-learning", "exam prep", "bootcamp", "curriculum",
    ],
    dynamicFeatures: [
      { feature: "enrollment", tier: "backend-required", note: backendNote },
      { feature: "course progress", tier: "backend-required", note: backendNote },
      { feature: "quizzes/certificates", tier: "backend-required", note: backendNote },
      { feature: "payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
    ],
  },
  {
    id: "membership-community",
    label: "Membership & community",
    examples: ["member site", "club", "paid community", "professional network"],
    corePages: ["home", "benefits", "plans", "rules", "contact"],
    signals: [
      "membership", "community", "club", "members only", "paid community",
      "discord alternative", "association", "society",
    ],
    dynamicFeatures: [
      { feature: "entitlements", tier: "backend-required", note: backendNote },
      { feature: "recurring payments", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "private content", tier: "backend-required", note: backendNote },
      { feature: "moderation", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "publishing-media",
    label: "Publishing & media",
    examples: ["blog", "magazine", "newsletter site", "podcast site", "video channel"],
    corePages: ["home", "articles", "article", "about", "contact"],
    signals: [
      "blog", "magazine", "newspaper", "newsletter", "podcast", "editorial site",
      "articles", "writers site", "column",
    ],
    dynamicFeatures: [
      { feature: "CMS/editorial workflow", tier: "backend-required", note: backendNote },
      { feature: "drafts & scheduled publishing", tier: "backend-required", note: backendNote },
      { feature: "subscriptions", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
    ],
  },
  {
    id: "documentation-support",
    label: "Documentation & support",
    examples: ["API docs", "help centre", "knowledge base", "changelog"],
    corePages: ["home", "guides", "reference", "examples", "contact"],
    signals: [
      "documentation", "docs site", "help center", "help centre", "knowledge base",
      "api reference", "guides", "support site", "changelog",
    ],
    dynamicFeatures: [
      { feature: "versioned docs", tier: "backend-required", note: backendNote },
      { feature: "feedback capture", tier: "backend-required", note: backendNote },
      { feature: "search indexing", tier: "backend-required", note: backendNote },
    ],
    note: "Static multi-page docs are fully supported in file mode (config mode sections target marketing-style pages); search/feedback need the runtime.",
  },
  {
    id: "jobs-talent",
    label: "Jobs & talent",
    examples: ["career site", "job board", "hiring portal"],
    corePages: ["home", "roles", "culture", "contact"],
    signals: [
      "job board", "careers site", "hiring", "recruitment", "vacancies",
      "job listings", "talent portal",
    ],
    dynamicFeatures: [
      { feature: "candidate accounts", tier: "backend-required", note: backendNote },
      { feature: "consent & document upload", tier: "backend-required", note: backendNote },
      { feature: "employer verification", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "property-real-estate",
    label: "Property & real estate",
    examples: ["agency site", "rental listings", "property launch"],
    corePages: ["home", "listings", "property", "agents", "contact"],
    signals: [
      "real estate", "property", "realtor", "rentals", "apartments", "listings for",
      "housing", "estate agency",
    ],
    dynamicFeatures: [
      { feature: "verified availability/pricing", tier: "backend-required", note: backendNote },
      { feature: "inquiry CRM", tier: "backend-required", note: backendNote },
      { feature: "saved searches", tier: "backend-required", note: backendNote },
      { feature: "secure document workflows", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "nonprofit-public",
    label: "Nonprofit & public service",
    examples: ["charity", "NGO", "community campaign", "civic information"],
    corePages: ["home", "mission", "programs", "impact", "contact"],
    signals: [
      "nonprofit", "charity", "ngo", "foundation", "volunteer", "community project",
      "civic", "public information", "advocacy",
    ],
    dynamicFeatures: [
      { feature: "donation gateway", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "volunteer applications", tier: "backend-required", note: backendNote },
      { feature: "transparent receipts", tier: "backend-required", note: backendNote },
    ],
  },
  {
    id: "health-wellbeing",
    label: "Health & wellbeing",
    examples: ["practice information", "wellness service", "health education"],
    corePages: ["home", "services", "team", "faq", "contact"],
    signals: [
      "health", "wellness", "therapy", "clinic", "medical", "dentist", "psychologist",
      "nutrition", "yoga studio", "physio", "practice",
    ],
    dynamicFeatures: [
      { feature: "patient information flows", tier: "unsupported", note: "Any patient data, appointments, payments or clinical records require privacy/security/legal review and a compliant backend — never built by appearance (Guide §3)." },
      { feature: "appointments", tier: "backend-required", note: `${backendNote} Compliance review required first.` },
      { feature: "payments", tier: "backend-required", note: `${backendNote} Compliance review required first.` },
    ],
    note: "Evidence-based education and service information is static-ready; patient-facing flows are unsupported until a compliant backend exists.",
  },
  {
    id: "internal-tools-dashboards",
    label: "Internal tools & dashboards",
    examples: ["admin portal", "reporting tool", "analytics dashboard"],
    corePages: ["home", "overview", "settings", "help"],
    signals: [
      "dashboard", "admin portal", "internal tool", "crm", "reporting",
      "analytics dashboard", "ops tool", "back office",
    ],
    dynamicFeatures: [
      { feature: "auth/RBAC", tier: "backend-required", note: backendNote },
      { feature: "server-side data APIs", tier: "backend-required", note: backendNote },
      { feature: "audit logs", tier: "backend-required", note: backendNote },
    ],
    note: "A generated dashboard shell is a UI proposal only — no data capability exists without the M34 runtime.",
  },
  {
    id: "creative-entertainment",
    label: "Creative & entertainment",
    examples: ["film site", "music artist", "game site", "production house"],
    corePages: ["home", "work", "press-kit", "gallery", "contact"],
    signals: [
      "film", "movie", "music", "band", "game", "entertainment", "production house",
      "showreel site", "press kit", "media kit",
    ],
    dynamicFeatures: [
      { feature: "media streaming", tier: "backend-required", note: backendNote },
      { feature: "ticketing", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
      { feature: "merch/ecommerce", tier: "backend-required", note: `${backendNote} ${ownerNote}` },
    ],
  },
  {
    id: "government-institutional",
    label: "Government & institutional",
    examples: ["public service guide", "institution site", "program information"],
    corePages: ["home", "services", "eligibility", "notices", "contact"],
    signals: [
      "government", "municipality", "public service", "institution", "agency site",
      "civic information", "eligibility",
    ],
    dynamicFeatures: [
      { feature: "identity verification", tier: "backend-required", note: backendNote },
      { feature: "case data submission", tier: "backend-required", note: backendNote },
      { feature: "records management", tier: "backend-required", note: backendNote },
    ],
    note: "High-stakes legal/accessibility review required; static information service is the supported tier.",
  },
];

// ----- registry self-validation (fail loudly, like design-languages.ts) -----

const SLUG_RE = /^[a-z0-9-]+$/;
for (const family of WEBSITE_FAMILIES) {
  if (!SLUG_RE.test(family.id)) {
    throw new Error(`site-taxonomy: family id "${family.id}" is not a kebab-case slug`);
  }
  const seen = new Set<string>();
  for (const page of family.corePages) {
    if (!SLUG_RE.test(page)) {
      throw new Error(`site-taxonomy: family "${family.id}" has a non-slug core page "${page}"`);
    }
    if (seen.has(page)) {
      throw new Error(`site-taxonomy: family "${family.id}" repeats core page "${page}"`);
    }
    seen.add(page);
  }
  for (const feature of family.dynamicFeatures) {
    if (feature.tier !== "static-ready" && !feature.note) {
      throw new Error(
        `site-taxonomy: family "${family.id}" feature "${feature.feature}" has tier "${feature.tier}" without an honest note`,
      );
    }
    if (feature.tier === "connected-ready") {
      throw new Error(
        `site-taxonomy: family "${family.id}" claims tier "connected-ready" for "${feature.feature}" — no external integration for generated sites exists; this registry must never claim connected capabilities`,
      );
    }
  }
}

export const WEBSITE_FAMILY_IDS = WEBSITE_FAMILIES.map((f) => f.id);

export function getWebsiteFamily(id: string | null | undefined): WebsiteFamily | null {
  return WEBSITE_FAMILIES.find((f) => f.id === id) ?? null;
}
