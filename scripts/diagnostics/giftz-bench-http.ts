/**
 * GIFTZ real-world website generation benchmark — HTTP driver (GZ-BENCH-1).
 *
 * Drives the REAL product workflow over REAL HTTP against the running
 * Next.js server: register → onboarding → GIFTZ site draft → studio session
 * → turn pipeline (config compose / file pipeline with real AI) → proposal
 * apply → file tree → preview serve → build gate → publish → public artifact.
 * No mocks, no scripted providers, no in-process handler calls — everything
 * goes through the same API surface the UI uses.
 *
 * Isolation: the server this driver talks to MUST be pinned to the isolated
 * QA database (DATABASE_URL=file:./db/qa-giftz-bench.db), never the live one.
 * One dedicated QA user per benchmark (per-user AI quota applies unchanged).
 *
 * Stepwise commands (each invocation is short; turns keep running in the
 * server process between invocations):
 *
 *   bun scripts/diagnostics/giftz-bench-http.ts run1 A       # register + site + session + send turn 1
 *   bun scripts/diagnostics/giftz-bench-http.ts poll A 1 480 # poll turn 1 (exit 2 = still running)
 *   bun scripts/diagnostics/giftz-bench-http.ts apply A 1    # save config / apply files proposal
 *   bun scripts/diagnostics/giftz-bench-http.ts turn2 A      # send follow-up prompt
 *   bun scripts/diagnostics/giftz-bench-http.ts apply A 2
 *   bun scripts/diagnostics/giftz-bench-http.ts evaluate A   # tree/preview/links/build/publish/public + evidence
 *
 * Evidence: /home/z/beanfolio-benchmarks/giftz-benchmark/<RUN_ID>/<letter>/
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const BASE = process.env.GIFTZ_BENCH_BASE ?? "http://localhost:3000";
const RUN_ID = process.env.GIFTZ_BENCH_RUN_ID ?? "run";
const ROOT = "/home/z/beanfolio-benchmarks/giftz-benchmark";
const STATE_FILE = path.join(ROOT, `state-${RUN_ID}.json`);

interface TurnState {
  taskId: string;
  assistantMessageId: string;
  sentAt: string;
  doneAt?: string;
  status?: string;
  error?: string | null;
  kind?: string;
  stagesSeen?: string[];
}

interface BenchState {
  letter: string;
  email: string;
  password: string;
  username: string;
  cookie?: string;
  userId?: string;
  siteId?: string;
  sessionId?: string;
  turn1?: TurnState;
  turn2?: TurnState;
  applied1?: boolean;
  applied2?: boolean;
  fileSync?: unknown;
}

interface StateFileShape {
  runId: string;
  benchmarks: Record<string, BenchState>;
}

function loadState(): StateFileShape {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFileShape;
  return { runId: RUN_ID, benchmarks: {} };
}

function saveState(s: StateFileShape): void {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function state(letter: string): BenchState {
  const s = loadState();
  if (!s.benchmarks[letter]) throw new Error(`no state for benchmark ${letter} — run 'run1 ${letter}' first`);
  return s.benchmarks[letter];
}

function updateState(letter: string, patch: Partial<BenchState>): void {
  const s = loadState();
  s.benchmarks[letter] = { ...s.benchmarks[letter], ...patch };
  saveState(s);
}

async function api(
  cookie: string | undefined,
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `198.51.${Math.floor(Math.random() * 254)}.${Math.floor(Math.random() * 254)}`,
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON (binary/plain) responses are fine */
  }
  return { status: res.status, headers: res.headers, json };
}

function cookieFrom(headers: Headers): string {
  const setCookie = headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(";")[0];
    if (pair.startsWith("bean_session=") && pair.length > "bean_session=".length) return pair;
  }
  throw new Error("no bean_session cookie in response");
}

// ---- Benchmark definitions --------------------------------------------------

interface BenchDef {
  letter: string;
  title: string;
  createPrompt: string;
  followUpPrompt?: string;
  expectedPages: string[];
}

const BENCHMARKS: Record<string, BenchDef> = {
  A: {
    letter: "A",
    title: "Northwind Architecture Studio",
    createPrompt:
      "Create a professional website for Northwind Architecture Studio, a small architecture firm in Portland. Warm minimal design with a charcoal and brass palette. Include a hero with a clear value proposition, a short intro section about the firm, and a contact section with email and phone.",
    followUpPrompt:
      "Split this into a real multi-page website: create about.html (firm story and team), services.html (residential, commercial and renovation services with short descriptions), and contact.html (contact details, office hours and a simple form layout). Add consistent top navigation linking all four pages plus a shared footer with the firm address and a copyright line. Internal links between pages must work.",
    expectedPages: ["index.html", "about.html", "services.html", "contact.html"],
  },
  B: {
    letter: "B",
    title: "Mara Chen — Product Designer",
    createPrompt:
      "Create a professional portfolio website for Mara Chen, a product designer. Modern editorial style with generous whitespace and strong typography. Hero with her name and role, a featured projects preview section, a short about blurb, and a contact section.",
    followUpPrompt:
      "Turn this into a full portfolio: create projects.html with a grid of six project cards (title, short description, year and category each), create project-detail.html as a case-study template page presenting one project in depth (brief, role, outcome), and create about.html with a longer bio. Navigation must consistently link Home, Projects, About and Contact across all pages.",
    expectedPages: ["index.html", "projects.html", "project-detail.html", "about.html"],
  },
  C: {
    letter: "C",
    title: "Aurora Ceramics Shop",
    createPrompt:
      "Create an online storefront for Aurora Ceramics, a handmade pottery shop. Earthy palette, product-focused layout. Hero announcing the new autumn collection and a section previewing products with prices.",
    followUpPrompt:
      "Build out the shop: create shop.html with a product listing grid of eight ceramic products (name, price in USD, short description, Add to Cart button) and product.html as a product detail view template (large product image area, price, description, quantity picker, add-to-cart button). Make the Add to Cart buttons update a simple client-side cart counter in the navigation using inline JavaScript. Include a clearly visible note that checkout and payment processing are demo-only and not implemented.",
    expectedPages: ["index.html", "shop.html", "product.html"],
  },
  D: {
    letter: "D",
    title: "PulseMetrics — Product Analytics",
    createPrompt:
      "Create a marketing website for PulseMetrics, a SaaS analytics platform for product teams. Clean modern SaaS look with deep green accents (avoid blue). Hero with headline and a primary Start free trial call to action, a features overview section, and a footer.",
    followUpPrompt:
      "Extend the site: create features.html detailing six core features with short copy, pricing.html with three pricing tiers (Free, Pro at $29/month, Enterprise) each with a feature list and CTA button, and faq.html with at least eight FAQ items using details/summary accordions. Keep navigation consistent across landing, features, pricing and FAQ pages.",
    expectedPages: ["index.html", "features.html", "pricing.html", "faq.html"],
  },
  E: {
    letter: "E",
    title: "Vela One Headphones",
    createPrompt:
      "Create an immersive product website for Vela One, a premium wireless headphone. Dark cinematic design. Present the product with a real 3D scene (a stylized geometric headphone built from primitives is fine) with orbit camera controls and scroll-triggered rotation, plus a graceful static fallback panel when WebGL is unavailable. No external CDN dependencies.",
    followUpPrompt:
      "Strengthen the 3D presentation: make sure the hero uses the 3D scene with drag-to-orbit camera controls and scroll-triggered rotation of the product, and verify there is a visible fallback panel with a static product illustration when WebGL cannot run. Keep everything local — no CDN scripts.",
    expectedPages: ["index.html"],
  },
};

// ---- Commands ----------------------------------------------------------------

async function cmdRun1(letter: string): Promise<void> {
  const def = BENCHMARKS[letter];
  if (!def) throw new Error(`unknown benchmark ${letter}`);
  const s = loadState();
  if (s.benchmarks[letter]?.siteId) throw new Error(`benchmark ${letter} already started`);
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `giftz-bench-${letter.toLowerCase()}-${suffix}@qa.local`;
  const password = `qa-bench-${suffix}-pass`;

  // 1. Real registration (session cookie issued by the server).
  const reg = await api(undefined, "POST", "/api/auth/register", {
    email,
    password,
    name: `Giftz Bench ${letter}`,
    identity: "CAREER_PROFESSIONAL",
  });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json).slice(0, 300)}`);
  const cookie = cookieFrom(reg.headers);
  const userId = String((reg.json.user as Record<string, unknown> | undefined)?.id ?? "");

  // 2. Real onboarding (username — publish uses it for the public path).
  const username = `giftzbench${letter.toLowerCase()}${suffix.slice(0, 8)}`;
  const onb = await api(cookie, "POST", "/api/me/onboarding", {
    username,
    displayName: `Giftz Bench ${letter}`,
    professions: ["graphic-designer"],
  });
  if (onb.status !== 200 && onb.status !== 201) throw new Error(`onboarding failed: ${onb.status} ${JSON.stringify(onb.json).slice(0, 300)}`);

  // 3. GIFTZ site draft with the real brief.
  const site = await api(cookie, "POST", "/api/giftz/sites", { title: def.title, sourcePrompt: def.createPrompt });
  if (site.status !== 200) throw new Error(`site create failed: ${site.status} ${JSON.stringify(site.json).slice(0, 300)}`);
  const siteId = String((site.json.site as Record<string, unknown>).id);

  // 4. Studio session bound to the site.
  const session = await api(cookie, "POST", "/api/me/site/studio/sessions", {
    title: `Benchmark ${letter}`,
    target: { kind: "giftz", siteId },
  });
  if (session.status !== 200) throw new Error(`session create failed: ${session.status} ${JSON.stringify(session.json).slice(0, 300)}`);
  const sessionId = String((session.json.session as Record<string, unknown>).id);

  // 5. Send turn 1 (real generation trigger, 202 + background pipeline).
  const msg = await api(cookie, "POST", `/api/me/site/studio/sessions/${sessionId}/messages`, {
    text: def.createPrompt,
    mode: "create",
  });
  if (msg.status !== 202) throw new Error(`message POST failed: ${msg.status} ${JSON.stringify(msg.json).slice(0, 400)}`);
  const turn1: TurnState = {
    taskId: String(msg.json.taskId),
    assistantMessageId: String(msg.json.assistantMessageId),
    sentAt: new Date().toISOString(),
    stagesSeen: [],
  };
  updateState(letter, { letter, email, password, username, cookie, userId, siteId, sessionId, turn1 });
  console.log(`[${letter}] turn1 sent: taskId=${turn1.taskId} site=${siteId}`);
}

async function cmdPoll(letter: string, turnNo: 1 | 2, maxSeconds: number): Promise<void> {
  const st = state(letter);
  const turnKey = turnNo === 1 ? "turn1" : "turn2";
  const turn = (st[turnKey] as TurnState | undefined);
  if (!turn) throw new Error(`turn ${turnNo} not started for ${letter}`);
  const deadline = Date.now() + maxSeconds * 1000;
  const stagesSeen = new Set<string>(turn.stagesSeen ?? []);
  for (;;) {
    const r = await api(st.cookie, "GET", `/api/me/site/studio/turns/${turn.taskId}`);
    if (r.status !== 200) throw new Error(`poll failed: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    const message = r.json.message as Record<string, unknown>;
    const meta = (message.meta ?? {}) as Record<string, unknown>;
    const stage = typeof meta.stage === "string" ? meta.stage : "";
    if (stage && !stagesSeen.has(stage)) {
      stagesSeen.add(stage);
      console.log(`[${letter}] turn${turnNo} stage: ${stage} (${((Date.now() - Date.parse(turn.sentAt)) / 1000) | 0}s)`);
    }
    const status = String(message.status ?? "");
    if (status === "DONE" || status === "FAILED") {
      const proposal = (message.proposal as Record<string, unknown> | null) ?? null;
      const kind = proposal ? String((proposal.kind as string) ?? "config") : proposal === null && status === "DONE" ? "reply" : "none";
      updateState(letter, {
        [turnKey]: {
          ...turn,
          doneAt: new Date().toISOString(),
          status,
          error: (message.error as string | null) ?? null,
          kind,
          stagesSeen: [...stagesSeen],
        },
      } as Partial<BenchState>);
      console.log(
        `[${letter}] turn${turnNo} ${status} kind=${kind} elapsed=${((Date.now() - Date.parse(turn.sentAt)) / 1000) | 0}s` +
          (status === "FAILED" ? ` error=${String(message.error ?? "").slice(0, 300)}` : "")
      );
      return;
    }
    if (Date.now() > deadline) {
      updateState(letter, { [turnKey]: { ...turn, stagesSeen: [...stagesSeen] } } as Partial<BenchState>);
      console.log(`[${letter}] turn${turnNo} still ${String((r.json.task as Record<string, unknown>).status)} — re-run poll`);
      process.exit(2);
    }
    await new Promise((r2) => setTimeout(r2, 4000));
  }
}

async function cmdApply(letter: string, turnNo: 1 | 2): Promise<void> {
  const st = state(letter);
  const turn = (turnNo === 1 ? st.turn1 : st.turn2) as TurnState;
  if (!turn || !turn.status) throw new Error(`turn ${turnNo} not finished for ${letter}`);
  if (turn.status !== "DONE" && turn.status !== "FAILED") {
    console.log(`[${letter}] turn${turnNo} ${turn.status} — nothing to apply (error recorded as evidence)`);
    updateState(letter, turnNo === 1 ? { applied1: false } : { applied2: false });
    return;
  }
  const r = await api(st.cookie, "GET", `/api/me/site/studio/turns/${turn.taskId}`);
  const proposal = ((r.json.message as Record<string, unknown>).proposal as Record<string, unknown> | null) ?? null;
  if (!proposal) {
    console.log(`[${letter}] turn${turnNo} DONE without proposal (reply-only) — recorded as evidence`);
    updateState(letter, turnNo === 1 ? { applied1: false } : { applied2: false });
    return;
  }
  const kind = String((proposal.kind as string) ?? "config");
  if (kind === "files") {
    const res = await api(st.cookie, "POST", `/api/giftz/sites/${st.siteId}/files/apply-proposal`, {
      messageId: turn.assistantMessageId,
    });
    // The API answers { applied: <count>, files: [...] } (count ≥ 0); the
    // proposal may also be applied from a FAILED turn that preserved a
    // partial overlay — the product explicitly supports partial applies.
    const applied = res.json.applied;
    const appliedOk = res.status === 200 && (applied === true || (typeof applied === "number" && applied >= 0));
    if (!appliedOk) {
      throw new Error(`apply failed: ${res.status} ${JSON.stringify(res.json).slice(0, 500)}`);
    }
    console.log(`[${letter}] turn${turnNo} files proposal applied (${String(applied)}): ${JSON.stringify(res.json).slice(0, 300)}`);
  } else {
    const res = await api(st.cookie, "PUT", `/api/giftz/sites/${st.siteId}`, { config: proposal.config });
    if (res.status !== 200) throw new Error(`config save failed: ${res.status} ${JSON.stringify(res.json).slice(0, 500)}`);
    console.log(`[${letter}] turn${turnNo} config saved; fileSync=${JSON.stringify(res.json.fileSync)}`);
    updateState(letter, { fileSync: res.json.fileSync });
  }
  updateState(letter, turnNo === 1 ? { applied1: true } : { applied2: true });
}

async function cmdTurn2(letter: string): Promise<void> {
  const st = state(letter);
  const def = BENCHMARKS[letter];
  if (!def.followUpPrompt) throw new Error(`benchmark ${letter} has no follow-up`);
  const msg = await api(st.cookie, "POST", `/api/me/site/studio/sessions/${st.sessionId}/messages`, {
    text: def.followUpPrompt,
    mode: "edit",
  });
  if (msg.status !== 202) throw new Error(`message POST failed: ${msg.status} ${JSON.stringify(msg.json).slice(0, 400)}`);
  const turn2: TurnState = {
    taskId: String(msg.json.taskId),
    assistantMessageId: String(msg.json.assistantMessageId),
    sentAt: new Date().toISOString(),
    stagesSeen: [],
  };
  updateState(letter, { turn2 });
  console.log(`[${letter}] turn2 sent: taskId=${turn2.taskId}`);
}

function extractInternalLinks(html: string): string[] {
  const out = new Set<string>();
  const re = /href="([^"#]*)\.html(#?)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    // Normalize ./ and ../ prefixes before comparing with the tree —
    // the build gate's resolver accepts them (GZ-BENCH-1 false positive).
    const raw = m[1].replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
    out.add(`${raw || "index"}.html`);
  }
  return [...out];
}

async function fetchPreview(st: BenchState, page: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(
    page === "index.html" ? `${BASE}/api/giftz/sites/${st.siteId}/preview` : `${BASE}/api/giftz/sites/${st.siteId}/preview/${page}`,
    { headers: { cookie: st.cookie ?? "" } }
  );
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function fetchPublic(st: BenchState, page: string): Promise<{ status: number; headers: Headers; body: string }> {
  // The artifact (with CSP) is served by the [...path] route for EVERY page
  // including index.html. The bare /public route is the render-DATA contract
  // (site/config/deployment JSON used by the public view page) — not the
  // artifact (GZ-BENCH-1 evidence: root fetch has no CSP and never matches
  // the artifact).
  const res = await fetch(`${BASE}/api/giftz/sites/${st.siteId}/public/${page}`, {
    headers: { cookie: st.cookie ?? "" },
  });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

async function cmdEvaluate(letter: string): Promise<void> {
  const st = state(letter);
  const def = BENCHMARKS[letter];
  const t0 = Date.now();

  // 1. File tree.
  const filesRes = await api(st.cookie, "GET", `/api/giftz/sites/${st.siteId}/files`);
  if (filesRes.status !== 200) throw new Error(`files list failed: ${filesRes.status}`);
  const rawFiles = ((filesRes.json.files ?? filesRes.json.tree ?? []) as { path: string; sizeBytes: number; source: string }[]) ?? [];
  const fileTree = rawFiles.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, source: String(f.source) }));
  const paths = new Set(fileTree.map((f) => f.path));

  // 2. Preview every HTML page + deterministic link resolution check.
  const htmlFiles = fileTree.filter((f) => f.path.endsWith(".html")).map((f) => f.path);
  const preview: Record<string, unknown>[] = [];
  const linkCheck: Record<string, unknown>[] = [];
  const pageContents = new Map<string, string>();
  for (const page of htmlFiles) {
    const r = await fetchPreview(st, page);
    pageContents.set(page, r.body);
    preview.push({
      page,
      status: r.status,
      contentType: r.headers.get("content-type") ?? "",
      bytes: r.body.length,
      hasViewport: r.body.includes('name="viewport"'),
      hasLang: /<html[^>]*\slang=/i.test(r.body),
      hasTitle: /<title>[^<]{2,}<\/title>/i.test(r.body),
      hasNav: /<nav[\s>]/i.test(r.body) || /role="navigation"/i.test(r.body),
    });
    const links = extractInternalLinks(r.body);
    linkCheck.push({ page, links, broken: links.filter((l) => !paths.has(l)) });
  }

  // 3. Manual build through the real build gate.
  const buildRes = await api(st.cookie, "POST", `/api/giftz/sites/${st.siteId}/builds`, { trigger: "manual" });
  const buildRaw = (buildRes.json.build ?? {}) as Record<string, unknown>;
  const build = {
    httpStatus: buildRes.status,
    status: String(buildRaw.status ?? ""),
    diagnostics: ((buildRaw.diagnostics as { path: string; severity: string; message: string }[]) ?? []).map((d) => ({
      path: d.path,
      severity: d.severity,
      message: d.message,
    })),
  };

  // 4. Publish through the real publish gate.
  const pubRes = await api(st.cookie, "POST", `/api/giftz/sites/${st.siteId}/publish`, {});
  const pubBody = pubRes.json;
  const depRaw = (pubBody.deployment ?? {}) as Record<string, unknown>;
  const publish = {
    httpStatus: pubRes.status,
    status: String(pubBody.status ?? ""),
    publicPath: (pubBody.publicPath as string | null) ?? null,
    deploymentStatus: depRaw.status ? String(depRaw.status) : null,
    buildStatus: ((pubBody.build as Record<string, unknown> | undefined)?.status as string | undefined) ?? build.status,
    error: pubRes.status !== 200 ? JSON.stringify(pubBody).slice(0, 600) : null,
  };

  // 5. Public artifact fetch (UNAUTHENTICATED) + header audit. Every page —
  // including index.html — goes through the [...path] artifact route.
  const publicFetch: Record<string, unknown>[] = [];
  if (publish.publicPath) {
    for (const page of htmlFiles) {
      const r = await fetchPublic(st, page);
      publicFetch.push({
        page,
        status: r.status,
        csp: r.headers.get("content-security-policy"),
        nosniff: r.headers.get("x-content-type-options"),
        cacheControl: r.headers.get("cache-control"),
        bytes: r.body.length,
        matchesPreview: pageContents.get(page) === r.body,
      });
    }
  }

  // 6. Evidence: JSON + generated file dumps (outside the repository).
  const evidence = {
    letter,
    runId: RUN_ID,
    email: st.email,
    username: st.username,
    siteId: st.siteId,
    sessionId: st.sessionId,
    turn1: st.turn1,
    applied1: st.applied1,
    turn2: st.turn2,
    applied2: st.applied2,
    fileSync: st.fileSync,
    fileTree,
    expectedPages: def.expectedPages,
    expectedPagesFound: def.expectedPages.filter((p) => paths.has(p)),
    expectedPagesMissing: def.expectedPages.filter((p) => !paths.has(p)),
    preview,
    linkCheck,
    build,
    publish,
    publicFetch,
    evaluateMs: Date.now() - t0,
  };
  const dir = path.join(ROOT, RUN_ID, letter);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(evidence, null, 2));
  const filesDir = path.join(dir, "generated-files");
  mkdirSync(filesDir, { recursive: true });
  for (const [page, content] of pageContents) {
    writeFileSync(path.join(filesDir, page.replaceAll("/", "__")), content);
  }
  for (const f of fileTree.filter((f) => !f.path.endsWith(".html") && f.sizeBytes < 96_000)) {
    const res = await api(
      st.cookie,
      "GET",
      `/api/giftz/sites/${st.siteId}/files/content?path=${encodeURIComponent(f.path)}`
    );
    if (res.status === 200) {
      const file = ((res.json.file ?? {}) as { content?: string }).content ?? "";
      writeFileSync(path.join(filesDir, f.path.replaceAll("/", "__")), file);
    }
  }
  console.log(`[${letter}] evidence written: ${dir} (${fileTree.length} files, build=${build.status}, publish=${publish.status})`);
}

// ---- Main ---------------------------------------------------------------------

const [, , cmd, letter, turnNo, maxSeconds] = process.argv;
async function main(): Promise<void> {
  if (cmd === "run1") return cmdRun1(letter);
  if (cmd === "poll") return cmdPoll(letter, (Number(turnNo) as 1 | 2) ?? 1, Number(maxSeconds ?? 480));
  if (cmd === "apply") return cmdApply(letter, (Number(turnNo) as 1 | 2) ?? 1);
  if (cmd === "turn2") return cmdTurn2(letter);
  if (cmd === "evaluate") return cmdEvaluate(letter);
  throw new Error("usage: giftz-bench-http.ts run1|poll|apply|turn2|evaluate <letter> [turnNo] [maxSeconds]");
}
main().catch((e) => {
  console.error("BENCH-ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
