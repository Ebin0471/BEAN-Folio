"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";

/**
 * M31.10 — email-verification CONFIRMATION page (`#/verify-email`).
 *
 * The verification link delivered by email opens THIS page. The page itself
 * is completely non-mutating: automated link scanners and prefetchers that
 * GET the URL never verify anything. Verification happens ONLY when the user
 * explicitly chooses "Confirm email address" — a POST to
 * /api/auth/verify-email/confirm, which atomically consumes the single-use
 * token and marks the address verified.
 *
 * The token travels in the pre-hash query string (`?token=…#/verify-email`),
 * the same pattern as the Google OAuth callback signals (the hash router
 * strips fragment queries). Once read, the token is stripped from the address
 * bar so a refresh/re-prefetch never replays it visibly; the in-page state
 * drives the rest of the flow.
 */

type Phase = "ready" | "confirming" | "verified" | "failed" | "invalid" | "expired" | "consumed";

const STATUS_MESSAGES: Record<string, string> = {
  invalid: "This verification link is invalid or has expired. Request a fresh verification email from Settings or onboarding.",
  expired: "This verification link expired (links stay valid for 24 hours). Request a fresh verification email from Settings or onboarding.",
  consumed: "This verification link was already used. If your email is not yet verified, request a fresh one from Settings or onboarding.",
};

export default function VerifyEmailView() {
  // Read the pre-hash query (BEFORE the fragment — the hash router strips
  // fragment queries) ONCE at mount. Client-only initialization: on the
  // server there is no window, so state stays pending until hydration.
  // setState-in-effect is avoided — the token is consumed from the URL in
  // the lazy initializer and the address bar is cleaned in a write-only
  // effect below.
  const [boot] = useState(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const rawToken = params.get("token");
    const status = params.get("veStatus");
    const result: { token: string | null; phase: Phase } = (() => {
      if (rawToken && rawToken.length >= 16) return { token: rawToken, phase: "ready" as Phase };
      if (status && STATUS_MESSAGES[status]) return { token: null, phase: status as Phase };
      return { token: null, phase: "invalid" as Phase };
    })();
    // Strip the token/status from the address bar so a refresh or scanner
    // re-fetch never replays it visibly; the in-page state drives the rest.
    params.delete("token");
    params.delete("veStatus");
    const clean = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", clean);
    return result;
  });
  const [token, setToken] = useState<string | null>(boot?.token ?? null);
  const [phase, setPhase] = useState<Phase>(boot?.phase ?? "ready");
  const [serverMessage, setServerMessage] = useState<string | null>(null);

  // Hydration path: React does not re-run the lazy initializer after SSR, so
  // when the server pass could not see the URL (boot === null) the effect
  // re-reads it once the browser is live. Direct setState-in-effect is
  // avoided — the resolution is queued via microtask (rule-legal) and runs
  // before the next paint.
  useEffect(() => {
    if (boot !== null) return;
    const params = new URLSearchParams(window.location.search);
    const rawToken = params.get("token");
    const status = params.get("veStatus");
    let nextToken: string | null = null;
    let nextPhase: Phase = "invalid";
    if (rawToken && rawToken.length >= 16) {
      nextToken = rawToken;
      nextPhase = "ready";
    } else if (status && STATUS_MESSAGES[status]) {
      nextPhase = status as Phase;
    }
    params.delete("token");
    params.delete("veStatus");
    const clean = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", clean);
    queueMicrotask(() => {
      setToken(nextToken);
      setPhase(nextPhase);
    });
  }, [boot]);

  async function confirm() {
    if (!token || phase === "confirming" || phase === "verified") return;
    setPhase("confirming");
    setServerMessage(null);
    try {
      await api<{ verified: boolean }>("/api/auth/verify-email/confirm", {
        method: "POST",
        json: { token },
      });
      setPhase("verified");
      setToken(null); // single-use — the token is now consumed; drop it
    } catch (e) {
      setPhase("failed");
      setServerMessage(
        e instanceof Error && e.message
          ? e.message
          : "This verification link is invalid or has expired."
      );
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10 sm:py-16">
      <section
        aria-labelledby="verify-email-heading"
        className="rounded-xl border border-border/60 bg-card p-4 sm:p-6"
      >
        <div className="mb-4 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-gold-soft/40 text-sm font-semibold text-primary"
          >
            @
          </span>
          <div>
            <h1 id="verify-email-heading" className="text-base font-semibold text-foreground">
              Email verification
            </h1>
            <p className="text-xs text-muted-foreground">Confirming your address is one explicit click.</p>
          </div>
        </div>

        {phase === "ready" && token && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Choose <strong className="text-foreground">Confirm email address</strong> below to verify
              this address for your BEAN Folio account. The link can be used once and expires 24 hours
              after it was issued.
            </p>
            <button
              type="button"
              onClick={confirm}
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Confirm email address
            </button>
            <p className="text-xs text-muted-foreground">
              Opening this page never verifies anything — only the explicit confirmation does. If you
              did not request this, you can safely close this page.
            </p>
          </div>
        )}

        {phase === "confirming" && (
          <p className="text-sm text-muted-foreground" role="status">
            Confirming your email address…
          </p>
        )}

        {phase === "verified" && (
          <div className="space-y-3" role="status">
            <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
              Your email address is verified. Thank you.
            </p>
            <p className="text-sm text-muted-foreground">
              You can close this page and continue in BEAN Folio — trust-gated actions such as external
              outreach and invitations are now available to your account.
            </p>
            <a
              href="#/"
              className="inline-block rounded-lg border border-border/60 bg-background/40 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
            >
              Go to BEAN Folio
            </a>
          </div>
        )}

        {(phase === "failed" || phase === "invalid" || phase === "expired" || phase === "consumed") && (
          <div className="space-y-3" role="alert">
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {phase === "failed"
                ? serverMessage ?? "This verification link is invalid or has expired."
                : STATUS_MESSAGES[phase]}
            </p>
            <p className="text-xs text-muted-foreground">
              Request a fresh verification email from Settings (signed in) or from the onboarding
              verification banner — then open the newest link and confirm here.
            </p>
            <a
              href="#/auth"
              className="inline-block rounded-lg border border-border/60 bg-background/40 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
            >
              Go to sign in
            </a>
          </div>
        )}
      </section>
    </main>
  );
}
