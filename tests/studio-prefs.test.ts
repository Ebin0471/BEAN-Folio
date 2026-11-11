/// <reference types="bun-types" />
/**
 * Studio mode preferences — independence and wiring (task 18).
 *
 * Pins the TWO-STORE architecture:
 *  - Customization and CODE GIFTZ read/write SEPARATE localStorage keys
 *  - a write to one mode's key never changes the other mode's reads
 *  - every CODE GIFTZ setting has a default and survives a round-trip
 *  - corrupted JSON / invalid values fall back to defaults
 *
 * Run: bun test tests/studio-prefs.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CHAT_WIDTH_PCT_MAX,
  CHAT_WIDTH_PCT_MIN,
  DEFAULT_CHAT_WIDTH_PCT,
  DEFAULT_CUSTOMIZATION_PREFS,
  DEFAULT_GIFTZ_PREFS,
  readModePrefs,
  resetModePrefs,
  writeModePrefs,
  type GiftzPrefs,
} from "../src/components/bean/site/studio/prefs";

const KEYS = {
  customization: "bean:ws-prefs:customization",
  giftz: "bean:ws-prefs:giftz",
} as const;

/**
 * The prefs module reads window.localStorage (guarded for SSR). Bun's test
 * runtime has no DOM, so a minimal Web Storage shim is installed on
 * globalThis BEFORE EACH TEST and REMOVED AFTER EACH TEST — a module-level or
 * after-suite shim would leak `window` into other test files running in the
 * same bun process (bun runs every test file in one process) and break their
 * SSR-safety assumptions (e.g. lib/hash-router's module-level patch).
 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
const storage = new MemoryStorage();
const globalScope = globalThis as { window?: unknown; localStorage?: Storage };

function installShim() {
  globalScope.window = { localStorage: storage };
  globalScope.localStorage = storage as unknown as Storage;
}
function removeShim() {
  storage.clear();
  delete globalScope.window;
  delete globalScope.localStorage;
}

/** readModePrefs returns a union; CODE GIFTZ reads go through this guard. */
function readGiftz(): GiftzPrefs {
  const prefs = readModePrefs("giftz");
  if ("chatWidthPct" in prefs) return prefs;
  throw new Error("readModePrefs('giftz') did not return GiftzPrefs");
}

describe("studio mode prefs", () => {
  beforeEach(installShim);
  afterEach(removeShim);

  test("defaults are complete for both modes", () => {
    expect(DEFAULT_CUSTOMIZATION_PREFS.device).toBe("desktop");
    expect(DEFAULT_CUSTOMIZATION_PREFS.leftCollapsed).toBe(false);
    expect(DEFAULT_CUSTOMIZATION_PREFS.rightCollapsed).toBe(false);
    expect(DEFAULT_GIFTZ_PREFS.device).toBe("desktop");
    expect(DEFAULT_GIFTZ_PREFS.autoPreview).toBe(true);
    expect(DEFAULT_GIFTZ_PREFS.chatCollapsed).toBe(false);
    // Resizable workspace: the default chat share sits in the 36–42% band.
    expect(DEFAULT_GIFTZ_PREFS.chatWidthPct).toBe(DEFAULT_CHAT_WIDTH_PCT);
    expect(DEFAULT_CHAT_WIDTH_PCT).toBeGreaterThanOrEqual(36);
    expect(DEFAULT_CHAT_WIDTH_PCT).toBeLessThanOrEqual(42);
    expect(DEFAULT_GIFTZ_PREFS.enterToSend).toBe(true);
    expect(DEFAULT_GIFTZ_PREFS.confirmProposalSave).toBe(true);
    expect(DEFAULT_GIFTZ_PREFS.showFileInventory).toBe(true);
  });

  test("empty storage returns defaults for both modes", () => {
    const c = readModePrefs("customization");
    const g = readGiftz();
    expect(c.device).toBe("desktop");
    expect(g.autoPreview).toBe(true);
    expect(g.chatWidthPct).toBe(DEFAULT_CHAT_WIDTH_PCT);
  });

  test("writing Customization prefs never changes CODE GIFTZ prefs (separate keys)", () => {
    writeModePrefs("customization", { device: "tablet", leftCollapsed: true, rightCollapsed: true });
    const c = readModePrefs("customization");
    const g = readGiftz();
    expect(c.device).toBe("tablet");
    expect((c as { leftCollapsed: boolean }).leftCollapsed).toBe(true);
    // giftz untouched
    expect(g.device).toBe("desktop");
    expect(g.autoPreview).toBe(true);
    expect(g.chatCollapsed).toBe(false);
    expect(g.chatWidthPct).toBe(DEFAULT_CHAT_WIDTH_PCT);
  });

  test("writing CODE GIFTZ prefs never changes Customization prefs", () => {
    writeModePrefs("giftz", {
      ...DEFAULT_GIFTZ_PREFS,
      device: "mobile",
      autoPreview: false,
      chatCollapsed: true,
      chatWidthPct: 45,
      enterToSend: false,
      confirmProposalSave: false,
      showFileInventory: false,
    });
    const c = readModePrefs("customization");
    const g = readGiftz();
    expect(g.device).toBe("mobile");
    expect(g.autoPreview).toBe(false);
    expect(g.chatCollapsed).toBe(true);
    expect(g.chatWidthPct).toBe(45);
    expect(g.enterToSend).toBe(false);
    expect(g.confirmProposalSave).toBe(false);
    expect(g.showFileInventory).toBe(false);
    // customization untouched
    expect(c.device).toBe("desktop");
  });

  test("full round-trip preserves every CODE GIFTZ setting", () => {
    const next: GiftzPrefs = { ...DEFAULT_GIFTZ_PREFS, device: "tablet", autoPreview: false, enterToSend: false, chatWidthPct: 38 };
    writeModePrefs("giftz", next);
    expect(readGiftz()).toEqual(next);
  });

  test("chatWidthPct round-trips and clamps out-of-range values", () => {
    writeModePrefs("giftz", { ...DEFAULT_GIFTZ_PREFS, chatWidthPct: 41.5 });
    expect(readGiftz().chatWidthPct).toBe(41.5);
    // Below the hard floor → clamped up (the view applies px floors on top).
    writeModePrefs("giftz", { ...DEFAULT_GIFTZ_PREFS, chatWidthPct: 5 });
    expect(readGiftz().chatWidthPct).toBe(CHAT_WIDTH_PCT_MIN);
    // Above the hard ceiling → clamped down (the preview keeps its share).
    writeModePrefs("giftz", { ...DEFAULT_GIFTZ_PREFS, chatWidthPct: 90 });
    expect(readGiftz().chatWidthPct).toBe(CHAT_WIDTH_PCT_MAX);
    // Non-numeric garbage → default.
    localStorage.setItem(KEYS.giftz, JSON.stringify({ ...DEFAULT_GIFTZ_PREFS, chatWidthPct: "half" }));
    expect(readGiftz().chatWidthPct).toBe(DEFAULT_CHAT_WIDTH_PCT);
    // NaN → default.
    localStorage.setItem(KEYS.giftz, JSON.stringify({ ...DEFAULT_GIFTZ_PREFS, chatWidthPct: Number.NaN }));
    expect(readGiftz().chatWidthPct).toBe(DEFAULT_CHAT_WIDTH_PCT);
  });

  test("corrupted JSON falls back to defaults", () => {
    localStorage.setItem(KEYS.giftz, "{not json");
    const g = readGiftz();
    expect(g.device).toBe("desktop");
    expect(g.autoPreview).toBe(true);
  });

  test("invalid values fall back to per-field defaults", () => {
    localStorage.setItem(
      KEYS.giftz,
      JSON.stringify({ device: "fridge", autoPreview: "yes", enterToSend: 42 })
    );
    const g = readGiftz();
    expect(g.device).toBe("desktop");
    expect(g.autoPreview).toBe(true);
    expect(g.enterToSend).toBe(true);
  });

  test("resetModePrefs clears only that mode's key", () => {
    writeModePrefs("customization", { ...DEFAULT_CUSTOMIZATION_PREFS, device: "mobile" });
    writeModePrefs("giftz", { ...DEFAULT_GIFTZ_PREFS, device: "tablet" });
    resetModePrefs("customization");
    expect(readModePrefs("customization").device).toBe("desktop");
    expect(readModePrefs("giftz").device).toBe("tablet");
  });
});
