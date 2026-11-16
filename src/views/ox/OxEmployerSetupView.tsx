"use client";

/**
 * Opportunity Exchange (O1) — the employer-identity workspace.
 *
 * One surface for: organization onboarding (create dialog), the organization
 * profile, verification status + submission, and team/role management
 * (invite, role changes, suspend/reactivate/remove, audited ownership
 * transfer with password re-authentication).
 *
 * The UI only MIRRORS what the server enforces: every action re-checks
 * membership/role server-side (404-deny), so disabled buttons here are
 * convenience, not security.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Building2, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ types

interface OrgDTO {
  id: string;
  legalName: string;
  displayName: string;
  slug: string;
  website: string | null;
  industry: string | null;
  companySize: string | null;
  description: string | null;
  headquarters: string | null;
  verificationStatus: string;
  verificationMethod: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemberDTO {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status: string;
  invitedByUserId: string | null;
  joinedAt: string | null;
  createdAt: string;
  user?: { id: string; name: string; username: string | null; avatarUrl: string | null };
}

interface MeMembershipDTO extends MemberDTO {
  organization: OrgDTO;
}

const COMPANY_SIZES: { value: string; label: string }[] = [
  { value: "STARTUP_1_10", label: "Startup (1–10)" },
  { value: "SMB_11_50", label: "Small business (11–50)" },
  { value: "MID_51_200", label: "Mid-size (51–200)" },
  { value: "LARGE_201_1000", label: "Large (201–1000)" },
  { value: "ENTERPRISE_1000_PLUS", label: "Enterprise (1000+)" },
];

const ROLES = ["ADMIN", "RECRUITER", "HIRING_MANAGER", "VIEWER"] as const;

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  RECRUITER: "Recruiter",
  HIRING_MANAGER: "Hiring manager",
  VIEWER: "Viewer",
};

function sizeLabel(value: string | null): string {
  return COMPANY_SIZES.find((s) => s.value === value)?.label ?? value ?? "—";
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

function verificationPill(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    UNVERIFIED: { cls: "border-border text-muted-foreground", label: "Unverified" },
    PENDING: { cls: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300", label: "Under review" },
    VERIFIED: { cls: "border-primary/40 bg-gold-soft text-primary", label: "Verified" },
    REJECTED: { cls: "border-red-500/40 bg-red-500/10 text-red-300", label: "Rejected" },
    SUSPENDED: { cls: "border-red-500/40 bg-red-500/10 text-red-300", label: "Suspended" },
  };
  const v = map[status] ?? map.UNVERIFIED;
  return (
    <Badge variant="outline" className={cn("gap-1 text-[11px]", v.cls)}>
      {status === "VERIFIED" && <ShieldCheck className="size-3" aria-hidden />}
      {v.label}
    </Badge>
  );
}

function statusPill(status: string) {
  const map: Record<string, string> = {
    ACTIVE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    INVITED: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    SUSPENDED: "border-red-500/40 bg-red-500/10 text-red-300",
    REMOVED: "border-border text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={cn("text-[11px]", map[status] ?? "border-border text-muted-foreground")}>
      {status === "INVITED" ? "Invitation pending" : status}
    </Badge>
  );
}

// ------------------------------------------------------------------ view

export default function OxEmployerSetupView() {
  const [memberships, setMemberships] = useState<MeMembershipDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberDTO[] | null>(null);
  const [busy, setBusy] = useState(false);

  // dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState<string>("");
  const [transferPassword, setTransferPassword] = useState("");

  // create/edit form
  const [form, setForm] = useState({
    legalName: "",
    displayName: "",
    slug: "",
    website: "",
    industry: "",
    companySize: "",
    headquarters: "",
    description: "",
  });
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("RECRUITER");
  const [evidenceReference, setEvidenceReference] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api<{ memberships: MeMembershipDTO[] }>("/api/employers/me");
      setMemberships(res.memberships);
    } catch (err) {
      setLoadError(errText(err));
      setMemberships([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeMemberships = useMemo(
    () => (memberships ?? []).filter((m) => m.status !== "REMOVED"),
    [memberships]
  );
  const current = useMemo(
    () =>
      activeMemberships.find((m) => m.organization.id === selectedOrgId) ??
      activeMemberships.find((m) => m.status === "ACTIVE") ??
      activeMemberships[0] ??
      null,
    [activeMemberships, selectedOrgId]
  );
  const org = current?.organization ?? null;
  const canManage = current?.status === "ACTIVE" && (current.role === "OWNER" || current.role === "ADMIN");
  const isOwner = current?.status === "ACTIVE" && current.role === "OWNER";

  const loadMembers = useCallback(async (orgId: string) => {
    try {
      const res = await api<{ members: MemberDTO[] }>(`/api/employers/${orgId}/members`);
      setMembers(res.members);
    } catch {
      setMembers(null);
    }
  }, []);

  useEffect(() => {
    setMembers(null);
    if (org && canManage) void loadMembers(org.id);
  }, [org, canManage, loadMembers]);

  async function run(fn: () => Promise<unknown>, successMessage?: string) {
    setBusy(true);
    try {
      await fn();
      if (successMessage) toast.success(successMessage);
      await load();
      if (org && canManage) await loadMembers(org.id);
      return true;
    } catch (err) {
      toast.error(errText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- states

  if (memberships === null) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading employer workspace">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (loadError && activeMemberships.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="We couldn't load your organizations"
        description={loadError}
        action={<Button variant="outline" onClick={() => void load()}>Retry</Button>}
      />
    );
  }

  if (activeMemberships.length === 0) {
    return (
      <>
        <EmptyState
          icon={Building2}
          title="Set up your employer organization"
          description="Create your organization, invite your team, and request verification. Verification unlocks the hiring capabilities that arrive in upcoming milestones."
          action={<Button onClick={() => openCreate()}>Create organization</Button>}
        />
        <CreateOrgDialog />
      </>
    );
  }

  const pendingInvites = activeMemberships.filter((m) => m.status === "INVITED");

  // ---------------------------------------------------------------- render

  return (
    <div className="flex flex-col gap-8">
      {pendingInvites.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
          {pendingInvites.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                You&apos;ve been invited to join <span className="font-medium">{m.organization.displayName}</span> as{" "}
                {ROLE_LABELS[m.role] ?? m.role}.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        api(`/api/employers/${m.organization.id}/members/${m.id}`, {
                          method: "PATCH",
                          json: { status: "ACTIVE" },
                        }),
                      "Invitation accepted"
                    )
                  }
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        api(`/api/employers/${m.organization.id}/members/${m.id}`, {
                          method: "PATCH",
                          json: { status: "REMOVED" },
                        }),
                      "Invitation declined"
                    )
                  }
                >
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeMemberships.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Your organizations">
          {activeMemberships.map((m) => (
            <button
              key={m.organization.id}
              type="button"
              role="tab"
              aria-selected={current?.organization.id === m.organization.id}
              onClick={() => setSelectedOrgId(m.organization.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                current?.organization.id === m.organization.id
                  ? "border-primary/50 bg-gold-soft font-medium text-primary"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {m.organization.displayName}
              {m.status === "SUSPENDED" ? " · suspended" : ""}
            </button>
          ))}
        </div>
      )}

      {org && current && (
        <>
          {/* -------- organization profile -------- */}
          <section aria-labelledby="ox-org-profile-heading">
            <SectionHeader
              title="Organization profile"
              description={`beanfolio.org employers · /${org.slug}`}
              as="h2"
            />
            <h2 id="ox-org-profile-heading" className="sr-only">
              Organization profile
            </h2>
            <Card>
              <CardContent className="flex flex-col gap-4 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="grid size-11 shrink-0 place-items-center rounded-full bg-gold-soft text-primary">
                      <Building2 className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="font-display text-lg font-semibold">{org.displayName}</p>
                      <p className="text-sm text-muted-foreground">
                        {org.legalName}
                        {org.industry ? ` · ${org.industry}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {verificationPill(org.verificationStatus)}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setForm({
                            legalName: org.legalName,
                            displayName: org.displayName,
                            slug: org.slug,
                            website: org.website ?? "",
                            industry: org.industry ?? "",
                            companySize: org.companySize ?? "",
                            headquarters: org.headquarters ?? "",
                            description: org.description ?? "",
                          });
                          setEditOpen(true);
                        }}
                      >
                        Edit profile
                      </Button>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Company size</dt>
                    <dd>{sizeLabel(org.companySize)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Headquarters</dt>
                    <dd>{org.headquarters ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Website</dt>
                    <dd className="truncate">
                      {org.website ? (
                        <a
                          href={org.website}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {org.website.replace(/^https?:\/\//, "")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:block">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Your role</dt>
                    <dd>
                      {ROLE_LABELS[current.role] ?? current.role}
                      {current.status !== "ACTIVE" ? ` · ${current.status.toLowerCase()}` : ""}
                    </dd>
                  </div>
                </dl>
                {org.description && <p className="text-sm text-muted-foreground">{org.description}</p>}
              </CardContent>
            </Card>
          </section>

          {/* -------- verification -------- */}
          <section aria-labelledby="ox-verification-heading">
            <SectionHeader
              title="Verification"
              description="A manual review confirms the organization is a real employer. Verification is required before hiring capabilities unlock."
              as="h2"
            />
            <h2 id="ox-verification-heading" className="sr-only">
              Verification
            </h2>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
                <div className="min-w-0 text-sm">
                  {org.verificationStatus === "VERIFIED" && (
                    <p>
                      Verified{org.verificationMethod ? ` · ${org.verificationMethod.toLowerCase().replace(/_/g, " ")}` : ""}
                      {org.verifiedAt ? ` · ${new Date(org.verifiedAt).toLocaleDateString()}` : ""}
                    </p>
                  )}
                  {org.verificationStatus === "PENDING" && (
                    <p className="text-muted-foreground">
                      Your submission is in the review queue. You&apos;ll be able to proceed once an admin decides.
                    </p>
                  )}
                  {org.verificationStatus === "UNVERIFIED" && (
                    <p className="text-muted-foreground">
                      Submit your organization for review to start the verification process.
                    </p>
                  )}
                  {org.verificationStatus === "REJECTED" && (
                    <p className="text-muted-foreground">The last submission was rejected. You can submit again.</p>
                  )}
                  {org.verificationStatus === "SUSPENDED" && (
                    <p className="text-muted-foreground">
                      This organization is suspended — verification and hiring are unavailable. Contact trust &amp; safety.
                    </p>
                  )}
                </div>
                {(org.verificationStatus === "UNVERIFIED" || org.verificationStatus === "REJECTED") &&
                  canManage && (
                    <Button
                      onClick={() => {
                        setEvidenceReference("");
                        setVerifyOpen(true);
                      }}
                    >
                      <ShieldCheck className="size-4" aria-hidden />
                      Request verification
                    </Button>
                  )}
              </CardContent>
            </Card>
          </section>

          {/* -------- team -------- */}
          {canManage && (
            <section aria-labelledby="ox-team-heading">
              <SectionHeader
                title="Team"
                description={
                  members && members.filter((m) => m.status === "ACTIVE").length === 1
                    ? "1 active member"
                    : `${members?.filter((m) => m.status === "ACTIVE").length ?? 0} active members`
                }
                as="h2"
                action={
                  <Button size="sm" onClick={() => { setInviteUsername(""); setInviteRole("RECRUITER"); setInviteOpen(true); }}>
                    <UserPlus className="size-4" aria-hidden />
                    Invite member
                  </Button>
                }
              />
              <h2 id="ox-team-heading" className="sr-only">
                Team
              </h2>
              <Card>
                <CardContent className="p-0">
                  {members === null ? (
                    <div className="flex flex-col gap-2 p-6" aria-busy="true">
                      <Skeleton className="h-10 w-full" />
                      <Skeleton className="h-10 w-full" />
                    </div>
                  ) : members.length === 0 ? (
                    <p className="p-6 text-sm text-muted-foreground">No members yet.</p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {members.map((m) => (
                        <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar className="size-9">
                              <AvatarImage src={m.user?.avatarUrl ?? undefined} alt="" />
                              <AvatarFallback className="text-xs">
                                {(m.user?.name ?? "?").slice(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {m.user?.name ?? "Member"}
                                {m.userId === current.userId && (
                                  <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                                )}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {m.user?.username ? `@${m.user.username}` : "—"}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {statusPill(m.status)}
                            {m.status === "ACTIVE" && m.role !== "OWNER" && (
                              <Select
                                value={m.role}
                                onValueChange={(v) =>
                                  void run(
                                    () =>
                                      api(`/api/employers/${org.id}/members/${m.id}`, {
                                        method: "PATCH",
                                        json: { role: v },
                                      }),
                                    "Role updated"
                                  )
                                }
                              >
                                <SelectTrigger
                                  className="h-8 w-[150px] text-xs"
                                  aria-label={`Role for ${m.user?.name ?? "member"}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ROLES.map((r) => (
                                    <SelectItem key={r} value={r} className="text-xs">
                                      {ROLE_LABELS[r]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                            {m.role === "OWNER" && (
                              <Badge variant="outline" className="border-primary/40 bg-gold-soft text-[11px] text-primary">
                                Owner
                              </Badge>
                            )}
                            {m.status === "ACTIVE" && m.role !== "OWNER" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy || !isOwner}
                                title={isOwner ? "Transfer ownership with re-authentication" : "Only the owner can transfer ownership"}
                                onClick={() => {
                                  setTransferTargetId(m.id);
                                  setTransferPassword("");
                                  setTransferOpen(true);
                                }}
                              >
                                Transfer ownership
                              </Button>
                            )}
                            {m.status !== "REMOVED" && !(m.role === "OWNER") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-300 hover:text-red-200"
                                disabled={busy}
                                onClick={() => {
                                  const next =
                                    m.status === "INVITED"
                                      ? "REMOVED"
                                      : m.status === "SUSPENDED"
                                        ? "REMOVED"
                                        : "SUSPENDED";
                                  const label =
                                    next === "REMOVED" ? "Member removed" : "Member suspended";
                                  void run(
                                    () =>
                                      api(`/api/employers/${org.id}/members/${m.id}`, {
                                        method: "PATCH",
                                        json: { status: next },
                                      }),
                                    label
                                  );
                                }}
                              >
                                {m.status === "ACTIVE" ? "Suspend" : m.status === "INVITED" ? "Revoke invite" : "Remove"}
                              </Button>
                            )}
                            {m.status === "SUSPENDED" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () =>
                                      api(`/api/employers/${org.id}/members/${m.id}`, {
                                        method: "PATCH",
                                        json: { status: "ACTIVE" },
                                      }),
                                    "Member reactivated"
                                  )
                                }
                              >
                                Reactivate
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              {isOwner && members && members.filter((m) => m.status === "ACTIVE" && m.role !== "OWNER").length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Ownership transfer requires your password and is recorded in the audit trail. The final active owner
                  cannot be demoted or removed otherwise.
                </p>
              )}
            </section>
          )}
        </>
      )}

      {/* -------- dialogs -------- */}
      <CreateOrgDialog />
      <EditOrgDialog />
      <InviteDialog />
      <VerifyDialog />
      <TransferDialog />
    </div>
  );

  // ---------------------------------------------------------------- dialogs
  // (Declared after the return so they close over the current state; React
  // re-renders them with the view.)

  function openCreate() {
    setForm({
      legalName: "",
      displayName: "",
      slug: "",
      website: "",
      industry: "",
      companySize: "",
      headquarters: "",
      description: "",
    });
    setCreateOpen(true);
  }

  function CreateOrgDialog() {
    return (
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create your employer organization</DialogTitle>
            <DialogDescription>
              This becomes your organization&apos;s home on the Opportunity Exchange. The creator becomes the OWNER.
            </DialogDescription>
          </DialogHeader>
          <OrgFormFields slugEditable />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || form.legalName.trim().length < 2 || form.displayName.trim().length === 0}
              onClick={async () => {
                const okDone = await run(async () => {
                  await api("/api/employers", {
                    method: "POST",
                    json: {
                      legalName: form.legalName.trim(),
                      displayName: form.displayName.trim(),
                      ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
                      ...(form.website.trim() ? { website: form.website.trim() } : {}),
                      ...(form.industry.trim() ? { industry: form.industry.trim() } : {}),
                      ...(form.companySize ? { companySize: form.companySize } : {}),
                      ...(form.headquarters.trim() ? { headquarters: form.headquarters.trim() } : {}),
                      ...(form.description.trim() ? { description: form.description.trim() } : {}),
                    },
                  });
                  setCreateOpen(false);
                }, "Organization created");
                if (okDone) setSelectedOrgId(null);
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Create organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function EditOrgDialog() {
    return (
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit organization profile</DialogTitle>
            <DialogDescription>
              The organization address (/{org?.slug}) is permanent and cannot be changed.
            </DialogDescription>
          </DialogHeader>
          <OrgFormFields slugEditable={false} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                await run(async () => {
                  await api(`/api/employers/${org?.id}`, {
                    method: "PATCH",
                    json: {
                      legalName: form.legalName.trim(),
                      displayName: form.displayName.trim(),
                      ...(form.website.trim() ? { website: form.website.trim() } : { website: "" }),
                      ...(form.industry.trim() ? { industry: form.industry.trim() } : { industry: "" }),
                      ...(form.companySize ? { companySize: form.companySize } : {}),
                      ...(form.headquarters.trim() ? { headquarters: form.headquarters.trim() } : { headquarters: "" }),
                      ...(form.description.trim() ? { description: form.description.trim() } : { description: "" }),
                    },
                  });
                  setEditOpen(false);
                }, "Profile updated");
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function InviteDialog() {
    return (
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a team member</DialogTitle>
            <DialogDescription>
              They&apos;ll see the invitation in their Opportunity Exchange workspace. Ownership is never granted through
              an invite.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ox-invite-username">Username</Label>
              <Input
                id="ox-invite-username"
                value={inviteUsername}
                onChange={(e) => setInviteUsername(e.target.value)}
                placeholder="their-beanfolio-username"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ox-invite-role">Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger id="ox-invite-role" aria-label="Invite role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || inviteUsername.trim().length < 3}
              onClick={async () => {
                await run(async () => {
                  await api(`/api/employers/${org?.id}/members`, {
                    method: "POST",
                    json: { username: inviteUsername.trim(), role: inviteRole },
                  });
                  setInviteOpen(false);
                }, "Invitation sent");
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Send invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function VerifyDialog() {
    return (
      <Dialog open={verifyOpen} onOpenChange={setVerifyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request verification</DialogTitle>
            <DialogDescription>
              Submit a secure reference for your review case — for example an external registry or document-handling
              reference. Never paste document contents here; the reviewer resolves the reference through the review
              tooling.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-evidence-ref">Evidence reference</Label>
            <Input
              id="ox-evidence-ref"
              value={evidenceReference}
              onChange={(e) => setEvidenceReference(e.target.value)}
              placeholder="e.g. registry-case-2026-0001"
              autoComplete="off"
              maxLength={256}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVerifyOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || evidenceReference.trim().length < 4}
              onClick={async () => {
                await run(async () => {
                  await api(`/api/employers/${org?.id}/verification`, {
                    method: "POST",
                    json: { evidenceReference: evidenceReference.trim() },
                  });
                  setVerifyOpen(false);
                }, "Submitted for verification");
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Submit for review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function TransferDialog() {
    const target = members?.find((m) => m.id === transferTargetId);
    return (
      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              {target?.user?.name ?? "This member"} becomes the OWNER and you become an ADMIN. Confirm with your
              password — this decision is recorded in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-transfer-password">Your password</Label>
            <Input
              id="ox-transfer-password"
              type="password"
              value={transferPassword}
              onChange={(e) => setTransferPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTransferOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || transferPassword.length === 0}
              onClick={async () => {
                await run(async () => {
                  await api(`/api/employers/${org?.id}/transfer-ownership`, {
                    method: "POST",
                    json: { toMemberId: transferTargetId, currentPassword: transferPassword },
                  });
                  setTransferOpen(false);
                }, "Ownership transferred");
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Transfer ownership
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  function OrgFormFields({ slugEditable }: { slugEditable: boolean }) {
    return (
      <div className="grid gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ox-legal-name">Legal name *</Label>
            <Input
              id="ox-legal-name"
              value={form.legalName}
              onChange={(e) => setForm({ ...form, legalName: e.target.value })}
              maxLength={200}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-display-name">Display name *</Label>
            <Input
              id="ox-display-name"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              maxLength={80}
              autoComplete="off"
            />
          </div>
        </div>
        {slugEditable && (
          <div className="grid gap-1.5">
            <Label htmlFor="ox-slug">Organization address (optional)</Label>
            <Input
              id="ox-slug"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              placeholder="auto-generated from the display name"
              autoComplete="off"
            />
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ox-website">Website</Label>
            <Input
              id="ox-website"
              type="url"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              placeholder="https://company.example"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-industry">Industry</Label>
            <Input
              id="ox-industry"
              value={form.industry}
              onChange={(e) => setForm({ ...form, industry: e.target.value })}
              maxLength={80}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ox-size">Company size</Label>
            <Select
              value={form.companySize || undefined}
              onValueChange={(v) => setForm({ ...form, companySize: v })}
            >
              <SelectTrigger id="ox-size" aria-label="Company size">
                <SelectValue placeholder="Select size" />
              </SelectTrigger>
              <SelectContent>
                {COMPANY_SIZES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-hq">Headquarters</Label>
            <Input
              id="ox-hq"
              value={form.headquarters}
              onChange={(e) => setForm({ ...form, headquarters: e.target.value })}
              maxLength={120}
              autoComplete="off"
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ox-description">Description</Label>
          <Textarea
            id="ox-description"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={3}
            maxLength={2000}
          />
        </div>
      </div>
    );
  }
}
