"use client";

/**
 * Sharing helpers for public URLs (Copy Link / Share actions).
 *
 * Both helpers are honest about failure: they never report success unless the
 * underlying browser API (or fallback) actually completed. `navigator.clipboard`
 * exists only in secure contexts; on insecure origins (plain http previews) the
 * hidden-textarea execCommand fallback is used, and if that fails too the
 * caller shows a real error — the URL is also always visible in the publish
 * dialog so it can be selected manually.
 */

/** Copy text to the clipboard. Resolves true only when something was copied. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined" || !text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (permission denial / insecure context)
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export type ShareOutcome = "shared" | "copied" | "failed";

/**
 * Share a URL via the Web Share API when available (mobile / installed PWAs);
 * otherwise copy it and report "copied" so the caller can confirm what really
 * happened. "failed" means neither channel worked — never fake success.
 */
export async function shareUrl(url: string, title: string, text?: string): Promise<ShareOutcome> {
  if (typeof window === "undefined" || !url) return "failed";
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ url, title, ...(text ? { text } : {}) });
      return "shared";
    } catch (e) {
      // A user-cancelled share (AbortError) is not a failure — but there is
      // nothing to confirm either, so treat it as "nothing happened".
      if (e instanceof DOMException && e.name === "AbortError") return "failed";
      // Real share errors fall through to the clipboard fallback.
    }
  }
  return (await copyToClipboard(url)) ? "copied" : "failed";
}
