"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Download,
  Flag,
  KeyRound,
  Loader2,
  ScrollText,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

// ------------------------------------------------------------------ recovery key

/**
 * Recovery-key setup / rotation (Trust & settings → Recovery key).
 * Requires password reauthentication; the generated key is displayed exactly
 * once and acknowledged as saved before the dialog can be completed. The
 * server stores only a hash — "view my key again" is impossible by design.
 */
function RecoveryKeySection() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [setAt, setSetAt] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<"password" | "reveal">("password");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ hasRecoveryKey: boolean; setAt: string | null }>("/api/me/recovery-key")
      .then((r) => {
        if (!alive) return;
        setHasKey(r.hasRecoveryKey);
        setSetAt(r.setAt);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dialogOpen]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryKey: string; rotated: boolean }>("/api/me/recovery-key", {
        method: "POST",
        json: { currentPassword: password },
      });
      setNewKey(res.recoveryKey);
      setRotated(res.rotated);
      setAck(false);
      setStep("reveal");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    setDialogOpen(false);
    setStep("password");
    setPassword("");
    setError(null);
    setNewKey(null);
    setRotated(false);
    setAck(false);
  }

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-foreground">
          <KeyRound className="size-4 text-primary" aria-hidden /> Recovery key
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          A unique key that regains access to your account if you ever lose your password. BEAN Folio stores no copy —
          the key is shown exactly once, when it is created.
        </p>
        <Separator className="my-4" />
        {hasKey === null ? (
          <p className="text-sm text-muted-foreground">Checking recovery-key status…</p>
        ) : hasKey ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div>
                <p className="font-medium text-foreground">Recovery key active</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {setAt ? `Set up ${formatDateTime(setAt)}. ` : ""}
                  Only a hash is stored — the key itself can never be viewed again. Rotate it if you think it may be
                  compromised or lost; the previous key stops working immediately.
                </p>
              </div>
            </div>
            <Button variant="outline" className="shrink-0" onClick={() => { setStep("password"); setDialogOpen(true); }}>
              Rotate key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 rounded-lg border border-dashed border-border/60 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <div>
                <p className="font-medium text-foreground">No recovery key yet</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  If you lose your password, a recovery key is the only way back into your account. Set one up now and
                  keep it somewhere safe.
                </p>
              </div>
            </div>
            <Button className="shrink-0" onClick={() => { setStep("password"); setDialogOpen(true); }}>
              Set up recovery key
            </Button>
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
          <DialogContent className="sm:max-w-md">
            {step === "password" && (
              <>
                <DialogHeader>
                  <DialogTitle>{hasKey ? "Rotate recovery key" : "Set up recovery key"}</DialogTitle>
                  <DialogDescription>
                    Confirm your password to continue.
                    {hasKey && " Rotating invalidates your previous key immediately — the old key will no longer work."}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={submitPassword} className="space-y-4" noValidate>
                  <div className="space-y-1.5">
                    <Label htmlFor="recovery-password">Current password</Label>
                    <Input
                      id="recovery-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="h-11"
                    />
                  </div>
                  {error && (
                    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  <Button type="submit" disabled={busy || !password} className="h-11 w-full">
                    {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {busy ? "Verifying…" : "Continue"}
                  </Button>
                </form>
              </>
            )}
            {step === "reveal" && newKey && (
              <>
                <DialogHeader>
                  <DialogTitle>{rotated ? "Your new recovery key" : "Your recovery key"}</DialogTitle>
                  <DialogDescription>
                    {rotated
                      ? "Your previous key no longer works. Save this new key now — it is shown only this once."
                      : "Save this key now — it is shown only this once and cannot be recovered later."}
                  </DialogDescription>
                </DialogHeader>
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-center">
                  <p className="select-all break-all font-mono text-base font-semibold tracking-[0.18em] text-foreground">
                    {newKey}
                  </p>
                </div>
                <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                  <li>• Write it down or store it in a password manager — not just in this browser.</li>
                  <li>• BEAN Folio stores no copy and will never ask you to type it here.</li>
                </ul>
                <label className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
                  <Checkbox
                    checked={ack}
                    onCheckedChange={(v) => setAck(v === true)}
                    className="mt-0.5"
                    aria-label="I have saved my recovery key somewhere safe"
                  />
                  <span className="leading-snug">I&apos;ve saved my recovery key somewhere safe.</span>
                </label>
                {error && (
                  <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                )}
                <Button
                  className="w-full"
                  disabled={!ack}
                  onClick={() => {
                    closeDialog();
                    toast.success(rotated ? "Recovery key rotated" : "Recovery key set up");
                  }}
                >
                  Done
                </Button>
              </>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString(
      "en-US",
      { hour: "numeric", minute: "2-digit" }
    )}`;
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ danger zone

function DeleteAccountDialog() {
  const { refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // Password re-auth is required by the API (Phase 6); the button stays
  // disabled until the confirmation word matches AND a password is entered.
  const canDelete = confirmText.trim() === "DELETE" && password.length > 0;

  const confirmDelete = async () => {
    if (!canDelete || busy) return;
    setBusy(true);
    try {
      await api("/api/me/deletion", {
        method: "POST",
        json: { reason: reason.trim() || undefined, currentPassword: password },
      });
      await refresh();
      toast.success("Account deleted");
      setOpen(false);
      navigate("/");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirmText("");
          setReason("");
          setPassword("");
        }
      }}
    >
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 className="size-4" aria-hidden /> Delete my account
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display">Delete your account?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <p>This is permanent and cannot be undone. Right now it means:</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                <li className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                  Your profile is hidden immediately and all sessions are signed out.
                </li>
                <li className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                  Your username is released and can be claimed by someone else.
                </li>
                <li className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                  Your personal data is anonymized now and scheduled for deletion; projects won&apos;t be recoverable.
                </li>
              </ul>
              <p className="mt-3">
                If you just want a copy of your data first, use <span className="text-foreground">Download my data</span>{" "}
                above — it runs instantly.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="delete-reason">Reason (optional, helps us improve)</Label>
            <Input
              id="delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={280}
              placeholder="e.g. I'm moving to another platform"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delete-password">Confirm your password</Label>
            <Input
              id="delete-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your current password"
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono font-semibold text-foreground">DELETE</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              aria-describedby="delete-confirm-hint"
            />
            <p id="delete-confirm-hint" className="text-xs text-muted-foreground">
              The button stays disabled until the word matches exactly.
            </p>
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40"
            disabled={!canDelete || busy}
            onClick={(e) => {
              e.preventDefault(); // keep the dialog open until the API confirms
              void confirmDelete();
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {busy ? "Deleting…" : "Permanently delete my account"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DangerZone() {
  const [exporting, setExporting] = useState(false);

  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { job } = await api<{ job: { id: string; status: string } }>("/api/me/export", { method: "POST" });

      // The backend fills the payload synchronously; poll briefly in case it lands as PROCESSING.
      let payload: string | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const res = await api<{ job: { status: string; payload: string | null } }>(`/api/me/export/${job.id}`);
        if (res.job.status === "READY" && res.job.payload) {
          payload = res.job.payload;
          break;
        }
        if (res.job.status === "FAILED") break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!payload) {
        toast.error("Your export couldn't be prepared right now. Please try again shortly.");
        return;
      }

      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "beanfolio-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Your data export has been downloaded as JSON");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card className="border-destructive/45">
      <CardContent className="p-6">
        <h2 className="font-display text-lg font-semibold text-foreground">Danger zone</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">Irreversible actions. Please be certain.</p>

        <Separator className="my-4" />

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Download my data</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              A complete JSON export of your account, projects, collections and activity.
            </p>
          </div>
          <Button variant="outline" className="shrink-0" onClick={() => void exportData()} disabled={exporting}>
            {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            {exporting ? "Preparing…" : "Download my data"}
          </Button>
        </div>

        <div className="mt-4 flex flex-col gap-4 border-t border-destructive/20 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Delete my account</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Hides your profile immediately, releases your username and schedules data deletion.
            </p>
          </div>
          <DeleteAccountDialog />
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ audit log

interface AuditEvent {
  action: string;
  targetType: string;
  targetId: string;
  createdAt: string;
}

function ActivityLog() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ events: AuditEvent[] }>("/api/me/audit");
      setEvents(res.events);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return <p className="text-sm text-muted-foreground">No recorded activity yet. Privacy changes, exports and sign-ins will be listed here.</p>;
  }

  return (
    <ul className="max-h-96 space-y-1.5 overflow-y-auto pr-1" aria-label="Account activity log">
      {events.map((e, i) => (
        <li
          key={`${e.createdAt}-${e.action}-${i}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
            <span className="truncate font-mono text-xs text-foreground">{e.action}</span>
            {e.targetType && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">· {e.targetType.toLowerCase()}</span>}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ view

export default function SettingsView() {
  const { user, refresh } = useSession();

  // Local mirrors of privacy settings, synced from the session user.
  const [visibility, setVisibility] = useState<string>(user?.profileVisibility ?? "PUBLIC");
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [aiConsentBusy, setAiConsentBusy] = useState(false);

  useEffect(() => {
    if (user) setVisibility(user.profileVisibility);
  }, [user]);

  const patchPrivacy = async (body: { profileVisibility?: string; aiConsent?: boolean }, success: string) => {
    try {
      await api("/api/me/privacy", { method: "PATCH", json: body });
      toast.success(success);
      await refresh();
    } catch (e) {
      toast.error(errText(e));
      throw e;
    }
  };

  if (!user) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={AlertTriangle}
          title="You're signed out"
          description="Your session has ended, so settings aren't available right now."
          action={<Button onClick={() => navigate("/auth")}>Sign in again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <SectionHeader
        title="Trust & settings"
        description="Your account, privacy controls and the records we keep on your behalf."
        className="mb-6"
      />

      <div className="space-y-6">
        {/* 1 — Account */}
        <Card>
          <CardContent className="p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Account</h2>
            <Separator className="my-4" />
            <dl className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium text-foreground">{user.name}</dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="font-medium text-foreground">{user.email}</dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted-foreground">Username</dt>
                <dd className="font-medium text-foreground">{user.username ? `@${user.username}` : "Not set"}</dd>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <Badge variant="outline" className="gap-1 rounded-full border-primary/40 font-normal text-primary">
                    <BadgeCheck className="size-3.5" aria-hidden /> Signed in
                  </Badge>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-muted-foreground">
              Member since {formatDate(user.createdAt)}. Password sessions are cookie-based and server-verified.
            </p>
          </CardContent>
        </Card>

        {/* 2 — Privacy */}
        <Card>
          <CardContent className="p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Privacy</h2>
            <Separator className="my-4" />

            <div className="space-y-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <Label htmlFor="visibility-select" className="text-sm font-medium text-foreground">
                    Profile visibility
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {visibility === "PUBLIC"
                      ? "Listed in search and discovery."
                      : "Hidden — a direct link shows not found."}
                  </p>
                </div>
                <Select
                  value={visibility}
                  disabled={visibilityBusy}
                  onValueChange={async (next) => {
                    const prev = visibility;
                    setVisibility(next);
                    setVisibilityBusy(true);
                    try {
                      await patchPrivacy(
                        { profileVisibility: next },
                        next === "PUBLIC" ? "Profile is now listed publicly" : "Profile is now hidden"
                      );
                    } catch {
                      setVisibility(prev);
                    } finally {
                      setVisibilityBusy(false);
                    }
                  }}
                >
                  <SelectTrigger id="visibility-select" className="w-full sm:w-64" aria-label="Profile visibility">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PUBLIC">Public — listed in search &amp; discovery</SelectItem>
                    <SelectItem value="PRIVATE">Private — hidden, direct link shows not found</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator className="bg-border/50" />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 sm:pr-6">
                  <Label htmlFor="ai-consent-switch" className="text-sm font-medium text-foreground">
                    BEAN Intelligence consent
                  </Label>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    When enabled, the server-side AI assistant can read your own profile and your projects (including
                    private drafts) to ground its answers. Every request is logged and counts toward a daily limit.
                    You can revoke this anytime — AI features stop immediately.
                  </p>
                </div>
                <Switch
                  id="ai-consent-switch"
                  checked={user.aiConsent}
                  disabled={aiConsentBusy}
                  className="shrink-0"
                  onCheckedChange={async (next) => {
                    setAiConsentBusy(true);
                    try {
                      await patchPrivacy(
                        { aiConsent: next },
                        next ? "BEAN Intelligence enabled" : "BEAN Intelligence disabled — access revoked"
                      );
                    } catch {
                      /* session re-render restores the true value */
                    } finally {
                      setAiConsentBusy(false);
                    }
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 3 — Connected methods */}
        <Card>
          <CardContent className="p-6">
            <h2 className="font-display text-lg font-semibold text-foreground">Connected methods</h2>
            <Separator className="my-4" />
            <ul className="space-y-3 text-sm">
              <li className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <div>
                  <p className="font-medium text-foreground">Email + password</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Active — this is how you sign in today. Sessions are httpOnly cookies validated server-side.
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3 rounded-lg border border-dashed border-border/60 p-3 opacity-90">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div>
                  <p className="font-medium text-foreground">Google sign-in</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Supported — &ldquo;Continue with Google&rdquo; appears on the sign-in and sign-up screens once this
                    deployment has Google OAuth credentials. Linking is explicit: an existing password account confirms
                    once with its password, and the password itself is never changed. Setup:&nbsp;
                    <span className="font-mono text-foreground/80">docs/google-auth.md</span>.
                  </p>
                </div>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* 3.5 — Recovery key */}
        <RecoveryKeySection />

        {/* 4 — Activity log */}
        <Card>
          <CardContent className="p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-foreground">
              <ScrollText className="size-4 text-primary" aria-hidden /> Activity log
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Privacy changes, exports, deletions and sign-ins are audit-logged for your transparency.
            </p>
            <div className="mt-4">
              <ActivityLog />
            </div>
          </CardContent>
        </Card>

        {/* 5 — Report a problem */}
        <Card>
          <CardContent className="p-6">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-foreground">
              <Flag className="size-4 text-primary" aria-hidden /> Report a problem
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              If something violates the community rules — harassment, impersonation, stolen work or fabricated
              metrics — use the <span className="text-foreground">Report</span> action on any project or profile page in
              Explore. Reports are reviewed by moderators.
            </p>
            <Button variant="outline" className="mt-4" onClick={() => navigate("/explore")}>
              Go to Explore
            </Button>
          </CardContent>
        </Card>

        {/* Danger zone */}
        <DangerZone />
      </div>
    </div>
  );
}
