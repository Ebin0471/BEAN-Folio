"use client";

import { useSyncExternalStore } from "react";

import { useBootRoute } from "@/lib/hash-router";

/**
 * Chrome-suppression signal for standalone published websites.
 *
 * BEAN Folio's platform shell (header nav, footer, mobile tab bar, account
 * buttons) wraps every route of the dashboard application. A PUBLISHED custom
 * website is the creator's own independent website and must render WITHOUT
 * any of that platform chrome — visitors see only the creator's site (the
 * architecture BEAN Folio adapts from vercel/platforms: tenant sites render
 * standalone, platform UI stays on the platform surface only).
 *
 * The shell cannot know up-front whether a given /site/<username> address is a
 * published website (that fact lives behind GET /api/profiles/:username), so
 * the site view drives this tiny store through three states:
 *
 *  - "pending"  a website route is loading — platform chrome is hidden so a
 *               published website never flashes the app shell around it
 *  - "yes"      a published website is rendered — chrome stays hidden
 *  - "no"       unpublished / not-found / any other route — chrome shown
 *
 * The shell additionally requires the active route to be /site/<username>
 * before hiding anything (see SiteShell), so a stale "yes" can never strip
 * chrome from another route. The BEAN Folio public profile (/u/<username>)
 * NEVER suppresses chrome — it is always the platform profile experience,
 * independent of website publishing.
 *
 * Server snapshot: when the document booted from the public ROUTE form
 * `/site/<username>` (proxy-seeded boot route), the server already knows the
 * visitor is heading into a website route, so its snapshot is "pending" —
 * the SSR HTML renders the site's own shell WITHOUT platform chrome from the
 * very first paint. Any other boot (including /u/<username> profile routes)
 * renders "no" (normal shell).
 */

export type StandaloneState = "no" | "pending" | "yes";

let state: StandaloneState = "no";
const listeners = new Set<() => void>();

export function setStandaloneSite(next: StandaloneState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

export function getStandaloneSite(): StandaloneState {
  return state;
}

/**
 * Low-level subscription (React's useSyncExternalStore uses this; also usable
 * by non-React consumers). Returns the unsubscribe function.
 */
export function subscribeStandaloneSite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: current standalone state (hydration-safe server snapshot). */
export function useStandaloneSite(): StandaloneState {
  const boot = useBootRoute();
  return useSyncExternalStore(subscribeStandaloneSite, getStandaloneSite, () =>
    typeof boot === "string" && boot.startsWith("/site/") ? "pending" : "no"
  );
}
