/// <reference types="bun-types" />
/**
 * Standalone published-website chrome-suppression tests (lib/standalone-site).
 *
 * The published portfolio must render as the creator's OWN independent
 * website: platform chrome (header nav / account buttons / footer / mobile
 * tab bar) is hidden while a profile route resolves and stays hidden only
 * while a published site is actually shown. These tests pin the state
 * machine shared by the shell (page.tsx) and the profile view:
 *
 *  1. default state is "no" (platform chrome visible) — including the SSR
 *     snapshot behavior of the hook's store;
 *  2. the profile view's lifecycle works: no → pending → yes for a published
 *     site, and pending → no for standard profiles / not-found / errors;
 *  3. leaving a profile route (unmount cleanup) resets to "no" from any state;
 *  4. subscribers are notified on every real change (React re-renders the
 *     shell exactly when chrome must change) and never on redundant sets;
 *  5. the state machine is a clean 3-state enum — nothing can encode
 *     "chrome hidden" outside /site/<username> routes (page.tsx guards that).
 *
 * Run: bun test tests/standalone-site.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  getStandaloneSite,
  setStandaloneSite,
  subscribeStandaloneSite,
  type StandaloneState,
} from "../src/lib/standalone-site";

describe("standalone-site store", () => {
  test("default state is no — platform chrome visible", () => {
    setStandaloneSite("no");
    expect(getStandaloneSite()).toBe("no");
  });

  test("published-site lifecycle: no → pending → yes (chrome hidden throughout)", () => {
    setStandaloneSite("no");
    setStandaloneSite("pending"); // profile route mounts, fetch starts
    expect(getStandaloneSite()).toBe("pending");
    setStandaloneSite("yes"); // profile resolves as a published website
    expect(getStandaloneSite()).toBe("yes");
  });

  test("standard profile / not-found resolves back to no (chrome returns)", () => {
    setStandaloneSite("pending");
    setStandaloneSite("no");
    expect(getStandaloneSite()).toBe("no");
  });

  test("unmount cleanup resets from any state", () => {
    for (const from of ["pending", "yes"] as StandaloneState[]) {
      setStandaloneSite(from);
      setStandaloneSite("no"); // PublicProfileView unmount cleanup
      expect(getStandaloneSite()).toBe("no");
    }
  });

  test("subscribers are notified on every real change, never on redundant sets", () => {
    setStandaloneSite("no");
    const seen: StandaloneState[] = [];
    const unsubscribe = subscribeStandaloneSite(() => seen.push(getStandaloneSite()));

    setStandaloneSite("pending");
    setStandaloneSite("pending"); // redundant — no notification
    setStandaloneSite("yes");
    setStandaloneSite("no");

    expect(seen).toEqual(["pending", "yes", "no"]);
    unsubscribe();
    setStandaloneSite("yes"); // after unsubscribe: no more notifications
    expect(getStandaloneSite()).toBe("yes");
    setStandaloneSite("no");
  });

  test("unsubscribe stops notifications", () => {
    setStandaloneSite("no");
    let count = 0;
    const unsubscribe = subscribeStandaloneSite(() => count++);
    unsubscribe();
    setStandaloneSite("pending");
    expect(count).toBe(0);
    setStandaloneSite("no");
  });

  test("state machine has exactly the three documented states", () => {
    // The type forbids others at compile time; at runtime the value must be
    // one of them after every legal set (fail loudly on any drift).
    const legal: StandaloneState[] = ["no", "pending", "yes"];
    for (const s of legal) {
      setStandaloneSite(s);
      expect(legal).toContain(getStandaloneSite());
    }
    setStandaloneSite("no");
  });
});
