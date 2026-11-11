/**
 * BEAN Folio — demo fixture seeder.
 *
 * Creates CLEARLY-MARKED demo accounts (User.isDemo = true) and fixture
 * content so the product can be explored with realistic data. This is demo
 * data, not production content: it is only created when this script is run
 * explicitly (`bun run scripts/seed.ts`), and `bun run scripts/seed.ts --clear`
 * removes every isDemo account and its content (real accounts are never touched).
 *
 * Passwords are hashed with the same scrypt scheme as src/lib/auth.ts.
 */
import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";
import { copyFileSync, mkdirSync, existsSync, statSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const scrypt = promisify(_scrypt) as (p: string, s: string, k: number) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

const ASSETS = path.join(process.cwd(), "scripts", "seed-assets");
const UPLOADS = path.join(process.cwd(), "uploads");

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

let assetCounter = 0;
async function importImage(ownerId: string, file: string, filename: string) {
  const src = path.join(ASSETS, file);
  if (!existsSync(src)) throw new Error(`Missing seed asset: ${file}`);
  mkdirSync(UPLOADS, { recursive: true });
  assetCounter += 1;
  const name = `seed-${assetCounter}-${file}`; // unique per asset row — rows never share files
  copyFileSync(src, path.join(UPLOADS, name));
  const size = statSync(src).size;
  return db.mediaAsset.create({
    data: { ownerId, kind: "IMAGE", filename, mime: "image/png", size, status: "READY", storagePath: path.join("uploads", name) },
  });
}

type SeedProject = {
  title: string;
  summary: string;
  description: string;
  category: string;
  cover: string;
  role: string;
  brief: string;
  process: string;
  challenges: string;
  outcome: string;
  tools: string[];
  skills: string[];
  externalUrl?: string;
  repoUrl?: string;
  contributors?: { name: string; role: string; contribution?: string }[];
  daysAgo: number;
};

type SeedUser = {
  email: string;
  password: string;
  name: string;
  username: string;
  headline: string;
  bio: string;
  location: string;
  availability: string;
  professions: string[];
  skills: string[];
  avatar: string;
  projects: SeedProject[];
};

const USERS: SeedUser[] = [
  {
    email: "demo@beanfolio.app",
    password: "demo1234",
    name: "Maya Okonkwo",
    username: "maya-edits",
    headline: "Documentary film editor — rhythm, restraint, and honest cuts",
    bio: "Ten years cutting documentaries and brand films. I look for the story under the footage — the pause before the answer, the glance that says everything. Previously at Field & Frame Studio; now independent.",
    location: "London, UK",
    availability: "Open to projects",
    professions: ["film-video", "motion-design"],
    skills: ["adobe-premiere", "davinci-resolve", "color-grading", "editing", "sound-design"],
    avatar: "avatar-maya.png",
    projects: [
      {
        title: "Night Market — Documentary Feature Cut",
        summary: "A 78-minute documentary following three vendors through one season of a city night market — assembled from 140 hours of vérité footage.",
        description:
          "Night Market began as 140 hours of observational footage shot over one season. My job was to find the film inside it: a three-strand structure following a noodle vendor, a flower seller, and a second-generation fishmonger. I built the edit around recurring visual motifs — steam, hands, change exchanged — so the three stories speak to each other without narration.",
        category: "film-video",
        cover: "cover-doc.png",
        role: "Lead editor — structure, assembly, fine cut, sound pass with composer",
        brief:
          "Directors wanted a patient, observational film with no narration and no experts. The brief to me: let the market tell its own story, keep the vendors' own words as the only voice, and land at a feature length that respects their stamina, not just ours.",
        process:
          "Phase 1 — logs and paper edits with the directors over three weeks. Phase 2 — a 4-hour assembly that we screened and ruthlessly cut. Phase 3 — the three-strand interleave, testing orderings scene by scene. Phase 4 — fine cut with the composer, tightening to the score's breath. Eleven full screenings with test audiences shaped the final rhythm.",
        challenges:
          "The biggest challenge was ethical pacing: the fishmonger's story includes a business failure, and we had to earn the right to that moment rather than cut for drama. We held it until the audience had spent enough time with him that the scene plays as dignity, not spectacle.",
        outcome:
          "Official selection at two regional documentary festivals; the film was acquired for broadcast by a regional arts channel. The directors credit the edit's structure in their festival Q&As — the three-strand motif system is now their template for future work.",
        tools: ["Adobe Premiere Pro", "DaVinci Resolve", "Pro Tools", "Frame.io"],
        skills: ["editing", "color-grading", "sound-design", "adobe-premiere", "davinci-resolve"],
        contributors: [
          { name: "Adaeze Nwosu", role: "Director", contribution: "Field direction and interview shoots" },
          { name: "Tom Reilly", role: "Original score", contribution: "Composed and performed the score to picture" },
        ],
        daysAgo: 21,
      },
      {
        title: "Meridian Films — Brand Sizzle Reel",
        summary: "A 90-second brand film for a production company's 10th anniversary — cut from a decade of their archive.",
        description:
          "Meridian Films wanted one piece that could open every pitch: ten years of their work compressed into ninety seconds that still feels like a film, not a montage. I built it on a single continuous sound idea — one heartbeat rhythm that every clip lands on — so radically different projects feel like one voice.",
        category: "film-video",
        cover: "cover-film.png",
        role: "Editor and colorist",
        brief: "Open doors. Play before every pitch meeting. Make ten years feel like one promise.",
        process:
          "I screened 400+ archive clips and built a 'spine' select reel of 40. The cut alternates scale — wide, face, detail — in a three-beat rhythm, color-unified in Resolve so 2015 footage and 2025 footage sit on the same grade. Client reviewed three versions; we tested each one cold on people who knew none of the projects.",
        challenges: "Archive quality ranged from SD to 4K HDR. Upscaling the SD material with Resolve's temporal blur kept texture without mush — the risk was making new footage look worse by comparison, solved by grading down slightly rather than up.",
        outcome: "The reel now opens every Meridian pitch. Two clients cited it in signing, and the company made it their homepage hero — the highest-completion-rate asset they've published.",
        tools: ["Adobe Premiere Pro", "DaVinci Resolve", "After Effects"],
        skills: ["editing", "color-grading", "adobe-premiere", "davinci-resolve"],
        daysAgo: 9,
      },
      {
        title: "Whale Song — Title Sequence (work in progress)",
        summary: "Exploratory title sequence for an independent short — hand-inked textures over deep-water footage.",
        description:
          "An experimental title sequence in progress: ink-in-water plates composited under typography, exploring how hand-made texture can carry a score's tension. Currently in look-development; the structure test is locked, finishing pass pending.",
        category: "motion-design",
        cover: "cover-motion.png",
        role: "Design and edit",
        brief: "Set the mood before the first line of dialogue — in under 40 seconds.",
        process: "Ink plates shot on a lightbox, scanned at 2K, composited in After Effects with the composer's stems. Typography animates on the ink's motion vectors rather than keyframes.",
        challenges: "Keeping the ink readable under type without losing either.",
        outcome: "Structure locked; finishing pass and grade scheduled. Sharing publicly for feedback on the type-in-ink balance.",
        tools: ["After Effects", "Photoshop"],
        skills: ["after-effects", "photoshop", "sound-design"],
        daysAgo: 3,
      },
    ],
  },
  {
    email: "darius@beanfolio.app",
    password: "darius-demo",
    name: "Darius Cole",
    username: "darius-builds",
    headline: "Architect — buildings that belong to their street",
    bio: "Licensed architect focused on public-facing cultural and residential work. I care about proportion, daylight, and the way a building meets the pavement. RIBA Part III, 12 years in practice.",
    location: "Manchester, UK",
    availability: "Open to collaborations",
    professions: ["architecture", "civil-engineering"],
    skills: ["sketchup", "autocad", "revit", "3d-rendering"],
    avatar: "avatar-darius.png",
    projects: [
      {
        title: "Riverside Pavilion — Competition Winner",
        summary: "A timber-and-glass reading pavilion on a flood-sensitive riverbank — winning entry in an open two-stage competition.",
        description:
          "The pavilion sits in a flood plain, so the brief's contradiction — open to the river, safe from the river — drove the design. The reading room floats one storey up on a robust concrete plinth that doubles as flood defense and riverside seating. Timber glulam frames carry a glass roof that makes the room feel like part of the tree canopy.",
        category: "architecture",
        cover: "cover-arch.png",
        role: "Design lead — concept, planning package, competition materials",
        brief: "An open civic room for reading, rest, and small events that the river cannot evict.",
        process:
          "Two-stage open competition. Stage 1: massing studies tested against 1-in-100-year flood levels; the lifted-floor strategy came from modelling the site's winter photographs. Stage 2: developed design with full environmental strategy — the glulam frame is visually calibrated so the glass roof reads as foliage from inside.",
        challenges:
          "The plinth had to be flood defense, furniture, and civic gesture at once. We resolved it by stepping its edge to the exact surveyed flood line — defence where needed, seating where not — so it reads as generosity, not a wall.",
        outcome:
          "First place from 74 entries; the council adopted the scheme for RIBA-stage 4 development. The jury citation singled out the flood-line stepping detail.",
        tools: ["AutoCAD", "Revit", "SketchUp", "Twinmotion"],
        skills: ["sketchup", "autocad", "revit", "3d-rendering"],
        contributors: [
          { name: "Hana Yusuf", role: "Structural engineer", contribution: "Glulam frame and flood plinth structure" },
        ],
        daysAgo: 14,
      },
      {
        title: "Halcyon House — Interior Retrofit",
        summary: "A 1930s semi transformed for a multigenerational family — oak stair, daylight shaft, and one quiet material palette.",
        description:
          "A full interior retrofit of a 1930s semi for three generations under one roof. The organising idea is a single oak stair rising through a double-height daylight shaft — the family's vertical street. Everything else stays quiet: lime plaster, oak, and one warm white so the family's life provides the color.",
        category: "architecture",
        cover: "cover-interior.png",
        role: "Architect — design, detailing, site architect through completion",
        brief: "Give each generation privacy without isolating anyone; make the house feel bigger than its footprint.",
        process:
          "Existing-house survey, then a 'daylight first' planning round: the stair shaft was positioned by studying the sun path for 12 months. Joinery was detailed with a local workshop and dry-fitted before final finishing on site.",
        challenges: "Party-wall constraints limited structural moves; the daylight shaft was threaded through the existing roof structure by mirroring the stair against a lightwell instead of cutting new openings.",
        outcome: "Completed on budget. The family's grandmother moved in for the first winter and uses the stair landing as her reading room — the exact intent of the design.",
        tools: ["Revit", "SketchUp", "AutoCAD"],
        skills: ["sketchup", "revit", "autocad"],
        daysAgo: 6,
      },
    ],
  },
  {
    email: "ines@beanfolio.app",
    password: "ines-demo1",
    name: "Inés Ferreira",
    username: "ines-shoots",
    headline: "Photographer — cities at night, products with patience",
    bio: "Editorial and commercial photographer. Two slow obsessions: how cities behave after midnight, and how an object looks when you give it an hour. Available for commissions worldwide.",
    location: "Lisbon, Portugal",
    availability: "Open to commissions",
    professions: ["photography"],
    skills: ["portrait-photography", "food-photography", "lightroom", "long-exposure", "retouching"],
    avatar: "avatar-ines.png",
    projects: [
      {
        title: "Crossings — Night Street Series",
        summary: "A 24-image black-and-white series on pedestrian crossings at midnight — shot across three cities over two winters.",
        description:
          "Crossings studies the brief moment a city stops: pedestrian crossings at midnight, when the lights blink and whoever is waiting becomes a portrait. Twenty-four final images from three cities, all shot on the same 35mm lens, all between 23:40 and 00:20, so the series keeps one temperature of silence.",
        category: "photography",
        cover: "cover-street.png",
        role: "Photographer — concept through printing",
        brief: "A personal series with one rule: same lens, same hour, no cropping into subjects' faces without consent.",
        process:
          "Scouted crossings by transit maps and night-bus routes. Each location was shot at least three nights before it earned a frame. Film scanned, printed in the darkroom, then drum-scanned for the series' exhibition set — the print is the final edit, not the file.",
        challenges: "Rain is the series' best collaborator and worst enemy: wet asphalt doubles the crosswalk lights, but three shoots were lost to weather. The final set keeps six rain frames deliberately.",
        outcome: "Exhibited at a Lisbon gallery for six weeks; 14 of 24 prints sold. A selection of 8 images was licensed by a city-culture magazine for their print annual.",
        tools: ["Leica M6", "Ilford HP5", "Lightroom"],
        skills: ["long-exposure", "lightroom", "photography", "retouching"],
        daysAgo: 17,
      },
      {
        title: "Matte & Steam — Product Story",
        summary: "A launch campaign for a ceramic pour-over set — twelve hero images built around one hour of light per frame.",
        description:
          "Commercial campaign for a small ceramics studio's pour-over line. The studio's brief was 'patient' — so every frame gets one hour of window light, moved once. Twelve final images: six hero shots, four detail studies, two in-situ kitchen scenes.",
        category: "photography",
        cover: "cover-product.png",
        role: "Photographer and retoucher",
        brief: "Make a small studio's first product launch look like it has a decade of confidence.",
        process:
          "Prop styling session with the founders to choose surfaces (dark stone, raw linen). One-light-hour workflow per frame, with steam captured live between pours. Retouching limited to dust and color consistency — the ceramics' imperfections stay.",
        challenges: "Steam and soft light fight each other; backlit steam blows out. Solved with a black flag two metres behind the pour line so the steam reads against darkness while the ceramic keeps its shadow side.",
        outcome: "The set anchored the launch; the studio sold out its first production run in nine days and reused the crop system for their next two products.",
        tools: ["Phase One", "Lightroom", "Capture One"],
        skills: ["food-photography", "lightroom", "retouching", "photography"],
        daysAgo: 5,
      },
    ],
  },
  {
    email: "kofi@beanfolio.app",
    password: "kofi-demo1",
    name: "Kofi Mensah",
    username: "kofi-codes",
    headline: "Full-stack engineer — real-time systems, calm interfaces",
    bio: "I build data-heavy products that stay fast and legible: real-time dashboards, trading tools, and the unglamorous infrastructure that keeps them honest. TypeScript, React, Node, Postgres.",
    location: "Accra, Ghana",
    availability: "Open to full-time and contract",
    professions: ["software-dev"],
    skills: ["react", "typescript", "nodejs", "python", "data-analysis"],
    avatar: "avatar-kofi.png",
    projects: [
      {
        title: "Ledgerly — Real-time Finance Dashboard",
        summary: "A live financial overview for a 40-person fintech: sub-100ms updates, 30k daily events, zero missed alerts since launch.",
        description:
          "Ledgerly replaces a weekly spreadsheet ritual with a live dashboard: cash position, burn, receivables, and anomaly alerts streamed over websockets. I designed the event pipeline (ingest → normalize → project), the websocket fan-out, and the entire React front end with a deliberate 'calm mode' for non-finance staff.",
        category: "software-dev",
        cover: "cover-dashboard.png",
        role: "Lead engineer — architecture, backend, and front end",
        brief: "Every number the leadership team trusts must be less than two minutes old, and the dashboard must never make anyone panic-read a wrong total.",
        process:
          "Week 1–2: event modeling with the finance team — we mapped their spreadsheet formulas first and translated them into projections. Week 3–6: ingest pipeline and snapshot store. Week 7–9: React front end with optimistic states and a documented 'staleness badge' so users always know data age.",
        challenges:
          "The hardest problem was correctness under late-arriving events: a payment recorded at 4pm for the morning must recompute the day without double-counting. Solved with idempotent event IDs and a replay-safe projection layer.",
        outcome:
          "Adopted company-wide in week one. Finance close time dropped from 3 days to 4 hours; zero missed anomaly alerts in the first two quarters. Open-sourced the replay-safe projection layer under the company's GitHub.",
        tools: ["TypeScript", "React", "Node.js", "PostgreSQL", "Redis"],
        skills: ["typescript", "react", "nodejs", "data-analysis"],
        externalUrl: "https://ledgerly.example.com",
        repoUrl: "https://github.com/kofi-mensah/ledgerly-projections",
        contributors: [{ name: "Ama Boateng", role: "Product designer", contribution: "Dashboard layout and alert UX" }],
        daysAgo: 11,
      },
    ],
  },
  {
    email: "lena@beanfolio.app",
    password: "lena-demo1",
    name: "Lena Park",
    username: "lena-cooks",
    headline: "Chef — coastal tasting menus, zero-waste kitchens",
    bio: "Chef de cuisine turned consultant. My menus start at the harbour and end at the compost bin — nothing good gets wasted. Formerly head of development at an award-winning coastal restaurant.",
    location: "Busan, South Korea",
    availability: "Open to consulting",
    professions: ["culinary"],
    skills: ["menu-development", "food-photography", "pastry"],
    avatar: "avatar-lena.png",
    projects: [
      {
        title: "Coastal Autumn — Tasting Menu Development",
        summary: "A nine-course coastal tasting menu built on bycatch and root-to-leaf cooking — 71% food-cost-to-waste reduction across the season.",
        description:
          "A season-long project developing a nine-course tasting menu around what the fleet actually lands — including bycatch most kitchens refuse. Every course documents its waste stream: shrimp shells become the glaze for course six, course-nine's pastry trim becomes the tea served with the bill.",
        category: "culinary",
        cover: "cover-dish.png",
        role: "Menu development lead — R&D, supplier relationships, staff training",
        brief: "A menu that could only exist this season, this coast — and a kitchen that throws away almost nothing.",
        process:
          "Six weeks of supplier work with two day-boats to understand real catches before writing a single dish. Then a 14-plate R&D sprint — every candidate dish costed for both ingredients and waste. Final menu trained through three full staff tastings with documented prep timelines.",
        challenges: "Bycatch is unpredictable by nature. The menu needed a substitution lattice — every course has a documented 'plan B' plate, so service never 86s a course because the boat came in light.",
        outcome: "Ran for one season at 92% seat occupancy; kitchen waste down 71% by weight against the previous menu. Two dishes were written up in national food press; the substitution lattice is now taught to the brigade of the restaurant that commissioned it.",
        tools: ["Menu engineering workbook", "Canon R5 (documentation)"],
        skills: ["menu-development", "food-photography"],
        contributors: [{ name: "Jun-ho Seok", role: "Sous chef", contribution: "Fermentation program and service training" }],
        daysAgo: 8,
      },
    ],
  },
  {
    email: "theo@beanfolio.app",
    password: "theo-demo1",
    name: "Theo Marchetti",
    username: "theo-draws",
    headline: "Illustrator — picture books, ink and watercolor",
    bio: "I draw stories that breathe: picture books, editorial spots, and the occasional mural. Ink first, watercolor after, always drawn by hand.",
    location: "Bologna, Italy",
    availability: "Open to book projects",
    professions: ["illustration", "art"],
    skills: ["watercolor", "digital-illustration", "sketching", "oil-painting"],
    avatar: "avatar-theo.png",
    projects: [
      {
        title: "The Paper Boat — Picture Book",
        summary: "A 40-page picture book about a fox who sails a paper boat to return the moon's reflection — ink, watercolor, and one gold leaf per spread.",
        description:
          "The Paper Boat is my second picture book as author-illustrator: a small fox notices the moon has lost its reflection in the river, and sails a paper boat downstream to give it back. Forty pages, hand-inked and watercolored at double size, with a single point of gold leaf hidden in every spread.",
        category: "illustration",
        cover: "cover-illustration.png",
        role: "Author and illustrator — story, all 40 spreads, cover",
        brief: "A bedtime book with one rule from my editor: the gold leaf must never be explained — children find it, adults forget to look.",
        process:
          "Thirty thumbnail passes to find the page-turn rhythm, then full-size pencil roughs for the whole book before any final art. Inked with dip pen at double size, watercolor washes in three limited mixes, gold applied last. The endpapers are drawn as one continuous river that wraps the cover.",
        challenges: "Page 23 nearly sank the book: the night river needed to feel vast without a single drop of black. Solved by building the darkness from layered teal-violet washes and letting the paper's white do the moon's work.",
        outcome: "Published autumn season; 12,000 copies in first printing, reprinted twice. Shortlisted for a national illustration award; the original art toured three libraries.",
        tools: ["Dip pen & ink", "Watercolor", "Gold leaf", "Procreate (layout only)"],
        skills: ["watercolor", "sketching", "digital-illustration"],
        daysAgo: 4,
      },
    ],
  },
  {
    email: "priya@beanfolio.app",
    password: "priya-demo",
    name: "Priya Sharma",
    username: "priya-designs",
    headline: "Product designer — systems thinking, motion with meaning",
    bio: "I design product interfaces and the motion that makes them feel honest. Design systems, prototyping, and the research habit of asking why twice.",
    location: "Bengaluru, India",
    availability: "Open to projects",
    professions: ["ui-ux", "motion-design"],
    skills: ["figma", "prototyping", "ux-research", "brand-design"],
    avatar: "avatar-priya.png",
    projects: [
      {
        title: "Aurora — Product Motion & Design System",
        summary: "A 120-component design system with a motion language of nine primitives — adopted by four product teams in one quarter.",
        description:
          "Aurora is the design system for a mid-size SaaS platform, rebuilt from a folder of one-off components into 120 documented components plus a motion language: nine easing/duration primitives that encode the product's personality (responsive, never showy). The system ships as Figma libraries plus coded tokens, so design and engineering drift stays visible.",
        category: "ui-ux",
        cover: "cover-motion.png",
        role: "Design lead — system architecture, motion language, documentation",
        brief: "Four teams, four dialects, one product. Make consistency the easiest path, not the policed one.",
        process:
          "Started with a component audit — every button variant in production, photographed side by side (there were 31). Wrote the token layer first, then rebuilt components against it. Motion began as a research detour: 12 user sessions showed our modals felt 'sneaky' — the fix was a motion vocabulary where entrances state their origin.",
        challenges: "Adoption is the real design problem. Figma libraries alone drifted from code within weeks, so the system publishes coded tokens through the same PR pipeline — a component isn't 'done' until both sides ship.",
        outcome: "Four teams onboarded in one quarter; new-feature design time down roughly 30% by the teams' own tracking. The motion primitives doc became the most-visited internal design page.",
        tools: ["Figma", "Storybook", "Framer Motion"],
        skills: ["figma", "prototyping", "brand-design", "ux-research"],
        contributors: [{ name: "Rahul Verma", role: "Design technologist", contribution: "Token pipeline and Storybook integration" }],
        daysAgo: 2,
      },
    ],
  },
  {
    email: "marco@beanfolio.app",
    password: "marco-demo",
    name: "Marco Bellini",
    username: "marco-tells",
    headline: "Brand & campaign strategist — stories that sell softly",
    bio: "I build brand platforms and launch campaigns for founders who hate advertising. Strategy first, words second, media last. 15 years across food, culture, and tech.",
    location: "Milan, Italy",
    availability: "Open to consulting",
    professions: ["marketing", "graphic-design"],
    skills: ["copywriting", "content-strategy", "seo", "brand-design", "project-management"],
    avatar: "avatar-marco.png",
    projects: [
      {
        title: "Ferro & Fiamma — Brand Platform & Launch",
        summary: "Naming, identity direction, and launch campaign for a wood-fired bakery — sold out first month with zero paid ads.",
        description:
          "A complete brand platform for a wood-fired bakery: name, voice, identity direction, and a launch campaign built on one honest idea — 'slow fire'. We named it, wrote it, art-directed the identity with a lettering artist, and launched with a five-poster street campaign and a 90-second film instead of paid ads.",
        category: "marketing",
        cover: "cover-campaign.png",
        role: "Strategy and creative direction",
        brief: "The bakers can make people queue; they can't make people understand why. Build the brand that explains the queue.",
        process:
          "Two weeks inside the bakery before writing a word — the platform came from their hands, not a workshop. Naming tested against street pronunciation. Identity direction given as a 40-page 'rules of fire' book (palette, type behavior, photography law) executed by two freelancers I commissioned. Launch: five city-center posters, one film, one press letter — all from the same copy deck.",
        challenges: "Craft brands drown in rustic clichés. The strategy banned wheat-ear iconography, kraft paper, and chalkboard scripts outright — the identity had to earn 'artisanal' through typography and fire alone.",
        outcome: "First month sold out; the queue photo became the brand's proof asset. Zero paid media spend. The 'rules of fire' book is now used to brief every freelancer without me in the room.",
        tools: ["Figma", "Notion", "Google Workspace"],
        skills: ["copywriting", "content-strategy", "brand-design", "project-management"],
        contributors: [
          { name: "Chiara Fontana", role: "Lettering artist", contribution: "Custom wordmark and poster lettering" },
          { name: "Inés Ferreira", role: "Launch photography", contribution: "Campaign photography" },
        ],
        daysAgo: 13,
      },
      {
        title: "Northlight Coffee — Packaging & Positioning",
        summary: "Repositioned a struggling specialty roaster around altitude honesty — new positioning, packaging copy system, and a 40% repeat-purchase lift.",
        description:
          "Northlight's coffee was excellent and invisible. The repositioning replaced vague origin mythology with altitude honesty: every bag states the exact farm elevation and what that altitude does in the cup. I wrote the packaging copy system (11 SKUs), the shelf story, and the wholesale one-pager.",
        category: "marketing",
        cover: "cover-brand.png",
        role: "Positioning and verbal identity",
        brief: "Say something true about coffee that a tired person can read in four seconds.",
        process:
          "Shelf audits of 30 competitor SKUs, farmer interviews through their import partner, then a positioning sprint with the founders. The copy system was written as rules — not final copy — so their team can add SKUs without diluting the voice.",
        challenges: "Altitude claims drift toward precision theater. Every number on the bag is traceable to import documents, and the copy system includes a 'we can't verify it' fallback line for future lots.",
        outcome: "Repeat-purchase rate up 40% in six months (their Shopify cohort data); two wholesale accounts signed on the strength of the one-pager alone.",
        tools: ["Illustrator", "Figma"],
        skills: ["copywriting", "content-strategy", "seo"],
        daysAgo: 27,
      },
    ],
  },
];

// ---------- seed logic ----------

async function clear() {
  const demo = await db.user.findMany({ where: { isDemo: true }, select: { id: true } });
  for (const u of demo) {
    await db.user.delete({ where: { id: u.id } }); // cascades to owned content
  }
  console.log(`Cleared ${demo.length} demo users (and their content).`);
  process.exit(0);
}

async function main() {
  if (process.argv.includes("--clear")) await clear();

  const existing = await db.user.count({ where: { isDemo: true } });
  if (existing > 0) {
    console.log(`Seed skipped: ${existing} demo users already exist. Run with --clear to reset fixture data.`);
    return;
  }

  console.log("Seeding BEAN Folio demo fixtures (isDemo=true)...");

  const created: { user: { id: string; username: string }; projects: { id: string; title: string }[] }[] = [];
  const passwordCache = new Map<string, string>();

  for (const su of USERS) {
    const passwordHash = passwordCache.get(su.password) ?? (await hashPassword(su.password));
    passwordCache.set(su.password, passwordHash);

    const user = await db.user.create({
      data: {
        email: su.email,
        passwordHash,
        name: su.name,
        username: su.username,
        headline: su.headline,
        bio: su.bio,
        location: su.location,
        availability: su.availability,
        contactEmail: su.email,
        onboarded: true,
        isDemo: true,
        aiConsent: false,
        createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000),
      },
    });

    const avatar = await importImage(user.id, su.avatar, `${su.username}-avatar.png`);
    const cover = await importImage(user.id, su.projects[0].cover, `${su.username}-profile-cover.png`);
    await db.user.update({ where: { id: user.id }, data: { avatarMediaId: avatar.id, coverMediaId: cover.id } });

    const profRows = await db.profession.findMany({ where: { slug: { in: su.professions } } });
    const skillRows = await db.skill.findMany({ where: { slug: { in: su.skills } } });
    await db.profileProfession.createMany({
      data: profRows.map((p) => ({ userId: user.id, professionId: p.id })),
    });
    await db.profileSkill.createMany({
      data: skillRows.map((s) => ({ userId: user.id, skillId: s.id })),
    });

    const projects: { id: string; title: string }[] = [];
    for (const sp of su.projects) {
      const coverAsset = await importImage(user.id, sp.cover, `${sp.title.slice(0, 40)}-cover.png`);
      const publishedAt = new Date(Date.now() - sp.daysAgo * 24 * 3600 * 1000);
      const project = await db.project.create({
        data: {
          ownerId: user.id,
          title: sp.title,
          summary: sp.summary,
          description: sp.description,
          category: sp.category,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          coverMediaId: coverAsset.id,
          brief: sp.brief,
          process: sp.process,
          challenges: sp.challenges,
          outcome: sp.outcome,
          role: sp.role,
          tools: JSON.stringify(sp.tools),
          externalUrl: sp.externalUrl,
          repoUrl: sp.repoUrl,
          publishedAt,
          createdAt: new Date(publishedAt.getTime() - 14 * 24 * 3600 * 1000),
          updatedAt: publishedAt,
          skills: {
            create: (await db.skill.findMany({ where: { slug: { in: sp.skills } } })).map((s) => ({ skillId: s.id })),
          },
          media: { create: [{ mediaId: coverAsset.id, order: 0, caption: "Cover" }] },
          contributors: { create: (sp.contributors ?? []).map((c) => ({ name: c.name, role: c.role, contribution: c.contribution })) },
        },
      });
      projects.push({ id: project.id, title: project.title });
    }

    created.push({ user: { id: user.id, username: su.username }, projects });
    console.log(`  + ${su.name} (@${su.username}) with ${projects.length} project(s)`);
  }

  // Maya's draft (Studio shows a draft tab; PRIVATE + DRAFT, no cover)
  const maya = created[0];
  await db.project.create({
    data: {
      ownerId: maya.user.id,
      title: "Winter Reel — selecting moments",
      summary: "Rough assembly for the annual winter reel. Not ready for eyes yet.",
      description: "Pulling candidates from this year's client work. Structure undecided — three acts vs. one continuous breath.",
      category: "film-video",
      status: "DRAFT",
      visibility: "PRIVATE",
      tools: JSON.stringify(["Adobe Premiere Pro"]),
    },
  });

  // Follows between demo users (fixture graph)
  const byUsername = Object.fromEntries(created.map((c) => [c.user.username, c.user.id]));
  const followPairs: [string, string][] = [
    ["kofi-codes", "maya-edits"],
    ["maya-edits", "ines-shoots"],
    ["ines-shoots", "maya-edits"],
    ["darius-builds", "ines-shoots"],
    ["priya-designs", "kofi-codes"],
    ["kofi-codes", "priya-designs"],
    ["marco-tells", "lena-cooks"],
    ["theo-draws", "ines-shoots"],
    ["lena-cooks", "marco-tells"],
    ["maya-edits", "darius-builds"],
  ];
  for (const [a, b] of followPairs) {
    await db.follow.create({ data: { followerId: byUsername[a], followingId: byUsername[b] } });
  }

  // Saves (fixture engagement — counts read live from these rows)
  const projId = (username: string, n: number) => created.find((c) => c.user.username === username)!.projects[n].id;
  const savePairs: [string, string][] = [
    ["kofi-codes", projId("ines-shoots", 0)],
    ["kofi-codes", projId("maya-edits", 0)],
    ["priya-designs", projId("maya-edits", 1)],
    ["ines-shoots", projId("theo-draws", 0)],
    ["marco-tells", projId("ines-shoots", 1)],
    ["darius-builds", projId("maya-edits", 0)],
    ["theo-draws", projId("lena-cooks", 0)],
  ];
  for (const [u, p] of savePairs) {
    await db.savedProject.create({ data: { userId: byUsername[u], projectId: p } });
  }

  // Views (fixture — deduped per viewer per UTC day, same rule as the API)
  const allProjects = created.flatMap((c) => c.projects.map((p) => ({ ...p, owner: c.user.username })));
  const viewers = created.map((c) => c.user.id);
  let viewCount = 0;
  for (let d = 13; d >= 0; d--) {
    const day = utcDay(new Date(Date.now() - d * 24 * 3600 * 1000));
    // deterministic pseudo-random spread so the insights series has natural shape
    for (let i = 0; i < 3 + ((d * 7) % 4); i++) {
      const proj = allProjects[(d * 5 + i * 3) % allProjects.length];
      const viewer = viewers[(d + i) % viewers.length];
      try {
        await db.projectView.create({ data: { projectId: proj.id, viewerUserId: viewer, viewerKey: `u:${viewer}`, day } });
        viewCount++;
      } catch {
        /* unique collision — dedup working */
      }
    }
  }
  // a few anonymous viewer keys
  for (let i = 0; i < 12; i++) {
    const proj = allProjects[(i * 5) % allProjects.length];
    const day = utcDay(new Date(Date.now() - (i % 6) * 24 * 3600 * 1000));
    try {
      await db.projectView.create({ data: { projectId: proj.id, viewerKey: `a:seed-anon-${i % 5}`, day } });
      viewCount++;
    } catch {
      /* dedup */
    }
  }
  // profile views between demo users (deduped per viewer per UTC day)
  for (const c of created) {
    for (const v of viewers) {
      if (v === c.user.id) continue;
      try {
        await db.profileView.create({
          data: { profileUserId: c.user.id, viewerKey: `u:${v}`, day: utcDay(new Date()) },
        });
      } catch {
        /* dedup */
      }
    }
  }

  // One pending inquiry to the demo account (Connect inbox demo)
  await db.inquiry.create({
    data: {
      senderId: byUsername["marco-tells"],
      recipientId: byUsername["maya-edits"],
      type: "COLLABORATION",
      subject: "Short film title sequence — paid collaboration",
      message:
        "Hi Maya — I'm producing a 12-minute short for a client and your Night Market cut is exactly the restraint we're after. Budget is confirmed and the edit window would be three weeks from March. Interested in a call this week?",
    },
  });
  await db.notification.create({
    data: {
      userId: byUsername["maya-edits"],
      type: "INQUIRY",
      payload: JSON.stringify({
        actor: "Marco Bellini",
        actorUsername: "marco-tells",
        subject: "Short film title sequence — paid collaboration",
      }),
    },
  });

  console.log(`Seed complete: ${created.length} demo users, ${allProjects.length} published projects + 1 draft, ${followPairs.length} follows, ${savePairs.length} saves, ${viewCount} deduped views.`);
  console.log("Demo sign-in: demo@beanfolio.app / demo1234 (fixture data only).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
