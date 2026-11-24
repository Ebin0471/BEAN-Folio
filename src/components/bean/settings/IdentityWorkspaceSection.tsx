"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, Check, Loader2, MailCheck, PlusCircle, RefreshCw, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { TagInput } from "@/components/bean/TagInput";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { BEAN_IDENTITIES, IDENTITY_META, BeanIdentity } from "@/lib/identity";

/**
 * M31 — Identities & Workspaces section (Settings).
 *
 * - Identities: shows the registered primary identity + every adopted
 *   identity profile; a returning user can ADD another professional identity
 *   without creating a second account. Adding an identity never reclassifies
 *   existing data and never grants candidate access by itself.
 * - Workspaces: personal workspace + all organization memberships with an
 *   explicit switcher. The switch only moves the per-browser pointer cookie —
 *   every server action re-authorizes membership independently.
 * - Email verification state is surfaced honestly (including "no provider
 *   configured" on deployments without one).
 */

type IdentityProfileDTO = {
  identity: BeanIdentity;
  primary: boolean;
  data: Record<string, unknown>;
  updatedAt: string;
};

type IdentityState = {
  primaryIdentity: BeanIdentity | null;
  profiles: IdentityProfileDTO[];
};

type WorkspaceState = {
  workspace: { type: "PERSONAL" | "ORGANIZATION"; organizationId: string | null; organization: { displayName: string } | null; membershipRole: string | null };
  memberships: {
    organizationId: string;
    displayName: string;
    slug: string;
    role: string;
    status: string;
    verificationStatus: string;
  }[];
};

type TrustState = {
  email: { verified: boolean; verifiedAt: string | null; required: boolean; gateApplies: boolean };
};

export function IdentityWorkspaceSection() {
  const [identities, setIdentities] = useState<IdentityState | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [trust, setTrust] = useState<TrustState | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draftIdentity, setDraftIdentity] = useState<BeanIdentity | null>(null);
  const [draftIndustries, setDraftIndustries] = useState<string[]>([]);
  const [draftFocus, setDraftFocus] = useState("");
  const [draftAck, setDraftAck] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [i, w, t] = await Promise.all([
        api<IdentityState>("/api/me/identity"),
        api<WorkspaceState>("/api/me/workspace"),
        api<TrustState>("/api/me/trust"),
      ]);
      setIdentities(i);
      setWorkspace(w);
      setTrust(t);
    } catch {
      // Section degrades silently to empty cards — the rest of Settings works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAddDialog() {
    setDraftIdentity(null);
    setDraftIndustries([]);
    setDraftFocus("");
    setDraftAck(false);
    setDialogOpen(true);
  }

  async function saveIdentity() {
    if (!draftIdentity || savingIdentity) return;
    if (draftIdentity === "TALENT_PARTNER" && !draftAck) {
      toast.error("Please acknowledge the candidate data access rules first.");
      return;
    }
    setSavingIdentity(true);
    try {
      const data: Record<string, unknown> = {};
      if (draftIndustries.length) data.industries = draftIndustries;
      if (draftFocus.trim()) {
        if (draftIdentity === "CAREER_PROFESSIONAL") data.experienceLevel = draftFocus.trim();
        else if (draftIdentity === "INDEPENDENT_PROFESSIONAL") data.services = [draftFocus.trim()];
        else if (draftIdentity === "ORGANIZATION") data.representativeRole = draftFocus.trim();
        else data.rolesSourced = [draftFocus.trim()];
      }
      if (draftIdentity === "ORGANIZATION") data.authorityAttested = true;
      if (draftIdentity === "TALENT_PARTNER") data.candidateDataRulesAcknowledged = true;
      await api("/api/me/identity", { method: "POST", json: { type: draftIdentity, data } });
      toast.success(`${IDENTITY_META[draftIdentity].label} profile added`);
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add the identity.");
    } finally {
      setSavingIdentity(false);
    }
  }

  async function switchWorkspace(organizationId: string | null) {
    setSwitching(organizationId ?? "personal");
    try {
      await api("/api/me/workspace/switch", { method: "POST", json: { organizationId } });
      toast.success(organizationId ? "Workspace switched" : "Back to your personal workspace");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch workspace.");
    } finally {
      setSwitching(null);
    }
  }

  async function resendVerification() {
    try {
      const res = await api<{ issued: boolean; sent: boolean; reason?: string; devToken?: string }>(
        "/api/auth/verify-email/request",
        { method: "POST" }
      );
      if (res.devToken) {
        await api("/api/auth/verify-email/confirm", { method: "POST", json: { token: res.devToken } });
        toast.success("Email verified (development test path)");
        await load();
      } else if (res.sent) {
        toast.success("Verification email sent");
      } else if (res.reason === "already-verified") {
        toast.info("Email already verified");
      } else if (res.reason === "cooldown" || res.reason === "daily-cap") {
        toast.info(res.reason === "cooldown" ? "Wait a minute before resending." : "Daily resend limit reached.");
      } else {
        toast.info("No email provider is configured on this deployment — nothing was sent (honest state).");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resend.");
    }
  }

  const activeOrgId = workspace?.workspace.type === "ORGANIZATION" ? workspace.workspace.organizationId : null;

  return (
    <>
      {/* ── Identities ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold text-foreground">Identities</h2>
            <Button size="sm" variant="outline" onClick={openAddDialog} className="h-9 gap-1.5">
              <PlusCircle className="size-3.5" aria-hidden /> Add identity
            </Button>
          </div>
          <Separator className="my-4" />
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {trust?.email.gateApplies && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                  <p className="flex items-center gap-2 text-sm">
                    <MailCheck className="size-4 text-primary" aria-hidden />
                    {trust.email.verified ? "Email verified" : "Email not yet verified — outreach and invitations stay locked"}
                  </p>
                  {!trust.email.verified && (
                    <Button size="sm" variant="outline" className="h-8" onClick={() => void resendVerification()}>
                      <RefreshCw className="size-3.5" aria-hidden /> Resend
                    </Button>
                  )}
                </div>
              )}
              <ul className="space-y-2">
                {identities?.profiles.length ? (
                  identities.profiles.map((p) => (
                    <li key={p.identity} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{IDENTITY_META[p.identity]?.label ?? p.identity}</p>
                        <p className="text-xs text-muted-foreground">{IDENTITY_META[p.identity]?.description}</p>
                      </div>
                      {identities.primaryIdentity === p.identity && (
                        <Badge variant="outline" className="rounded-full border-primary/40 font-normal text-primary">
                          Primary
                        </Badge>
                      )}
                    </li>
                  ))
                ) : (
                  <li className="text-sm text-muted-foreground">
                    No identity profiles yet — your account was created before identity-aware onboarding. Adding one below is
                    explicit and never reclassifies your existing data.
                  </li>
                )}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Workspaces ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-6">
          <h2 className="font-display text-lg font-semibold text-foreground">Workspaces</h2>
          <Separator className="my-4" />
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ul className="space-y-2">
              <li className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <UserRound className="size-4 shrink-0 text-primary" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">Personal</p>
                    <p className="text-xs text-muted-foreground">Your private folio and personal RIISHE memory.</p>
                  </div>
                </div>
                {activeOrgId === null ? (
                  <Badge variant="outline" className="rounded-full border-primary/40 font-normal text-primary">
                    <Check className="size-3.5" aria-hidden /> Active
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" className="h-8" disabled={switching !== null} onClick={() => void switchWorkspace(null)}>
                    {switching === "personal" && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Switch
                  </Button>
                )}
              </li>
              {workspace?.memberships
                .filter((m) => m.status === "ACTIVE")
                .map((m) => (
                  <li key={m.organizationId} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Building2 className="size-4 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{m.displayName}</p>
                        <p className="text-xs text-muted-foreground">
                          {m.role} · {m.verificationStatus === "VERIFIED" ? "Verified organization" : "Verification pending"}
                        </p>
                      </div>
                    </div>
                    {activeOrgId === m.organizationId ? (
                      <Badge variant="outline" className="rounded-full border-primary/40 font-normal text-primary">
                        <Check className="size-3.5" aria-hidden /> Active
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={switching !== null}
                        onClick={() => void switchWorkspace(m.organizationId)}
                      >
                        {switching === m.organizationId && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Switch
                      </Button>
                    )}
                  </li>
                ))}
              {workspace && workspace.memberships.filter((m) => m.status === "ACTIVE").length === 0 && (
                <li className="text-sm text-muted-foreground">
                  No organization workspaces yet. Create one from the Opportunity Exchange — memberships appear here with a
                  clear data boundary from your personal space.
                </li>
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Add-identity dialog ────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add an identity</DialogTitle>
            <DialogDescription>
              Add another professional profile to the same account. You are never locked into one role.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {BEAN_IDENTITIES.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={draftIdentity === id}
                  onClick={() => setDraftIdentity(id)}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    draftIdentity === id
                      ? "border-primary/60 bg-gold-soft/60"
                      : "border-border/60 bg-background/40 hover:border-primary/40"
                  )}
                >
                  <span className="block text-sm font-medium">{IDENTITY_META[id].label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{IDENTITY_META[id].tagline}</span>
                </button>
              ))}
            </div>
            {draftIdentity && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="add-id-focus">
                    {draftIdentity === "CAREER_PROFESSIONAL"
                      ? "Experience level (optional)"
                      : draftIdentity === "INDEPENDENT_PROFESSIONAL"
                        ? "Main service (optional)"
                        : draftIdentity === "ORGANIZATION"
                          ? "Your role at the organization (optional)"
                          : "Main role you source (optional)"}
                  </Label>
                  <Input
                    id="add-id-focus"
                    value={draftFocus}
                    onChange={(e) => setDraftFocus(e.target.value)}
                    maxLength={80}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Industries</Label>
                  <TagInput value={draftIndustries} onChange={setDraftIndustries} max={12} placeholder="Type an industry and press Enter" ariaLabel="Add an industry" />
                </div>
                {draftIdentity === "TALENT_PARTNER" && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3">
                    <Checkbox id="add-id-ack" checked={draftAck} onCheckedChange={(v) => setDraftAck(v === true)} />
                    <Label htmlFor="add-id-ack" className="text-xs font-normal leading-relaxed text-muted-foreground">
                      I understand candidate access requires verified organization membership or an approved authorization —
                      never a self-selected category.
                    </Label>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void saveIdentity()} disabled={!draftIdentity || savingIdentity}>
                {savingIdentity && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Add identity
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
