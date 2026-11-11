"use client";

/**
 * Studio mode preferences — INDEPENDENT settings for the two top-level
 * Website Studio modes.
 *
 * Customization (free visual editor) and CODE GIFTZ (AI coding workspace)
 * each own their own persisted preference set under SEPARATE localStorage
 * keys. Changing a control in one mode can never write the other mode's
 * state, and switching tabs preserves each mode's UI state exactly.
 *
 * What is intentionally NOT here: the website draft itself. Both modes edit
 * the SAME SiteConfig (one authenticated portfolio identity — duplicating it
 * would fork the user's website). Only mode-owned UI settings live here.
 *
 * Keys (namespaced per mode, never shared):
 *   bean:ws-prefs:customization  → CustomizationPrefs
 *   bean:ws-prefs:giftz          → GiftzPrefs
 */

export type StudioDevice = "desktop" | "tablet" | "mobile";

/** Free visual editor — presentation editing preferences. */
export interface CustomizationPrefs {
  /** Which viewport the Customization canvas renders at. */
  device: StudioDevice;
  /** LEFT workspace panel (content editor) collapsed for more canvas width. */
  leftCollapsed: boolean;
  /** RIGHT workspace panel (design studio) collapsed for more canvas width. */
  rightCollapsed: boolean;
}

/**
 * AI coding workspace — chat / generation / preview / validation / draft
 * preferences. Every field is wired to a REAL behavior in the CODE GIFTZ
 * workspace; nothing here is decorative.
 */
export interface GiftzPrefs {
  /** Which viewport the generated-website preview renders at. */
  device: StudioDevice;
  /** Render a finished proposal in the Preview workspace automatically. */
  autoPreview: boolean;
  /** LEFT workspace panel (chat) collapsed for more preview width. */
  chatCollapsed: boolean;
  /**
   * Chat/preview split — the chat region's share of the workspace width (%).
   * The divider persists this during the editing session (and beyond, like
   * every other mode pref). Clamped on read AND at drag time so the chat can
   * never shrink below a usable width and the preview never loses its
   * minimum inspectable size (px guards are applied in the view, which knows
   * the real container width).
   */
  chatWidthPct: number;
  /** Chat: Enter sends the message (off = Enter breaks the line, Ctrl/Cmd+Enter sends). */
  enterToSend: boolean;
  /** Draft safety: confirm before a generated website overwrites the saved draft. */
  confirmProposalSave: boolean;
  /** Validation: show the per-file changed-file inventory on proposal cards. */
  showFileInventory: boolean;
}

/** Default chat share of the workspace width (spec: ~36–42%). */
export const DEFAULT_CHAT_WIDTH_PCT = 40;
/** Hard bounds of the persisted share — px guards refine these in the view. */
export const CHAT_WIDTH_PCT_MIN = 32;
export const CHAT_WIDTH_PCT_MAX = 55;

export const DEFAULT_CUSTOMIZATION_PREFS: CustomizationPrefs = {
  device: "desktop",
  leftCollapsed: false,
  rightCollapsed: false,
};
export const DEFAULT_GIFTZ_PREFS: GiftzPrefs = {
  device: "desktop",
  autoPreview: true,
  chatCollapsed: false,
  chatWidthPct: DEFAULT_CHAT_WIDTH_PCT,
  enterToSend: true,
  confirmProposalSave: true,
  showFileInventory: true,
};

const KEYS = {
  customization: "bean:ws-prefs:customization",
  giftz: "bean:ws-prefs:giftz",
} as const;

export type StudioModeKey = keyof typeof KEYS;

const DEVICES: StudioDevice[] = ["desktop", "tablet", "mobile"];

function readJson<T>(key: string, fallback: T, validate: (v: unknown) => T | null): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    const valid = validate(parsed);
    return valid ?? fallback;
  } catch {
    return fallback;
  }
}

function validateDevice(v: unknown): StudioDevice | null {
  return typeof v === "string" && (DEVICES as string[]).includes(v) ? (v as StudioDevice) : null;
}

function validateBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Read one mode's persisted prefs (client only; SSR-safe). */
export function readModePrefs(mode: StudioModeKey): CustomizationPrefs | GiftzPrefs {
  if (mode === "customization") {
    const raw = readJson<Partial<CustomizationPrefs>>(KEYS.customization, {}, (v) =>
      v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<CustomizationPrefs>) : null
    );
    return {
      device: validateDevice(raw.device) ?? DEFAULT_CUSTOMIZATION_PREFS.device,
      leftCollapsed: validateBool(raw.leftCollapsed, DEFAULT_CUSTOMIZATION_PREFS.leftCollapsed),
      rightCollapsed: validateBool(raw.rightCollapsed, DEFAULT_CUSTOMIZATION_PREFS.rightCollapsed),
    };
  }
  const raw = readJson<Partial<GiftzPrefs>>(KEYS.giftz, {}, (v) =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Partial<GiftzPrefs>) : null
  );
  const rawPct = typeof raw.chatWidthPct === "number" && Number.isFinite(raw.chatWidthPct) ? raw.chatWidthPct : null;
  const clamp = (n: number) => Math.min(CHAT_WIDTH_PCT_MAX, Math.max(CHAT_WIDTH_PCT_MIN, n));
  return {
    device: validateDevice(raw.device) ?? DEFAULT_GIFTZ_PREFS.device,
    autoPreview: validateBool(raw.autoPreview, DEFAULT_GIFTZ_PREFS.autoPreview),
    chatCollapsed: validateBool(raw.chatCollapsed, DEFAULT_GIFTZ_PREFS.chatCollapsed),
    chatWidthPct: rawPct === null ? DEFAULT_GIFTZ_PREFS.chatWidthPct : clamp(rawPct),
    enterToSend: validateBool(raw.enterToSend, DEFAULT_GIFTZ_PREFS.enterToSend),
    confirmProposalSave: validateBool(raw.confirmProposalSave, DEFAULT_GIFTZ_PREFS.confirmProposalSave),
    showFileInventory: validateBool(raw.showFileInventory, DEFAULT_GIFTZ_PREFS.showFileInventory),
  };
}

/** Persist one mode's prefs — writes ONLY that mode's key. */
export function writeModePrefs(mode: StudioModeKey, prefs: CustomizationPrefs | GiftzPrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEYS[mode], JSON.stringify(prefs));
  } catch {
    /* storage full/unavailable — prefs stay session-only */
  }
}

/** Clear one mode's prefs back to defaults (used when storage is corrupted). */
export function resetModePrefs(mode: StudioModeKey): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEYS[mode]);
  } catch {
    /* ignore */
  }
}
