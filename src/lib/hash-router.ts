"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Minimal hash router. The whole SPA lives under the `/` route, so URLs look
 * like `/#/u/ada`, `/#/studio/<id>/edit`. Deep links and back/forward work.
 */

export function parseHash(hash: string): string {
  let p = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!p.startsWith("/")) p = "/" + p;
  // strip query part (kept for future use) and normalize
  p = p.split("?")[0];
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

export function currentPath(): string {
  if (typeof window === "undefined") return "/";
  return parseHash(window.location.hash);
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
const PUBLIC_ROOT_SEGMENTS = new Set(["explore", "p", "u", "privacy", "terms", "auth", "onboarding"]);

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

export function useHashRoute(): { path: string; segments: string[] } {
  // Hydration-safe: useSyncExternalStore renders the server snapshot ("/")
  // during hydration and switches to the real client hash afterwards, instead
  // of mismatching the first client render (deep links like #/u/ada used to
  // trip React's hydration diff).
  const path = useSyncExternalStore(subscribeToHash, currentPath, () => "/");

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
