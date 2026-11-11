"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Wordmark } from "@/components/bean/Wordmark";
import { api } from "@/lib/client";
import { navigate, takeReturnTo } from "@/lib/hash-router";
import { useSession } from "@/lib/session";

type Mode = "signin" | "register";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Google OAuth outcome messages. The callback redirects back with
 * `?googleError=<code>` (BEFORE the hash — the hash router strips fragment
 * queries). Mapped here honestly; never a raw provider error string.
 */
const GOOGLE_ERROR_MESSAGES: Record<string, { kind: "info" | "error"; text: string }> = {
  cancelled: { kind: "info", text: "Google sign-in was cancelled — you can try again any time." },
  disabled: { kind: "info", text: "Google sign-in isn't configured on this deployment yet. Use email and password below." },
  state: { kind: "error", text: "We couldn't verify this sign-in attempt — the link expired or was already used. Please start again." },
  invalid: { kind: "error", text: "Google's confirmation failed our security checks, so sign-in was refused. Please try again." },
  expired: { kind: "error", text: "The sign-in confirmation expired before it reached us. Please try again." },
  unverified: { kind: "error", text: "Google hasn't verified the email on that account, so it can't be used to sign in. Use email and password instead." },
  provider: { kind: "error", text: "Google sign-in is temporarily unavailable — please try again in a moment." },
  mismatch: { kind: "error", text: "You're signed in as a different account. Sign out first, then connect Google from the right account." },
  conflict: { kind: "error", text: "A different Google account is already linked to this email address." },
  deleted: { kind: "error", text: "That folio no longer exists, so it can't be signed into." },
};

/** Official multi-color Google "G" mark (brand guideline SVG paths). */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.44.35-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

export default function AuthView() {
  const { user, loading, refresh } = useSession();

  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);

  // ---- Recovery key (registration): shown once, explicit acknowledgement required
  const [pendingRecoveryKey, setPendingRecoveryKey] = useState<string | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);
  // Where to go after the recovery-key dialog is acknowledged (null = stay).
  const postKeyNavRef = useRef<string | null>(null);

  // ---- Forgot password (two-step dialog)
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotStep, setForgotStep] = useState<"request" | "reset" | "done">("request");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotKey, setForgotKey] = useState("");
  const [forgotToken, setForgotToken] = useState<string | null>(null);
  const [forgotNew1, setForgotNew1] = useState("");
  const [forgotNew2, setForgotNew2] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  // ---- Google OAuth: availability (server truth via /api/auth/google/status),
  // outcome messages and busy state. The button is ALWAYS visible on both
  // tabs; without credentials it is disabled with an honest message and can
  // never start a broken flow — only a server-reported valid configuration
  // enables it.
  const [googleStatus, setGoogleStatus] = useState<"checking" | "unconfigured" | "enabled">("checking");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleNotice, setGoogleNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ enabled: boolean; redirectUri: string }>("/api/auth/google/status")
      .then((res) => {
        if (!cancelled) setGoogleStatus(res.enabled ? "enabled" : "unconfigured");
      })
      .catch(() => {
        // Status unavailable → treat as unconfigured: the button stays
        // disabled (it can never send anyone into a broken OAuth flow).
        if (!cancelled) setGoogleStatus("unconfigured");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Consume the OAuth callback signals (search params BEFORE the hash — the
  // hash router strips fragment queries) once on mount, then strip them from
  // the address bar so a refresh never replays the message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errCode = params.get("googleError");
    const linkPending = params.get("googleLink") === "1";
    if (!errCode && !linkPending) return;
    if (errCode) {
      setGoogleNotice(GOOGLE_ERROR_MESSAGES[errCode] ?? {
        kind: "error",
        text: "Google sign-in could not be completed. Please try again.",
      });
    }
    if (linkPending) {
      setMode("signin");
      setGoogleNotice({
        kind: "info",
        text: "One-time security step: sign in with your password below to link your Google account. After that, Continue with Google works directly.",
      });
    }
    params.delete("googleError");
    params.delete("googleLink");
    const clean = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", clean);
  }, []);

  function startGoogle() {
    // Only a server-confirmed configuration may start the flow.
    if (googleBusy || googleStatus !== "enabled") return;
    setGoogleBusy(true);
    // Full-page navigation to the authorize endpoint (no fetch — the flow is a
    // top-level redirect; no Google token ever reaches JavaScript).
    if (window.self !== window.top) {
      // Embedded preview frames can't host Google's consent page — open the
      // flow in a real tab instead of failing inside the frame.
      window.open("/api/auth/google", "_blank", "noopener");
      setGoogleBusy(false);
    } else {
      window.location.href = "/api/auth/google";
    }
  }

  // Whether the visitor was ALREADY signed in when this view mounted. Only
  // that case auto-redirects — the effect must never fight the navigation
  // performed after a successful sign-in/registration below.
  const mountedSignedInRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (loading) return;
    if (mountedSignedInRef.current === null) mountedSignedInRef.current = Boolean(user);
    if (mountedSignedInRef.current && !busy) navigate(takeReturnTo("/"));
  }, [loading, user, busy]);

  function validate(): boolean {
    const next: FieldErrors = {};
    if (mode === "register" && !name.trim()) next.name = "Tell us your name — it appears on your public folio.";
    if (!email.trim()) next.email = "Email is required.";
    else if (!EMAIL_RE.test(email.trim())) next.email = "That email address does not look right.";
    if (!password) next.password = "Password is required.";
    else if (mode === "register" && password.length < 8) next.password = "Use at least 8 characters.";
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setServerError(null);
    if (!validate()) return;
    setBusy(true);
    let newRecoveryKey: string | null = null;
    try {
      if (mode === "signin") {
        await api("/api/auth/login", {
          method: "POST",
          json: { email: email.trim(), password },
        });
      } else {
        const res = await api<{ recoveryKey?: string }>("/api/auth/register", {
          method: "POST",
          json: { email: email.trim(), password, name: name.trim() },
        });
        if (res.recoveryKey) newRecoveryKey = res.recoveryKey;
      }
      // The auth operation "succeeded" only if the session is now resolvable.
      // If the browser refused to keep the cookie (e.g. a third-party/preview
      // context blocking it), say so plainly instead of faking a signed-in UI.
      const me = await refresh();
      if (!me) {
        setServerError(
          mode === "signin"
            ? "Your credentials were accepted, but this browser is not keeping the session cookie. If you are inside an embedded preview, open BEAN Folio in a new tab and sign in again."
            : "Your account was created, but this browser is not keeping the session cookie. If you are inside an embedded preview, open BEAN Folio in a new tab and sign in."
        );
        if (!newRecoveryKey) return;
        // Still show the recovery key — it is displayed exactly once.
        postKeyNavRef.current = null;
      } else {
        toast.success(mode === "signin" ? "Welcome back" : "Account created");
        postKeyNavRef.current = mode === "signin" ? takeReturnTo("/") : "/onboarding";
      }
      if (newRecoveryKey) {
        // Registration continues ONLY after the key is acknowledged as saved.
        setPendingRecoveryKey(newRecoveryKey);
        setRecoveryAck(false);
        return;
      }
      // Registration continues into profile setup explicitly; sign-in returns
      // to the destination stored by the gate that sent the visitor here.
      navigate(mode === "signin" ? takeReturnTo("/") : "/onboarding");
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  // ---- Forgot password handlers -------------------------------------------------

  async function onRequestReset(e: React.FormEvent) {
    e.preventDefault();
    if (forgotBusy) return;
    setForgotError(null);
    if (!EMAIL_RE.test(forgotEmail.trim())) {
      setForgotError("Enter the email address on your account.");
      return;
    }
    if (!forgotKey.trim()) {
      setForgotError("Enter your recovery key.");
      return;
    }
    setForgotBusy(true);
    try {
      const res = await api<{ resetToken: string }>("/api/auth/recover/request", {
        method: "POST",
        json: { email: forgotEmail.trim(), recoveryKey: forgotKey.trim() },
      });
      setForgotToken(res.resetToken);
      setForgotStep("reset");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setForgotBusy(false);
    }
  }

  async function onPerformReset(e: React.FormEvent) {
    e.preventDefault();
    if (forgotBusy || !forgotToken) return;
    setForgotError(null);
    if (forgotNew1.length < 8) {
      setForgotError("Use at least 8 characters.");
      return;
    }
    if (forgotNew1 !== forgotNew2) {
      setForgotError("The two passwords don't match.");
      return;
    }
    setForgotBusy(true);
    try {
      await api("/api/auth/recover/reset", {
        method: "POST",
        json: { resetToken: forgotToken, newPassword: forgotNew1 },
      });
      setForgotStep("done");
    } catch (err) {
      setForgotError(err instanceof Error ? err.message : "Something went wrong — please try again.");
    } finally {
      setForgotBusy(false);
    }
  }

  function closeForgot(reset: boolean) {
    setForgotOpen(false);
    setForgotError(null);
    setForgotKey("");
    setForgotNew1("");
    setForgotNew2("");
    setForgotToken(null);
    setForgotStep("request");
    if (reset) setForgotEmail("");
  }

  const emailErrorId = "auth-email-error";
  const passwordErrorId = "auth-password-error";
  const nameErrorId = "auth-name-error";

  return (
    <div className="mx-auto flex min-h-[72vh] w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Wordmark symbol="always" />
          <h1 className="text-balance font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Show your work. <span className="text-primary">Find your people.</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your studio, or create a free folio in under a minute.
          </p>
        </div>

        <div className="rounded-xl border border-border/60 bg-card p-4 sm:p-6">
          {googleNotice && (
            <p
              role={googleNotice.kind === "error" ? "alert" : "status"}
              className={
                googleNotice.kind === "error"
                  ? "mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  : "mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground"
              }
            >
              {googleNotice.text}
            </p>
          )}
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as Mode);
              setServerError(null);
              setFieldErrors({});
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="signin" className="flex-1">
                Sign in
              </TabsTrigger>
              <TabsTrigger value="register" className="flex-1">
                Create account
              </TabsTrigger>
            </TabsList>

            {/* -------------------------------------------------- sign in */}
            <TabsContent value="signin">
              <form onSubmit={onSubmit} className="mt-2 space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="signin-email">Email</Label>
                  <Input
                    id="signin-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@studio.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={fieldErrors.email ? emailErrorId : undefined}
                    className="h-11"
                  />
                  {fieldErrors.email && (
                    <p id={emailErrorId} className="text-xs text-destructive">
                      {fieldErrors.email}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="signin-password">Password</Label>
                  <div className="relative">
                    <Input
                      id="signin-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      aria-invalid={Boolean(fieldErrors.password)}
                      aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
                      className="h-11 pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                    </button>
                  </div>
                  {fieldErrors.password && (
                    <p id={passwordErrorId} className="text-xs text-destructive">
                      {fieldErrors.password}
                    </p>
                  )}
                </div>

                {serverError && (
                  <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {serverError}
                  </p>
                )}

                <Button type="submit" disabled={busy} className="h-11 w-full">
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {busy ? "Signing in…" : "Sign in"}
                </Button>

                <button
                  type="button"
                  onClick={() => {
                    setForgotEmail(email.trim());
                    setForgotStep("request");
                    setForgotError(null);
                    setForgotOpen(true);
                  }}
                  className="mx-auto block text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  Forgot password?
                </button>

                {process.env.NODE_ENV === "development" && (
                  <button
                    type="button"
                    onClick={() => {
                      setEmail("demo@beanfolio.app");
                      setPassword("demo1234");
                    }}
                    className="w-full rounded-lg border border-border/60 bg-background/40 px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    <span className="font-medium text-foreground">Just exploring?</span> Fill the demo account
                    <span className="mt-0.5 block">
                      demo@beanfolio.app · demo1234 — a fixture profile with sample projects (marked as demo data).
                    </span>
                  </button>
                )}
              </form>
            </TabsContent>

            {/* ------------------------------------------------- register */}
            <TabsContent value="register">
              <form onSubmit={onSubmit} className="mt-2 space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="register-name">Name</Label>
                  <Input
                    id="register-name"
                    type="text"
                    autoComplete="name"
                    placeholder="Ada Okafor"
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.name)}
                    aria-describedby={fieldErrors.name ? nameErrorId : undefined}
                    className="h-11"
                  />
                  {fieldErrors.name && (
                    <p id={nameErrorId} className="text-xs text-destructive">
                      {fieldErrors.name}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="register-email">Email</Label>
                  <Input
                    id="register-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@studio.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.email)}
                    aria-describedby={fieldErrors.email ? emailErrorId : undefined}
                    className="h-11"
                  />
                  {fieldErrors.email && (
                    <p id={emailErrorId} className="text-xs text-destructive">
                      {fieldErrors.email}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="register-password">Password</Label>
                  <Input
                    id="register-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={Boolean(fieldErrors.password)}
                    aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
                    className="h-11"
                  />
                  {fieldErrors.password ? (
                    <p id={passwordErrorId} className="text-xs text-destructive">
                      {fieldErrors.password}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Use at least 8 characters — a passphrase works well.</p>
                  )}
                </div>

                {serverError && (
                  <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {serverError}
                  </p>
                )}

                <Button type="submit" disabled={busy} className="h-11 w-full">
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {busy ? "Creating your folio…" : "Create account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          {/* Google OAuth — offered on BOTH tabs and ALWAYS visible. The
              server (/api/auth/google/status) is the single source of truth:
              without credentials the button is disabled with an honest message
              and never starts a flow; with credentials it initiates the
              top-level redirect (PKCE + OIDC — no Google token ever reaches
              this page). */}
          <div className="mt-5 flex items-center gap-3" aria-hidden>
            <div className="h-px flex-1 bg-border" />
            <span className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">OR</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="mt-4 h-11 w-full bg-background"
            disabled={googleStatus !== "enabled" || googleBusy}
            onClick={startGoogle}
          >
            {googleBusy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <GoogleMark className="size-4" />
            )}
            Continue with Google
          </Button>
          {googleStatus === "unconfigured" && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Google sign-in is not configured yet.
            </p>
          )}
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
          Sessions are cookie-based and can be revoked any time from Trust &amp; settings.
        </p>
      </motion.div>

      {/* ------------------------------------ recovery key (registration, once) */}
      <Dialog
        open={Boolean(pendingRecoveryKey)}
        onOpenChange={(open) => {
          // Never dismiss by clicking outside — the key is shown exactly once,
          // so dismissal must be an explicit acknowledgement.
          if (!open && !recoveryAck) return;
          if (!open) {
            setPendingRecoveryKey(null);
            setRecoveryAck(false);
            navigate(postKeyNavRef.current ?? "/");
            postKeyNavRef.current = null;
          }
        }}
      >
        <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" aria-hidden /> Save your recovery key
            </DialogTitle>
            <DialogDescription>
              If you ever lose your password, this key is the only way back into your account. BEAN Folio stores no
              copy of it — this is the only time it is ever shown.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-center">
            <p className="select-all break-all font-mono text-base font-semibold tracking-[0.18em] text-foreground">
              {pendingRecoveryKey}
            </p>
          </div>
          <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <li>• Write it down or store it in a password manager — not just in this browser.</li>
            <li>• It is separate from your password. Knowing one never reveals the other.</li>
            <li>• You can replace it later from Trust &amp; settings → Recovery key.</li>
          </ul>
          <label className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
            <Checkbox
              checked={recoveryAck}
              onCheckedChange={(v) => setRecoveryAck(v === true)}
              className="mt-0.5"
              aria-label="I have saved my recovery key somewhere safe"
            />
            <span className="leading-snug">I&apos;ve saved my recovery key somewhere safe.</span>
          </label>
          <Button
            className="w-full"
            disabled={!recoveryAck}
            onClick={() => {
              setPendingRecoveryKey(null);
              setRecoveryAck(false);
              navigate(postKeyNavRef.current ?? "/");
              postKeyNavRef.current = null;
            }}
          >
            Continue
          </Button>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------------- forgot password (2-step) */}
      <Dialog open={forgotOpen} onOpenChange={(open) => { if (!open) closeForgot(false); }}>
        <DialogContent className="sm:max-w-md">
          {forgotStep === "request" && (
            <>
              <DialogHeader>
                <DialogTitle>Reset your password</DialogTitle>
                <DialogDescription>
                  Enter the email on your account and your recovery key — the one you saved when you joined. Both are
                  verified together before a reset can start.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={onRequestReset} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="forgot-email">Email</Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forgot-key">Recovery key</Label>
                  <Input
                    id="forgot-key"
                    type="text"
                    autoComplete="off"
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                    value={forgotKey}
                    onChange={(e) => setForgotKey(e.target.value)}
                    className="h-11 font-mono tracking-wider"
                  />
                </div>
                {forgotError && (
                  <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {forgotError}
                  </p>
                )}
                <Button type="submit" disabled={forgotBusy} className="h-11 w-full">
                  {forgotBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {forgotBusy ? "Verifying…" : "Verify recovery key"}
                </Button>
              </form>
            </>
          )}

          {forgotStep === "reset" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" aria-hidden /> Verified — set a new password
                </DialogTitle>
                <DialogDescription>
                  Your email and recovery key match. Choose a new password. When it is saved, all existing sessions on
                  your account are signed out.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={onPerformReset} className="space-y-4" noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="forgot-new1">New password</Label>
                  <Input
                    id="forgot-new1"
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={forgotNew1}
                    onChange={(e) => setForgotNew1(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forgot-new2">Confirm new password</Label>
                  <Input
                    id="forgot-new2"
                    type="password"
                    autoComplete="new-password"
                    value={forgotNew2}
                    onChange={(e) => setForgotNew2(e.target.value)}
                    className="h-11"
                  />
                </div>
                {forgotError && (
                  <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {forgotError}
                  </p>
                )}
                <Button type="submit" disabled={forgotBusy} className="h-11 w-full">
                  {forgotBusy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {forgotBusy ? "Saving…" : "Save new password"}
                </Button>
              </form>
            </>
          )}

          {forgotStep === "done" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-primary" aria-hidden /> Password updated
                </DialogTitle>
                <DialogDescription>
                  Your password has been changed and previous sessions were signed out. Sign in with your new
                  password.
                </DialogDescription>
              </DialogHeader>
              <Button
                className="w-full"
                onClick={() => {
                  setEmail(forgotEmail.trim());
                  setPassword("");
                  closeForgot(false);
                  setMode("signin");
                }}
              >
                Back to sign in
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
