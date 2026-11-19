"use client";

/**
 * Opportunity Exchange (M-O6) — employer "Invitations Sent" console.
 *
 * Mounted inside the employer workspace section of the Opportunity Exchange
 * (after the discovery console). Covers the approved RD-set end-to-end:
 *   - the org-scoped invitations list with truthful status badges and
 *     candidate cards rendered EXACTLY as the server serializes them (live
 *     card or masked state — the UI never invents eligibility);
 *   - the invitation composer: candidate picker sourced ONLY from the
 *     opportunity's eligible matches + shortlist entries, offer terms
 *     prefilled from the opportunity (editable, validated min ≤ max), a
 *     live SalaryRange preview of the frozen snapshot, and the MANDATORY
 *     confirm-before-send step (RD-3 — presentation guard, no AI sending);
 *   - draft editing / sending / discarding (RD-17);
 *   - the invitation detail dialog: immutable original offer at top (Part
 *     L), the append-only negotiation thread (seq, proposer, terms,
 *     timestamps), employer counter-proposal, accept/decline of a pending
 *     candidate proposal, withdrawal of the employer's own pending proposal,
 *     and withdrawal of the invitation with explicit consequence copy
 *     (RD-11).
 *
 * The UI only MIRRORS server state (house rule): eligibility, quotas,
 * cooldowns, uniqueness and every authorization answer are re-validated
 * server-side on every action; 409/429 errors surface as honest toasts.
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
import { BadgeCheck, History, Inbox, Loader2, MailPlus, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import SalaryRange from "./SalaryRange";

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

interface OpportunityLiteDTO {
  id: string;
  title: string;
  status: string;
  salaryMinPaise: number | null;
  salaryMaxPaise: number | null;
  salaryCurrency: string | null;
  compensationPeriod: string | null;
}

interface PickerCandidate {
  candidateUserId: string;
  source: "MATCH" | "SHORTLIST";
  score?: number | null;
}

interface NegotiationDTO {
  id: string;
  seq: number;
  proposerRole: string;
  proposerUserId: string | null;
  proposedSalaryMinPaise: number | null;
  proposedSalaryMaxPaise: number | null;
  proposedCurrency: string;
  proposedPeriod: string;
  status: string;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

interface InvitationDTO {
  id: string;
  organizationId: string;
  opportunityId: string;
  candidateUserId: string | null;
  status: string;
  offer: { salaryMinPaise: number | null; salaryMaxPaise: number | null; currency: string; period: string };
  accepted: { salaryMinPaise: number | null; salaryMaxPaise: number | null; currency: string | null; period: string | null; acceptedAt: string } | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  withdrawnAt: string | null;
  expiresAt: string | null;
  candidateState: string;
  candidate?: Record<string, unknown> | null;
  negotiations: NegotiationDTO[];
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  VIEWED: "Viewed",
  NEGOTIATION_REQUESTED: "Negotiating",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
};

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SENT: "bg-gold-soft text-primary",
  VIEWED: "bg-secondary text-secondary-foreground",
  NEGOTIATION_REQUESTED: "bg-gold-soft text-primary",
  ACCEPTED: "bg-emerald-600 text-white",
  DECLINED: "bg-destructive/10 text-destructive",
  EXPIRED: "bg-muted text-muted-foreground",
  WITHDRAWN: "bg-muted text-muted-foreground",
};

const MASKED_LABEL: Record<string, string> = {
  MASKED_CONSENT: "Consent withdrawn",
  MASKED_VISIBILITY: "Profile paused or hidden",
  MASKED_BLOCKED: "Not available",
  MASKED_UNAVAILABLE: "No longer available",
};

function candidateLabel(id: string | null): string {
  return id ? `Candidate ${id.slice(0, 10)}…` : "Deleted account";
}

function masked(state: string): boolean {
  return state.startsWith("MASKED");
}

const PERIODS = ["YEAR", "MONTH", "HOUR"] as const;

// ------------------------------------------------------------------ component

export default function OxEmployerInvitationsPanel() {
  const [memberships, setMemberships] = useState<MeMembershipDTO[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [opportunities, setOpportunities] = useState<OpportunityLiteDTO[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>("");
  const [invitations, setInvitations] = useState<InvitationDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // composer state
  const [composerOpen, setComposerOpen] = useState(false);
  const [picker, setPicker] = useState<PickerCandidate[] | null>(null);
  const [pickId, setPickId] = useState<string>("");
  const [offerMin, setOfferMin] = useState<string>("");
  const [offerMax, setOfferMax] = useState<string>("");
  const [offerCurrency, setOfferCurrency] = useState<string>("INR");
  const [offerPeriod, setOfferPeriod] = useState<string>("YEAR");
  const [confirmStep, setConfirmStep] = useState(false);

  // detail state
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvitationDTO | null>(null);
  const [counterMin, setCounterMin] = useState<string>("");
  const [counterMax, setCounterMax] = useState<string>("");

  const verifiedOrgs = useMemo(
    () => memberships.filter((m) => m.status === "ACTIVE" && m.organization.verificationStatus === "VERIFIED"),
    [memberships]
  );
  const selectedOpportunity = useMemo(
    () => opportunities.find((o) => o.id === opportunityId) ?? null,
    [opportunities, opportunityId]
  );

  useEffect(() => {
    api<{ memberships: MeMembershipDTO[] }>("/api/employers/me")
      .then((d) => setMemberships(d.memberships))
      .catch(() => setMemberships([]));
  }, []);

  useEffect(() => {
    if (!orgId) {
      setOpportunities([]);
      setOpportunityId("");
      return;
    }
    api<{ opportunities: OpportunityLiteDTO[] }>(`/api/employers/${orgId}/opportunities`)
      .then((d) => setOpportunities(d.opportunities))
      .catch(() => setOpportunities([]));
  }, [orgId]);

  const loadInvitations = useCallback(async (oid: string, opid: string) => {
    if (!oid) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ organizationId: oid });
      if (opid) params.set("opportunityId", opid);
      const data = await api<{ invitations: InvitationDTO[] }>(`/api/opportunities/invitations?${params.toString()}`);
      setInvitations(data.invitations);
    } catch (e) {
      setInvitations(null);
      if (e instanceof ApiError && e.status !== 404) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInvitations(orgId, opportunityId);
  }, [orgId, opportunityId, loadInvitations]);

  const openComposer = useCallback(async () => {
    setComposerOpen(true);
    setConfirmStep(false);
    setPickId("");
    setPicker(null);
    if (!orgId || !opportunityId) return;
    try {
      const [m, s] = await Promise.all([
        api<{ matches: { candidateUserId: string; state: string; score: number }[] }>(
          `/api/employers/${orgId}/opportunities/${opportunityId}/matches`
        ),
        api<{ entries: { candidateUserId: string; state: string }[] }>(
          `/api/employers/${orgId}/opportunities/${opportunityId}/shortlist`
        ),
      ]);
      const byId = new Map<string, PickerCandidate>();
      for (const match of m.matches) {
        // Only currently-listed candidates are invitable (the server
        // revalidates the source + boundary at send regardless — RD-2).
        if (match.state === "LIVE" || match.state === "FROZEN") {
          byId.set(match.candidateUserId, { candidateUserId: match.candidateUserId, source: "MATCH", score: match.score });
        }
      }
      for (const entry of s.entries) {
        if (entry.state === "LISTED" && !byId.has(entry.candidateUserId)) {
          byId.set(entry.candidateUserId, { candidateUserId: entry.candidateUserId, source: "SHORTLIST" });
        }
      }
      const list = [...byId.values()];
      setPicker(list);
      if (list.length === 0) toast.error("No eligible candidates for this opportunity yet.");
    } catch {
      setPicker([]);
    }
  }, [orgId, opportunityId]);

  const prefillFromOpportunity = useCallback(
    (opid: string) => {
      const opp = opportunities.find((o) => o.id === opid);
      if (opp?.salaryMinPaise != null) setOfferMin(String(Math.round(opp.salaryMinPaise / 100)));
      if (opp?.salaryMaxPaise != null) setOfferMax(String(Math.round(opp.salaryMaxPaise / 100)));
      if (opp?.salaryCurrency) setOfferCurrency(opp.salaryCurrency);
      if (opp?.compensationPeriod) setOfferPeriod(opp.compensationPeriod);
    },
    [opportunities]
  );

  // Deliberately keyed on composerOpen only: the prefill is a one-shot
  // convenience copy when the composer opens (RD-17); later opportunity
  // switches while the dialog is open must not clobber employer edits.
  useEffect(() => {
    if (composerOpen) prefillFromOpportunity(opportunityId);
  }, [composerOpen]);

  const minRupees = Number(offerMin);
  const maxRupees = Number(offerMax);
  const offerValid =
    pickId !== "" &&
    Number.isSafeInteger(minRupees) &&
    Number.isSafeInteger(maxRupees) &&
    minRupees >= 0 &&
    maxRupees >= minRupees;

  const submitComposer = useCallback(
    async (send: boolean) => {
      if (!offerValid || !orgId || !opportunityId) return;
      setBusy(true);
      try {
        await api("/api/opportunities/invitations", {
          method: "POST",
          json: {
            organizationId: orgId,
            opportunityId,
            candidateUserId: pickId,
            send,
            offer: {
              offerSalaryMinPaise: Math.round(minRupees * 100),
              offerSalaryMaxPaise: Math.round(maxRupees * 100),
              offerCurrency: offerCurrency,
              offerPeriod: offerPeriod,
            },
          },
        });
        toast.success(send ? "Invitation sent to the candidate." : "Draft saved.");
        setComposerOpen(false);
        setConfirmStep(false);
        await loadInvitations(orgId, opportunityId);
      } catch (e) {
        if (e instanceof ApiError) toast.error(e.message);
        else toast.error("Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [offerValid, orgId, opportunityId, pickId, minRupees, maxRupees, offerCurrency, offerPeriod, loadInvitations]
  );

  const openDetail = useCallback(async (invitationId: string) => {
    setDetailId(invitationId);
    setDetail(null);
    setCounterMin("");
    setCounterMax("");
    try {
      // The list already carries the full thread; re-read the single row so
      // the dialog always shows the freshest state.
      const data = await api<{ invitations: InvitationDTO[] }>(
        `/api/opportunities/invitations?organizationId=${orgId}`
      );
      const found = data.invitations.find((i) => i.id === invitationId) ?? null;
      setDetail(found);
    } catch {
      setDetail(null);
    }
  }, [orgId]);

  const refreshDetailAndList = useCallback(async () => {
    await loadInvitations(orgId, opportunityId);
    if (detailId) {
      try {
        const data = await api<{ invitations: InvitationDTO[] }>(
          `/api/opportunities/invitations?organizationId=${orgId}`
        );
        setDetail(data.invitations.find((i) => i.id === detailId) ?? null);
      } catch {
        setDetail(null);
      }
    }
  }, [loadInvitations, orgId, opportunityId, detailId]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await fn();
        toast.success(successMessage);
        await refreshDetailAndList();
      } catch (e) {
        if (e instanceof ApiError) toast.error(e.message);
        else toast.error("Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [refreshDetailAndList]
  );

  const pendingProposal = detail?.negotiations.find((n) => n.status === "PENDING") ?? null;
  const canWithdraw = detail && ["SENT", "VIEWED", "NEGOTIATION_REQUESTED"].includes(detail.status);
  const counterValid =
    Number.isSafeInteger(Number(counterMin)) &&
    Number.isSafeInteger(Number(counterMax)) &&
    Number(counterMin) >= 0 &&
    Number(counterMax) >= Number(counterMin) &&
    counterMin !== "";

  const selectedOpportunitySendable = selectedOpportunity?.status === "PUBLISHED";

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6">
        <SectionHeader
          title="Invitations sent"
          description="Invite consented, currently-eligible candidates to your opportunities, negotiate compensation transparently, and keep the full immutable history."
          as="h3"
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ox-inv-org">Organization</Label>
            <Select
              value={orgId}
              onValueChange={(v) => {
                setOrgId(v);
                setOpportunityId("");
                setInvitations(null);
              }}
            >
              <SelectTrigger id="ox-inv-org" aria-label="Select organization">
                <SelectValue placeholder="Select a verified organization" />
              </SelectTrigger>
              <SelectContent>
                {verifiedOrgs.map((m) => (
                  <SelectItem key={m.organization.id} value={m.organization.id}>
                    {m.organization.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ox-inv-opportunity">Opportunity</Label>
            <Select
              value={opportunityId}
              onValueChange={(v) => setOpportunityId(v)}
              disabled={!orgId}
            >
              <SelectTrigger id="ox-inv-opportunity" aria-label="Select opportunity">
                <SelectValue placeholder={orgId ? "Select an opportunity" : "Pick an organization first"} />
              </SelectTrigger>
              <SelectContent>
                {opportunities.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title} · {o.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selectedOpportunity
              ? selectedOpportunitySendable
                ? "New invitations can be sent for this published opportunity."
                : "New sends are paused for this opportunity — existing invitations stay interactive."
              : "Pick an organization and opportunity to manage its invitations."}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void loadInvitations(orgId, opportunityId)} disabled={!orgId}>
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
              <span className="sr-only">Refresh invitations</span>
            </Button>
            <Button size="sm" onClick={() => void openComposer()} disabled={!orgId || !selectedOpportunitySendable}>
              <MailPlus className="size-4" aria-hidden />
              New invitation
            </Button>
          </div>
        </div>

        {loading && invitations === null ? (
          <div className="mt-5 space-y-3" role="status" aria-label="Loading invitations">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !orgId ? null : invitations === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Invitations could not be loaded.</p>
        ) : invitations.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={Inbox}
              title="No invitations yet"
              description="Invite a currently-eligible match or shortlisted candidate — every send re-validates consent and eligibility in the moment."
            />
          </div>
        ) : (
          <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Invitations sent">
            {invitations.map((inv) => (
              <li key={inv.id}>
                <Card className="border-border/40">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {masked(inv.candidateState) ? (
                            <>
                              Candidate <span className="font-mono text-xs text-muted-foreground">{(inv.candidateUserId ?? "").slice(0, 10)}…</span>
                              <span className="ml-2 text-xs text-muted-foreground">({MASKED_LABEL[inv.candidateState] ?? inv.candidateState})</span>
                            </>
                          ) : (
                            <>
                              Candidate <span className="font-mono text-xs text-muted-foreground">{(inv.candidateUserId ?? "").slice(0, 10)}…</span>
                            </>
                          )}
                        </p>
                        <div className="mt-1">
                          <SalaryRange
                            minPaise={inv.offer.salaryMinPaise}
                            maxPaise={inv.offer.salaryMaxPaise}
                            currency={inv.offer.currency}
                            period={inv.offer.period}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {inv.sentAt ? `Sent ${new Date(inv.sentAt).toLocaleString()}` : "Not sent yet"}
                          {inv.expiresAt && !["ACCEPTED", "DECLINED", "WITHDRAWN"].includes(inv.status)
                            ? ` · expires ${new Date(inv.expiresAt).toLocaleString()}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={cn("border-transparent", STATUS_TONE[inv.status] ?? "bg-muted")}>
                          {STATUS_LABEL[inv.status] ?? inv.status}
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => void openDetail(inv.id)}>
                          <History className="size-4" aria-hidden />
                          Detail
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {/* -------- composer -------- */}
        <Dialog open={composerOpen} onOpenChange={(open) => !open && setComposerOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">New invitation</DialogTitle>
              <DialogDescription>
                {confirmStep
                  ? "Confirm before send — this snapshot is what the candidate will see, frozen at send time."
                  : "Pick a currently-eligible candidate and set the offer. The server re-validates eligibility, quotas and cooldowns at send."}
              </DialogDescription>
            </DialogHeader>

            {!confirmStep ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ox-inv-candidate">Candidate (eligible matches + shortlist)</Label>
                  <Select value={pickId} onValueChange={setPickId}>
                    <SelectTrigger id="ox-inv-candidate" aria-label="Select candidate">
                      <SelectValue placeholder={picker === null ? "Loading eligible candidates…" : picker.length === 0 ? "No eligible candidates" : "Select a candidate"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(picker ?? []).map((c) => (
                        <SelectItem key={c.candidateUserId} value={c.candidateUserId}>
                          Candidate {c.candidateUserId.slice(0, 10)}… ·{" "}
                          {c.source === "MATCH" ? `match${typeof c.score === "number" ? ` ${c.score}` : ""}` : "shortlist"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ox-inv-min">Offer minimum (₹)</Label>
                    <Input
                      id="ox-inv-min"
                      inputMode="numeric"
                      value={offerMin}
                      onChange={(e) => setOfferMin(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="1200000"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ox-inv-max">Offer maximum (₹)</Label>
                    <Input
                      id="ox-inv-max"
                      inputMode="numeric"
                      value={offerMax}
                      onChange={(e) => setOfferMax(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="1500000"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ox-inv-currency">Currency</Label>
                    <Select value={offerCurrency} onValueChange={setOfferCurrency}>
                      <SelectTrigger id="ox-inv-currency" aria-label="Currency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["INR", "USD", "EUR", "GBP", "AED"].map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ox-inv-period">Period</Label>
                    <Select value={offerPeriod} onValueChange={setOfferPeriod}>
                      <SelectTrigger id="ox-inv-period" aria-label="Period">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERIODS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {p === "YEAR" ? "Per year" : p === "MONTH" ? "Per month" : "Per hour"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Snapshot preview</p>
                  <div className="mt-1.5">
                    <SalaryRange
                      minPaise={Number.isSafeInteger(minRupees) ? Math.round(minRupees * 100) : null}
                      maxPaise={Number.isSafeInteger(maxRupees) ? Math.round(maxRupees * 100) : null}
                      currency={offerCurrency}
                      period={offerPeriod}
                    />
                  </div>
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={() => void submitComposer(false)} disabled={!offerValid || busy}>
                    Save draft
                  </Button>
                  <Button onClick={() => setConfirmStep(true)} disabled={!offerValid || busy}>
                    <Send className="size-4" aria-hidden />
                    Continue to confirm
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-md border border-border/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Frozen compensation snapshot
                  </p>
                  <div className="mt-2">
                    <SalaryRange
                      minPaise={Math.round(minRupees * 100)}
                      maxPaise={Math.round(maxRupees * 100)}
                      currency={offerCurrency}
                      period={offerPeriod}
                      className="text-base"
                    />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Recipient: Candidate {pickId.slice(0, 10)}… — this snapshot can never be rewritten later, including
                    by future edits to the opportunity.
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Sending notifies the candidate and starts a 14-day response window. Every send is re-validated against
                  current consent and eligibility.
                </p>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => setConfirmStep(false)} disabled={busy}>
                    Back
                  </Button>
                  <Button onClick={() => void submitComposer(true)} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                    Confirm and send
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* -------- detail dialog -------- */}
        <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="font-display">Invitation detail</DialogTitle>
              <DialogDescription>
                The original offer, the full negotiation history and the truthful current state.
              </DialogDescription>
            </DialogHeader>
            {!detail ? (
              <div className="space-y-3" role="status" aria-label="Loading invitation">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{candidateLabel(detail.candidateUserId)}</p>
                    {masked(detail.candidateState) && (
                      <p className="text-xs text-muted-foreground">{MASKED_LABEL[detail.candidateState] ?? detail.candidateState}</p>
                    )}
                  </div>
                  <Badge className={cn("border-transparent", STATUS_TONE[detail.status] ?? "bg-muted")}>
                    {STATUS_LABEL[detail.status] ?? detail.status}
                  </Badge>
                </div>

                <div className="rounded-md border border-border/60 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Original offer (immutable)
                  </p>
                  <div className="mt-1.5">
                    <SalaryRange
                      minPaise={detail.offer.salaryMinPaise}
                      maxPaise={detail.offer.salaryMaxPaise}
                      currency={detail.offer.currency}
                      period={detail.offer.period}
                    />
                  </div>
                </div>

                {detail.accepted && (
                  <div className="rounded-md border border-emerald-600/40 bg-emerald-600/5 p-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                      <BadgeCheck className="size-3.5" aria-hidden />
                      Accepted terms (immutable snapshot)
                    </p>
                    <div className="mt-1.5">
                      <SalaryRange
                        minPaise={detail.accepted.salaryMinPaise}
                        maxPaise={detail.accepted.salaryMaxPaise}
                        currency={detail.accepted.currency}
                        period={detail.accepted.period}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Accepted {new Date(detail.accepted.acceptedAt).toLocaleString()}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Negotiation history ({detail.negotiations.length}/6 proposals)
                  </p>
                  {detail.negotiations.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No proposals yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.negotiations.map((n) => (
                        <li key={n.id} className="rounded-md border border-border/50 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium">
                              #{n.seq} · {n.proposerRole === "EMPLOYER" ? "Employer proposal" : "Candidate proposal"}
                            </span>
                            <Badge variant="outline" className="text-xs">
                              {n.status}
                            </Badge>
                          </div>
                          <div className="mt-1.5">
                            <SalaryRange
                              minPaise={n.proposedSalaryMinPaise}
                              maxPaise={n.proposedSalaryMaxPaise}
                              currency={n.proposedCurrency}
                              period={n.proposedPeriod}
                            />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {new Date(n.createdAt).toLocaleString()}
                            {n.status === "PENDING" ? ` · responds by ${new Date(n.expiresAt).toLocaleString()}` : ""}
                          </p>
                          {n.status === "PENDING" && n.proposerRole === "CANDIDATE" && detail.status === "NEGOTIATION_REQUESTED" && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/api/opportunities/invitations/${detail.id}/negotiations/${n.id}/accept`, {
                                        method: "POST",
                                        json: { organizationId: orgId },
                                      }),
                                    "Proposal accepted — terms frozen."
                                  )
                                }
                                disabled={busy}
                              >
                                Accept proposal
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/api/opportunities/invitations/${detail.id}/negotiations/${n.id}/decline`, {
                                        method: "POST",
                                        json: { organizationId: orgId },
                                      }),
                                    "Proposal declined — the invitation is now declined."
                                  )
                                }
                                disabled={busy}
                              >
                                Decline
                              </Button>
                            </div>
                          )}
                          {n.status === "PENDING" && n.proposerRole === "EMPLOYER" && detail.status === "NEGOTIATION_REQUESTED" && (
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/api/opportunities/invitations/${detail.id}/negotiations/${n.id}/withdraw`, {
                                        method: "POST",
                                        json: { organizationId: orgId },
                                      }),
                                    "Proposal withdrawn — the thread stays open."
                                  )
                                }
                                disabled={busy}
                              >
                                Withdraw my proposal
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {detail.status === "NEGOTIATION_REQUESTED" && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Counter-proposal (compensation only)
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Input
                        aria-label="Counter minimum (rupees)"
                        inputMode="numeric"
                        value={counterMin}
                        onChange={(e) => setCounterMin(e.target.value.replace(/[^0-9]/g, ""))}
                        placeholder="Min ₹"
                      />
                      <Input
                        aria-label="Counter maximum (rupees)"
                        inputMode="numeric"
                        value={counterMax}
                        onChange={(e) => setCounterMax(e.target.value.replace(/[^0-9]/g, ""))}
                        placeholder="Max ₹"
                      />
                    </div>
                    <div className="mt-2">
                      <SalaryRange
                        minPaise={counterValid ? Math.round(Number(counterMin) * 100) : null}
                        maxPaise={counterValid ? Math.round(Number(counterMax) * 100) : null}
                        currency={detail.offer.currency}
                        period={detail.offer.period}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="mt-2"
                      disabled={!counterValid || busy}
                      onClick={() =>
                        void act(
                          () =>
                            api(`/api/opportunities/invitations/${detail.id}/negotiations`, {
                              method: "POST",
                              json: {
                                organizationId: orgId,
                                terms: {
                                  proposedSalaryMinPaise: Math.round(Number(counterMin) * 100),
                                  proposedSalaryMaxPaise: Math.round(Number(counterMax) * 100),
                                  proposedCurrency: detail.offer.currency,
                                  proposedPeriod: detail.offer.period,
                                },
                              },
                            }),
                          "Counter-proposal sent — it supersedes the standing proposal."
                        )
                      }
                    >
                      <Send className="size-4" aria-hidden />
                      Send counter-proposal
                    </Button>
                  </div>
                )}

                {canWithdraw && (
                  <div className="rounded-md border border-destructive/40 p-3">
                    <p className="text-xs font-medium text-destructive">Withdraw this invitation</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The candidate will be notified and the invitation can never be reactivated. This cannot be undone.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 border-destructive/40 text-destructive"
                      onClick={() =>
                        void act(
                          () =>
                            api(`/api/opportunities/invitations/${detail.id}/withdraw`, {
                              method: "POST",
                              json: { organizationId: orgId },
                            }),
                          "Invitation withdrawn."
                        )
                      }
                      disabled={busy}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Withdraw invitation
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">20 sends/day · 200/month</Badge>
          <Badge variant="outline">7-day per-candidate cooldown</Badge>
          <Badge variant="outline">14-day response window</Badge>
          <Badge variant="outline">One active invitation per opportunity + candidate</Badge>
        </p>
      </CardContent>
    </Card>
  );
}
