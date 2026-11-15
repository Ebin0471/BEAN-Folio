"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Minimal hash router. The whole SPA lives under the `/` route, so URLs look
 * like `/#/u/ada`, `/#/studio/<id>/edit`. Deep links and back/forward work.
 *
 * Public ROUTE-FORM addresses (`/u/ada`, `/p/<id>`, `/site/ada`, and the
 * website's own project pages `/site/ada/projects/<id>`) are first-class
 * too: src/proxy.ts serves this same SPA document at those paths with the
 * intended route in the `x-bean-boot-route` header. The server renders THAT
 * route's shell (so a published website never paints the Discover feed
 * first), the client hydrates straight into it, and the address bar keeps
 * the exact URL the creator shares. Legacy `/?#/u/ada` deep links are
 * canonicalized to the route form below.
 */

export function parseHash(hash: string): string {
  let p = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!p.startsWith("/")) p = "/" + p;
  // strip query part (kept for future use) and normalize
  p = p.split("?")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

/**
 * Public routes that may boot directly from the URL PATH (see proxy.ts).
 * `/site/<username>/projects/<projectId>` — the standalone website's own
 * project detail page —, `/site/<username>/work/<projectId>` — the M0.5
 * portfolio case study —, `/site/<username>/<pageSlug>` — a portfolio
 * sub-page — and `/site/<username>/g/<siteId>` — a PUBLISHED GIFTZ
 * generated site — are deeper public shapes than the other routes but still
 * bounded and enumerable (never an open wildcard).
 */
const PUBLIC_BOOT_RE =
  /^(?:\/u\/[^/]+|\/p\/[^/]+|\/post\/[^/]+|\/site\/[^/]+(?:\/projects\/[^/]+|\/work\/[^/]+|\/g\/[^/]+|\/[^/]+)?)$/;

/**
 * The active route. A URL fragment always wins (in-app navigation runs on the
 * hash). Without a fragment, a public ROUTE-FORM pathname IS the route — that
 * is how direct visits, refreshes and pasted `/u/<username>` links boot, and
 * it is what makes the proxy-seeded server render and the client snapshot
 * agree (no wrong-route swap after hydration).
 */
export function currentPath(): string {
  if (typeof window === "undefined") return "/";
  const hash = window.location.hash;
  if (hash) return parseHash(hash);
  const pathname = window.location.pathname;
  if (PUBLIC_BOOT_RE.test(pathname)) {
    // Decode each segment exactly as parseHash consumers expect — the proxy
    // passes the requested path through percent-encoded.
    const segments = pathname
      .slice(1)
      .split("/")
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    return `/${segments.join("/")}`;
  }
  return "/";
}

export function navigate(to: string, replace = false): void {
  if (typeof window === "undefined") return;
  const target = `#${to.startsWith("/") ? to : "/" + to}`;
  if (replace) {
    const before = window.location.hash;
    window.history.replaceState(null, "", target);
    // The patched replaceState below already notifies when the hash changed.
    // Dispatch manually only when the URL stayed identical but the caller
    // still wants a re-render of the current route.
    if (window.location.hash === before) {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }
  } else if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

// ------------------------------------------------------------- boot canonicalization

/**
 * Legacy deep links (`/?#/u/ada`) are canonicalized to the ROUTE form as soon
 * as the bundle loads: the address bar becomes `/u/ada`, so a refresh or a
 * re-open boots through the proxy-seeded path (correct route server-rendered)
 * instead of repeating the Discover-first hash-form load. In-app navigation
 * afterwards is untouched (this runs once per document load).
 */
if (typeof window !== "undefined") {
  const canonicalizeBootUrl = () => {
    try {
      if (PUBLIC_BOOT_RE.test(window.location.pathname)) return; // already route form
      const route = parseHash(window.location.hash);
      if (!PUBLIC_BOOT_RE.test(route)) return;
      const target = `${route}${window.location.search}`;
      window.history.replaceState(null, "", target);
    } catch {
      /* never let URL cosmetics break the app */
    }
  };
  canonicalizeBootUrl();
}

// ------------------------------------------------- post-auth destination memory

const RETURN_TO_KEY = "bean:return-to";

/**
 * Remember the route a visitor wanted so sign-in / onboarding can return them
 * there afterwards. sessionStorage (per-tab, survives navigation, dies with
 * the tab) — never a query param, which the hash router strips.
 */
export function storeReturnTo(route: string): void {
  if (typeof window === "undefined") return;
  if (!route.startsWith("/") || route.startsWith("//")) return;
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, route);
  } catch {
    /* storage unavailable */
  }
}

/** Read-and-clear the remembered destination. Falls back to `fallback`. */
export function takeReturnTo(fallback = "/"): string {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

/**
 * Route-classification used by the auth/onboarding gates:
 * public pages must never hijack navigation into an auth or setup flow.
 * Discover (empty path), project pages, profiles and static pages are public.
 */
const PUBLIC_ROOT_SEGMENTS = new Set(["explore", "p", "u", "site", "embed", "privacy", "terms", "auth", "onboarding"]);

export function isPublicRoute(segments: string[]): boolean {
  if (segments.length === 0) return true; // Discover feed
  return PUBLIC_ROOT_SEGMENTS.has(segments[0]);
}

// next/link performs same-page hash navigation via history.pushState, which
// (unlike setting location.hash) does NOT fire a hashchange event. Patch the
// history methods once so our router also updates when <Link> navigates.
//
// The notify is deferred with queueMicrotask and coalesced: history methods can
// be invoked synchronously while React is rendering/committing (e.g. navigate()
// inside an effect), and dispatching an event synchronously at that moment lets
// setState run inside React's internal lifecycle window ("useInsertionEffect
// must not schedule updates"). A microtask lands safely after the current task.
if (typeof window !== "undefined" && !window.__beanHistoryPatched) {
  window.__beanHistoryPatched = true;
  let notifyScheduled = false;
  const notify = () => {
    if (notifyScheduled) return; // coalesce bursts into a single dispatch
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  };
  // Capture the natives BEFORE overwriting; native methods throw "Illegal
  // invocation" without the correct receiver, hence .apply(window.history, …).
  const origPush = History.prototype.pushState;
  const origReplace = History.prototype.replaceState;
  window.history.pushState = (...args: Parameters<History["pushState"]>) => {
    const before = window.location.hash;
    origPush.apply(window.history, args);
    if (window.location.hash !== before) notify();
  };
  window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
    const before = window.location.hash;
    origReplace.apply(window.history, args);
    if (window.location.hash !== before) notify();
  };
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

// ------------------------------------------------------------- boot route context

/**
 * The route the SERVER seeded for this document (from the proxy's
 * x-bean-boot-route header), or null when the document booted without one.
 *
 * getServerSnapshot must return EXACTLY what the server rendered — for a
 * seeded document that is the seeded route, never "/" (which would make React
 * hydrate the Discover feed and swap it away afterwards — the wrong-page flash
 * this context exists to prevent). The context (instead of a module global)
 * keeps per-request values isolated on the server.
 */
const BootRouteContext = createContext<string | null>(null);

/** Provided once by SiteShell with the header-derived boot route (or null). */
export function BootRouteProvider({ value, children }: { value: string | null; children: ReactNode }) {
  return <BootRouteContext.Provider value={value}>{children}</BootRouteContext.Provider>;
}

/** The server-seeded boot route for this document, if any (e.g. "/u/ada"). */
export function useBootRoute(): string | null {
  return useContext(BootRouteContext);
}

export function useHashRoute(): { path: string; segments: string[] } {
  // Hydration-safe: useSyncExternalStore renders the server snapshot (the
  // seeded boot route, or "/") during hydration and switches to the real
  // client route afterwards only when they genuinely differ.
  const boot = useContext(BootRouteContext);
  const path = useSyncExternalStore(subscribeToHash, currentPath, () => boot ?? "/");

  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    // Editorial feel: jump to top on navigation
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [path]);

  const segments = path === "/" ? [] : path.slice(1).split("/");
  return { path, segments };
}

/** Anchor-compatible nav handler: middle-click/⌘-click still work via href. */
export function useNav() {
  return useCallback((to: string) => navigate(to), []);
}

declare global {
  interface Window {
    __beanHistoryPatched?: boolean;
  }
}
