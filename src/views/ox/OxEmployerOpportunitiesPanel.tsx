"use client";

/**
 * Opportunity Exchange (O3) — the employer opportunity console.
 *
 * One surface for the approved M-O3 lifecycle, mounted inside the employer
 * workspace section of the Opportunity Exchange:
 *   create draft → submit → admin decision → publish → pause → reopen →
 *   fill/close → audited draft deletion.
 *
 * The UI only MIRRORS what the server enforces (house rule): skill caps
 * (REQUIRED ≤ 8 / PREFERRED ≤ 12 / total ≤ 20, minimum zero) and salary
 * rules are shown live as counters, but every action is re-authorized and
 * re-validated server-side (404-deny for foreign orgs, 409 for illegal
 * transitions). Published/PAUSED edits return the row to PENDING_REVIEW —
 * the status pill communicates that to the employer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Briefcase, Loader2, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import { paiseToRupees, rupeesToPaise } from "./candidate-profile-state";

// ------------------------------------------------------------------ types

interface OrgDTO {
  id: string;
  displayName: string;
  slug: string;
  verificationStatus: string;
}

interface MeMembershipDTO {
  id: string;
  role: string;
  status: string;
  organization: OrgDTO;
}

interface SkillChipDTO {
  skillId: string;
  slug: string;
  label: string;
  kind: string;
}

interface OpportunityDTO {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  status: string;
  professionId: string | null;
  location: string | null;
  employmentType: string | null;
  workMode: string | null;
  positions: number | null;
  salaryMinPaise: number | null;
  salaryMaxPaise: number | null;
  salaryCurrency: string | null;
  compensationPeriod: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  rejectionReason: string | null;
  updatedAt: string;
  skills: SkillChipDTO[];
}

interface SkillSuggestion {
  slug: string;
  label: string;
}

interface ProfessionRow {
  id: string;
  slug: string;
  label: string;
}

const WRITE_ROLES = new Set(["OWNER", "ADMIN", "RECRUITER"]);

const EMPLOYMENT_TYPES = [
  { value: "FULL_TIME", label: "Full time" },
  { value: "PART_TIME", label: "Part time" },
  { value: "CONTRACT", label: "Contract" },
  { value: "FREELANCE", label: "Freelance" },
  { value: "INTERNSHIP", label: "Internship" },
];

const WORK_MODES = [
  { value: "ONSITE", label: "On-site" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "REMOTE", label: "Remote" },
];

const PERIODS = [
  { value: "YEAR", label: "Per year" },
  { value: "MONTH", label: "Per month" },
  { value: "HOUR", label: "Per hour" },
];

const CAPS = { required: 8, preferred: 12, total: 20 };

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

function statusPill(status: string) {
  const map: Record<string, string> = {
    DRAFT: "border-border text-muted-foreground",
    PENDING_REVIEW: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    PUBLISHED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    PAUSED: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    FILLED: "border-primary/40 bg-gold-soft text-primary",
    CLOSED: "border-border text-muted-foreground",
  };
  const labels: Record<string, string> = {
    DRAFT: "Draft",
    PENDING_REVIEW: "In review",
    PUBLISHED: "Published",
    PAUSED: "Paused",
    FILLED: "Filled",
    CLOSED: "Closed",
  };
  return (
    <Badge variant="outline" className={cn("text-[11px]", map[status] ?? "border-border text-muted-foreground")}>
      {labels[status] ?? status}
    </Badge>
  );
}

function salaryText(o: OpportunityDTO): string {
  if (o.salaryMinPaise === null && o.salaryMaxPaise === null) return "Salary: —";
  const min = o.salaryMinPaise !== null ? `₹${paiseToRupees(o.salaryMinPaise)}` : "…";
  const max = o.salaryMaxPaise !== null ? `₹${paiseToRupees(o.salaryMaxPaise)}` : "…";
  const period = PERIODS.find((p) => p.value === o.compensationPeriod)?.label ?? "";
  return `${min} – ${max} ${period}${o.salaryCurrency ? ` · ${o.salaryCurrency}` : ""}`;
}

// ------------------------------------------------------------------ form

interface SkillChip {
  skill: string;
  kind: "REQUIRED" | "PREFERRED";
}

interface OpportunityForm {
  title: string;
  description: string;
  professionId: string;
  location: string;
  employmentType: string;
  workMode: string;
  positions: string;
  salaryMinRupees: string;
  salaryMaxRupees: string;
  compensationPeriod: string;
  skills: SkillChip[];
}

const EMPTY_FORM: OpportunityForm = {
  title: "",
  description: "",
  professionId: "",
  location: "",
  employmentType: "",
  workMode: "",
  positions: "",
  salaryMinRupees: "",
  salaryMaxRupees: "",
  compensationPeriod: "YEAR",
  skills: [],
};

function formFromOpportunity(o: OpportunityDTO): OpportunityForm {
  return {
    title: o.title,
    description: o.description,
    professionId: o.professionId ?? "",
    location: o.location ?? "",
    employmentType: o.employmentType ?? "",
    workMode: o.workMode ?? "",
    positions: o.positions !== null ? String(o.positions) : "",
    salaryMinRupees: o.salaryMinPaise !== null ? paiseToRupees(o.salaryMinPaise) : "",
    salaryMaxRupees: o.salaryMaxPaise !== null ? paiseToRupees(o.salaryMaxPaise) : "",
    compensationPeriod: o.compensationPeriod ?? "YEAR",
    skills: o.skills.map((s) => ({ skill: s.slug, kind: s.kind === "PREFERRED" ? "PREFERRED" : "REQUIRED" })),
  };
}

/** Build the API payload; returns null + an error message when invalid. */
function buildPayload(form: OpportunityForm): { payload: Record<string, unknown> } | { error: string } {
  const minPaise = form.salaryMinRupees.trim() === "" ? null : rupeesToPaise(form.salaryMinRupees);
  const maxPaise = form.salaryMaxRupees.trim() === "" ? null : rupeesToPaise(form.salaryMaxRupees);
  if (minPaise === null || maxPaise === null) {
    if (form.salaryMinRupees.trim() !== "" || form.salaryMaxRupees.trim() !== "") {
      return { error: "Enter valid salary amounts (numbers only) or leave both fields empty." };
    }
  }
  if (minPaise !== null && maxPaise !== null && minPaise > maxPaise) {
    return { error: "The salary minimum must not exceed the maximum." };
  }
  const positions = form.positions.trim() === "" ? null : Number(form.positions);
  if (positions !== null && (!Number.isInteger(positions) || positions < 1 || positions > 100)) {
    return { error: "Positions must be a whole number between 1 and 100." };
  }
  const payload: Record<string, unknown> = {
    title: form.title.trim(),
    description: form.description.trim(),
    skills: form.skills,
  };
  if (form.professionId) payload.professionId = form.professionId;
  payload.location = form.location.trim();
  if (form.employmentType) payload.employmentType = form.employmentType;
  if (form.workMode) payload.workMode = form.workMode;
  if (positions !== null) payload.positions = positions;
  const salaryComplete = minPaise !== null && maxPaise !== null;
  if (salaryComplete) {
    payload.salaryMinPaise = minPaise;
    payload.salaryMaxPaise = maxPaise;
    payload.salaryCurrency = "INR";
    payload.compensationPeriod = form.compensationPeriod;
  } else {
    payload.salaryMinPaise = null;
    payload.salaryMaxPaise = null;
    payload.salaryCurrency = null;
    payload.compensationPeriod = null;
  }
  return { payload };
}

// ------------------------------------------------------------------ component

export default function OxEmployerOpportunitiesPanel() {
  const [memberships, setMemberships] = useState<MeMembershipDTO[] | null>(null);
  const [orgId, setOrgId] = useState<string>("");
  const [opportunities, setOpportunities] = useState<OpportunityDTO[] | null>(null);
  const [busy, setBusy] = useState<string>("");

  const [skillsCatalog, setSkillsCatalog] = useState<SkillSuggestion[]>([]);
  const [professions, setProfessions] = useState<ProfessionRow[]>([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<OpportunityDTO | null>(null);
  const [form, setForm] = useState<OpportunityForm>(EMPTY_FORM);
  const [skillInput, setSkillInput] = useState("");
  const [skillKind, setSkillKind] = useState<"REQUIRED" | "PREFERRED">("REQUIRED");
  const [deleting, setDeleting] = useState<OpportunityDTO | null>(null);

  const reload = useCallback(async (org: string) => {
    if (!org) return;
    setOpportunities(null);
    try {
      const data = await api<{ opportunities: OpportunityDTO[] }>(`/api/employers/${org}/opportunities`);
      setOpportunities(data.opportunities);
    } catch (e) {
      toast.error(errText(e));
      setOpportunities([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api<{ memberships: MeMembershipDTO[] }>("/api/employers/me")
      .then((data) => {
        if (!alive) return;
        const active = data.memberships.filter((m) => m.status !== "REMOVED");
        setMemberships(active);
        const first = active[0]?.organization.id ?? "";
        setOrgId(first);
      })
      .catch(() => alive && setMemberships([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (orgId) void reload(orgId);
  }, [orgId, reload]);

  useEffect(() => {
    let alive = true;
    api<{ skills: SkillSuggestion[] }>("/api/skills")
      .then((d) => alive && setSkillsCatalog(d.skills))
      .catch(() => undefined);
    api<{ families: { professions: ProfessionRow[] }[] }>("/api/professions?tree=1")
      .then((d) => {
        if (alive) setProfessions(d.families.flatMap((f) => f.professions));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const selectedMembership = useMemo(
    () => memberships?.find((m) => m.organization.id === orgId) ?? null,
    [memberships, orgId]
  );
  const canWrite = selectedMembership !== null && WRITE_ROLES.has(selectedMembership.role);
  const orgVerified = selectedMembership?.organization.verificationStatus === "VERIFIED";

  const counts = useMemo(() => {
    const required = form.skills.filter((s) => s.kind === "REQUIRED").length;
    const preferred = form.skills.length - required;
    return { required, preferred, total: form.skills.length };
  }, [form.skills]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }

  function openEdit(o: OpportunityDTO) {
    setEditing(o);
    setForm(formFromOpportunity(o));
    setEditorOpen(true);
  }

  function addSkill() {
    const value = skillInput.trim();
    if (!value) return;
    if (form.skills.length >= CAPS.total) {
      toast.error(`At most ${CAPS.total} skills in total.`);
      return;
    }
    if (skillKind === "REQUIRED" && counts.required >= CAPS.required) {
      toast.error(`At most ${CAPS.required} required skills.`);
      return;
    }
    if (skillKind === "PREFERRED" && counts.preferred >= CAPS.preferred) {
      toast.error(`At most ${CAPS.preferred} preferred skills.`);
      return;
    }
    const key = value.toLowerCase();
    if (form.skills.some((s) => s.skill.toLowerCase() === key)) {
      toast.error("That skill is already attached to this opportunity.");
      return;
    }
    setForm((f) => ({ ...f, skills: [...f.skills, { skill: value, kind: skillKind }] }));
    setSkillInput("");
  }

  async function saveOpportunity() {
    const built = buildPayload(form);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy("save");
    try {
      if (editing) {
        await api(`/api/employers/${orgId}/opportunities/${editing.id}`, { method: "PATCH", json: built.payload });
        toast.success(
          editing.status === "PUBLISHED" || editing.status === "PAUSED"
            ? "Saved — the opportunity returned to review for re-approval."
            : "Opportunity saved."
        );
      } else {
        await api(`/api/employers/${orgId}/opportunities`, { method: "POST", json: built.payload });
        toast.success("Draft created.");
      }
      setEditorOpen(false);
      await reload(orgId);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
    }
  }

  async function lifecycleAction(o: OpportunityDTO, action: "submit" | "pause" | "reopen" | "filled" | "closed") {
    setBusy(action + o.id);
    try {
      if (action === "submit") {
        await api(`/api/employers/${orgId}/opportunities/${o.id}/submit`, { method: "POST", json: {} });
        toast.success("Submitted for admin review.");
      } else if (action === "pause") {
        await api(`/api/employers/${orgId}/opportunities/${o.id}/pause`, { method: "POST", json: {} });
        toast.success("Listing paused.");
      } else if (action === "reopen") {
        await api(`/api/employers/${orgId}/opportunities/${o.id}/reopen`, { method: "POST", json: {} });
        toast.success("Listing re-published.");
      } else {
        await api(`/api/employers/${orgId}/opportunities/${o.id}/outcome`, {
          method: "POST",
          json: { outcome: action.toUpperCase() },
        });
        toast.success(action === "filled" ? "Marked as filled." : "Opportunity closed.");
      }
      await reload(orgId);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
    }
  }

  async function deleteDraft() {
    if (!deleting) return;
    setBusy("delete");
    try {
      await api(`/api/employers/${orgId}/opportunities/${deleting.id}`, { method: "DELETE" });
      toast.success("Draft deleted (recorded in the audit trail).");
      setDeleting(null);
      await reload(orgId);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
    }
  }

  // ---------------------------------------------------------------- render

  if (memberships === null) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (memberships.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No organization yet"
        description="Create your organization above to start posting opportunities."
      />
    );
  }

  return (
    <div>
      <SectionHeader
        title="Opportunities"
        description="Draft roles, submit them for review, and manage their lifecycle — publication is granted by admin approval only."
        as="h3"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {memberships.length > 1 ? (
          <div className="w-64">
            <Label className="sr-only" htmlFor="opportunity-org-select">
              Organization
            </Label>
            <Select value={orgId} onValueChange={setOrgId}>
              <SelectTrigger id="opportunity-org-select" aria-label="Organization">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {memberships.map((m) => (
                  <SelectItem key={m.organization.id} value={m.organization.id}>
                    {m.organization.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Organization: <span className="font-medium text-foreground">{selectedMembership?.organization.displayName}</span>
          </p>
        )}
        <Button onClick={openCreate} disabled={!canWrite || !orgVerified} className="ml-auto gap-2">
          <Plus className="size-4" aria-hidden /> New opportunity
        </Button>
      </div>

      {!orgVerified && (
        <p className="mt-2 text-xs text-muted-foreground" role="note">
          Only a verified organization can create and submit opportunities.
        </p>
      )}

      <div className="mt-4 space-y-3">
        {opportunities === null ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </>
        ) : opportunities.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No opportunities yet"
            description="Create your first draft. Nothing is published without an admin review."
          />
        ) : (
          opportunities.map((o) => (
            <Card key={o.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-foreground">{o.title}</h4>
                      {statusPill(o.status)}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{o.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{salaryText(o)}</p>
                    {o.rejectionReason && o.status === "DRAFT" && (
                      <p className="mt-1 text-xs text-red-300" role="note">
                        Reviewer feedback: {o.rejectionReason}
                      </p>
                    )}
                    {o.skills.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Attached skills">
                        {o.skills.map((s) => (
                          <Badge
                            key={s.skillId}
                            variant="outline"
                            className={cn(
                              "text-[11px]",
                              s.kind === "REQUIRED"
                                ? "border-primary/40 bg-gold-soft text-primary"
                                : "border-border text-muted-foreground"
                            )}
                          >
                            {s.label} · {s.kind === "REQUIRED" ? "required" : "preferred"}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  {canWrite && (
                    <div className="flex flex-wrap gap-2">
                      {(o.status === "DRAFT" || o.status === "PENDING_REVIEW" || o.status === "PUBLISHED" || o.status === "PAUSED") && (
                        <Button variant="outline" size="sm" onClick={() => openEdit(o)}>
                          Edit
                        </Button>
                      )}
                      {o.status === "DRAFT" && (
                        <Button
                          size="sm"
                          onClick={() => lifecycleAction(o, "submit")}
                          disabled={busy !== ""}
                          className="gap-1.5"
                        >
                          {busy === "submit" + o.id ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                          Submit
                        </Button>
                      )}
                      {o.status === "PUBLISHED" && (
                        <Button variant="outline" size="sm" onClick={() => lifecycleAction(o, "pause")} disabled={busy !== ""}>
                          Pause
                        </Button>
                      )}
                      {o.status === "PAUSED" && (
                        <Button size="sm" onClick={() => lifecycleAction(o, "reopen")} disabled={busy !== ""}>
                          Re-publish
                        </Button>
                      )}
                      {(o.status === "PUBLISHED" || o.status === "PAUSED") && (
                        <>
                          <Button variant="outline" size="sm" onClick={() => lifecycleAction(o, "filled")} disabled={busy !== ""}>
                            Mark filled
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => lifecycleAction(o, "closed")} disabled={busy !== ""}>
                            Close
                          </Button>
                        </>
                      )}
                      {o.status === "DRAFT" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-300 hover:text-red-200"
                          onClick={() => setDeleting(o)}
                          aria-label={`Delete draft ${o.title}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* create / edit dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit opportunity" : "New opportunity draft"}</DialogTitle>
            <DialogDescription>
              {editing && (editing.status === "PUBLISHED" || editing.status === "PAUSED")
                ? "Saving an edit returns this listing to review — an admin must approve it again before it publishes."
                : "Drafts stay private until you submit them for admin review."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="op-title">Title</Label>
              <Input
                id="op-title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={120}
                placeholder="Senior video editor"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="op-description">Description</Label>
              <Textarea
                id="op-description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                maxLength={8000}
                rows={5}
                placeholder="What the role involves, the team, and what success looks like…"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="op-profession">Profession</Label>
                <Select value={form.professionId} onValueChange={(v) => setForm((f) => ({ ...f, professionId: v }))}>
                  <SelectTrigger id="op-profession" aria-label="Profession">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="none">No specific profession</SelectItem>
                    {professions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="op-location">Location</Label>
                <Input
                  id="op-location"
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  maxLength={120}
                  placeholder="Bengaluru, India"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="op-employment">Employment type</Label>
                <Select value={form.employmentType} onValueChange={(v) => setForm((f) => ({ ...f, employmentType: v }))}>
                  <SelectTrigger id="op-employment" aria-label="Employment type">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {EMPLOYMENT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="op-workmode">Work mode</Label>
                <Select value={form.workMode} onValueChange={(v) => setForm((f) => ({ ...f, workMode: v }))}>
                  <SelectTrigger id="op-workmode" aria-label="Work mode">
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_MODES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="op-positions">Open positions</Label>
                <Input
                  id="op-positions"
                  inputMode="numeric"
                  value={form.positions}
                  onChange={(e) => setForm((f) => ({ ...f, positions: e.target.value }))}
                  placeholder="1"
                />
              </div>
            </div>

            <fieldset className="rounded-lg border border-border/60 p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Salary (required before review)
              </legend>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="op-salary-min">Minimum (₹)</Label>
                  <Input
                    id="op-salary-min"
                    inputMode="decimal"
                    value={form.salaryMinRupees}
                    onChange={(e) => setForm((f) => ({ ...f, salaryMinRupees: e.target.value }))}
                    placeholder="1200000"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="op-salary-max">Maximum (₹)</Label>
                  <Input
                    id="op-salary-max"
                    inputMode="decimal"
                    value={form.salaryMaxRupees}
                    onChange={(e) => setForm((f) => ({ ...f, salaryMaxRupees: e.target.value }))}
                    placeholder="1800000"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="op-period">Period</Label>
                  <Select
                    value={form.compensationPeriod}
                    onValueChange={(v) => setForm((f) => ({ ...f, compensationPeriod: v }))}
                  >
                    <SelectTrigger id="op-period" aria-label="Salary period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERIODS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                INR only. The server enforces the approved ceiling of ₹10 crore per amount (stored exactly as BigInt
                paise — values are never rounded or clamped).
              </p>
            </fieldset>

            <fieldset className="rounded-lg border border-border/60 p-3">
              <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Skills</legend>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                <span>Required {counts.required}/{CAPS.required}</span>
                <span>· Preferred {counts.preferred}/{CAPS.preferred}</span>
                <span>· Total {counts.total}/{CAPS.total}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {form.skills.map((s, i) => (
                  <Badge key={`${s.skill}-${i}`} variant="outline" className="gap-1 text-[11px]">
                    {s.skill} · {s.kind === "REQUIRED" ? "required" : "preferred"}
                    <button
                      type="button"
                      className="ml-1 rounded-full hover:text-red-300"
                      onClick={() => setForm((f) => ({ ...f, skills: f.skills.filter((_, j) => j !== i) }))}
                      aria-label={`Remove ${s.skill}`}
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="min-w-48 flex-1">
                  <Label className="sr-only" htmlFor="op-skill-input">
                    Skill
                  </Label>
                  <Input
                    id="op-skill-input"
                    list="op-skill-options"
                    value={skillInput}
                    onChange={(e) => setSkillInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSkill();
                      }
                    }}
                    placeholder="Skill name or slug"
                  />
                  <datalist id="op-skill-options">
                    {skillsCatalog.map((s) => (
                      <option key={s.slug} value={s.label} />
                    ))}
                  </datalist>
                </div>
                <div className="w-36">
                  <Label className="sr-only" htmlFor="op-skill-kind">
                    Skill kind
                  </Label>
                  <Select value={skillKind} onValueChange={(v) => setSkillKind(v === "PREFERRED" ? "PREFERRED" : "REQUIRED")}>
                    <SelectTrigger id="op-skill-kind" aria-label="Skill kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="REQUIRED">Required</SelectItem>
                      <SelectItem value="PREFERRED">Preferred</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="outline" onClick={addSkill}>
                  Add skill
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                The existing skill taxonomy is reused — unknown skills are rejected by the server.
              </p>
            </fieldset>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveOpportunity} disabled={busy !== ""} className="gap-2">
              {busy === "save" && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {editing ? "Save changes" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirmation */}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              {deleting?.title} — the deletion is recorded in the audit trail. Only drafts can be deleted; submitted or
              published opportunities cannot.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteDraft} disabled={busy !== ""} className="gap-2">
              {busy === "delete" && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Delete draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
