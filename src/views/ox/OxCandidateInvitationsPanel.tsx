"use client";

/**
 * Opportunity Exchange (M-O6) — candidate invitations inbox.
 *
 * Mounted inside the "For professionals" section of the Opportunity Exchange
 * (after the transparency panel). The inbox IS the history: every own
 * invitation in every truthful state (SENT / VIEWED / negotiating /
 * ACCEPTED / DECLINED / EXPIRED / WITHDRAWN) with the unread dot and count
 * (RD-18: unread = SENT not yet opened). The detail dialog renders the
 * employer's PUBLIC identity, the opportunity, the immutable original offer
 * (Part L), the full append-only negotiation history and the current
 * pending proposal with accept / reject / counter / withdraw controls.
 *
 * Override B (owner): invitation response rights survive discovery-consent
 * revocation — this surface never consults consent and never exposes more
 * than the correspondence itself. Opening an invitation records VIEWED
 * automatically (RD-18).
 */

import { useCallback, useEffect, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { BadgeCheck, Handshake, Inbox, Loader2, RefreshCw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import SalaryRange from "./SalaryRange";

// ------------------------------------------------------------------ types

interface NegotiationDTO {
  id: string;
  seq: number;
  proposerRole: string;
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
  status: string;
  unread?: boolean;
  offer: { salaryMinPaise: number | null; salaryMaxPaise: number | null; currency: string; period: string };
  accepted: { salaryMinPaise: number | null; salaryMaxPaise: number | null; currency: string | null; period: string | null; acceptedAt: string } | null;
  sentAt: string | null;
  viewedAt: string | null;
  respondedAt: string | null;
  withdrawnAt: string | null;
  expiresAt: string | null;
  organization: { id: string; displayName: string; slug: string };
  opportunity: { id: string; title: string; status: string };
  negotiations?: NegotiationDTO[];
}

const STATUS_LABEL: Record<string, string> = {
  SENT: "New invitation",
  VIEWED: "Opened",
  NEGOTIATION_REQUESTED: "Negotiating",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  WITHDRAWN: "Withdrawn",
};

const STATUS_TONE: Record<string, string> = {
  SENT: "bg-gold-soft text-primary",
  VIEWED: "bg-secondary text-secondary-foreground",
  NEGOTIATION_REQUESTED: "bg-gold-soft text-primary",
  ACCEPTED: "bg-emerald-600 text-white",
  DECLINED: "bg-destructive/10 text-destructive",
  EXPIRED: "bg-muted text-muted-foreground",
  WITHDRAWN: "bg-muted text-muted-foreground",
};

function actionable(status: string): boolean {
  return status === "SENT" || status === "VIEWED";
}

// ------------------------------------------------------------------ component

export default function OxCandidateInvitationsPanel() {
  const [invitations, setInvitations] = useState<InvitationDTO[] | null>(null);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InvitationDTO | null>(null);
  const [counterMin, setCounterMin] = useState<string>("");
  const [counterMax, setCounterMax] = useState<string>("");
  const [confirmAction, setConfirmAction] = useState<"ACCEPT" | "DECLINE" | "NEGOTIATE" | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api<{ invitations: InvitationDTO[]; unreadCount: number }>(
        "/api/opportunities/me/invitations"
      );
      setInvitations(data.invitations);
      setUnreadCount(data.unreadCount);
    } catch (e) {
      setInvitations(null);
      if (e instanceof ApiError && e.status !== 401) toast.error(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(
    async (invitationId: string) => {
      setDetailId(invitationId);
      setDetail(null);
      setCounterMin("");
      setCounterMax("");
      setConfirmAction(null);
      try {
        // The first authorized read records VIEWED automatically (RD-18).
        const data = await api<{ invitation: InvitationDTO }>(
          `/api/opportunities/me/invitations/${invitationId}`
        );
        setDetail(data.invitation);
        await load();
      } catch (e) {
        setDetail(null);
        if (e instanceof ApiError) toast.error(e.message);
      }
    },
    [load]
  );

  const refreshAll = useCallback(async () => {
    await load();
    if (detailId) {
      try {
        const data = await api<{ invitation: InvitationDTO }>(
          `/api/opportunities/me/invitations/${detailId}`
        );
        setDetail(data.invitation);
      } catch {
        setDetail(null);
      }
    }
  }, [load, detailId]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      try {
        await fn();
        toast.success(successMessage);
        await refreshAll();
      } catch (e) {
        if (e instanceof ApiError) toast.error(e.message);
        else toast.error("Something went wrong");
      } finally {
        setBusy(false);
      }
    },
    [refreshAll]
  );

  const pendingProposal = detail?.negotiations?.find((n) => n.status === "PENDING") ?? null;
  const counterValid =
    counterMin !== "" &&
    Number.isSafeInteger(Number(counterMin)) &&
    Number.isSafeInteger(Number(counterMax)) &&
    Number(counterMin) >= 0 &&
    Number(counterMax) >= Number(counterMin);

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6">
        <SectionHeader
          title="Invitations"
          description="Opportunity invitations from verified employers — accept, decline, or negotiate the compensation. Your access to your own invitations survives any discovery-consent change."
          as="h3"
        />

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {unreadCount > 0 ? `${unreadCount} unread invitation${unreadCount === 1 ? "" : "s"}` : "All invitations opened"}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing}>
            {refreshing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
            <span className="sr-only">Refresh invitations</span>
          </Button>
        </div>

        {loading && invitations === null ? (
          <div className="mt-4 space-y-3" role="status" aria-label="Loading invitations">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : invitations === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Invitations could not be loaded.</p>
        ) : invitations.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={Inbox}
              title="No invitations yet"
              description="When a verified employer invites you through your consented matches or their shortlist, it appears here with the full offer."
            />
          </div>
        ) : (
          <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Your invitations">
            {invitations.map((inv) => (
              <li key={inv.id}>
                <Card className="border-border/40">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          {inv.unread && <span className="inline-block size-2 rounded-full bg-primary" aria-label="Unread" />}
                          {inv.organization.displayName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {inv.opportunity.title} · {inv.opportunity.status}
                        </p>
                        <div className="mt-1.5">
                          <SalaryRange
                            minPaise={inv.offer.salaryMinPaise}
                            maxPaise={inv.offer.salaryMaxPaise}
                            currency={inv.offer.currency}
                            period={inv.offer.period}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {inv.sentAt ? `Received ${new Date(inv.sentAt).toLocaleString()}` : ""}
                          {inv.expiresAt && actionable(inv.status) ? ` · respond by ${new Date(inv.expiresAt).toLocaleString()}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={cn("border-transparent", STATUS_TONE[inv.status] ?? "bg-muted")}>
                          {STATUS_LABEL[inv.status] ?? inv.status}
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => void openDetail(inv.id)}>
                          Open
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}

        {/* -------- detail dialog -------- */}
        <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="font-display">Invitation from {detail?.organization.displayName ?? "…"}</DialogTitle>
              <DialogDescription>
                {detail ? `${detail.opportunity.title} · ${detail.opportunity.status}` : "Loading the full history…"}
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
                  <Badge className={cn("border-transparent", STATUS_TONE[detail.status] ?? "bg-muted")}>
                    {STATUS_LABEL[detail.status] ?? detail.status}
                  </Badge>
                  <p className="text-xs text-muted-foreground">
                    {detail.sentAt ? `Received ${new Date(detail.sentAt).toLocaleString()}` : ""}
                    {detail.expiresAt ? ` · window closed ${new Date(detail.expiresAt).toLocaleString()}` : ""}
                  </p>
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

                {actionable(detail.status) && confirmAction === null && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => setConfirmAction("ACCEPT")}
                      disabled={busy}
                    >
                      <BadgeCheck className="size-4" aria-hidden />
                      Accept offer
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmAction("DECLINE")} disabled={busy}>
                      <XCircle className="size-4" aria-hidden />
                      Decline
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmAction("NEGOTIATE")} disabled={busy}>
                      <Handshake className="size-4" aria-hidden />
                      Negotiate
                    </Button>
                  </div>
                )}

                {confirmAction === "ACCEPT" && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-sm font-medium">Accept this invitation?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The original offer is frozen as the accepted terms exactly once and can never change.
                    </p>
                    <DialogFooter className="mt-3 gap-2">
                      <Button variant="ghost" onClick={() => setConfirmAction(null)} disabled={busy}>
                        Back
                      </Button>
                      <Button
                        onClick={() =>
                          void act(
                            () => api(`/api/opportunities/me/invitations/${detail.id}/accept`, { method: "POST", json: {} }),
                            "Invitation accepted — terms frozen."
                          )
                        }
                        disabled={busy}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <BadgeCheck className="size-4" aria-hidden />}
                        Confirm acceptance
                      </Button>
                    </DialogFooter>
                  </div>
                )}

                {confirmAction === "DECLINE" && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-sm font-medium">Decline this invitation?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The employer will be notified and the invitation becomes final. This cannot be undone.
                    </p>
                    <DialogFooter className="mt-3 gap-2">
                      <Button variant="ghost" onClick={() => setConfirmAction(null)} disabled={busy}>
                        Back
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() =>
                          void act(
                            () => api(`/api/opportunities/me/invitations/${detail.id}/decline`, { method: "POST", json: {} }),
                            "Invitation declined."
                          )
                        }
                        disabled={busy}
                      >
                        Confirm decline
                      </Button>
                    </DialogFooter>
                  </div>
                )}

                {confirmAction === "NEGOTIATE" && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-sm font-medium">Request negotiation</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Open a compensation-only negotiation — optionally include your proposed range right away.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="ox-my-counter-min" className="text-xs">
                          Your minimum (₹)
                        </Label>
                        <Input
                          id="ox-my-counter-min"
                          inputMode="numeric"
                          value={counterMin}
                          onChange={(e) => setCounterMin(e.target.value.replace(/[^0-9]/g, ""))}
                          placeholder="1300000"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ox-my-counter-max" className="text-xs">
                          Your maximum (₹)
                        </Label>
                        <Input
                          id="ox-my-counter-max"
                          inputMode="numeric"
                          value={counterMax}
                          onChange={(e) => setCounterMax(e.target.value.replace(/[^0-9]/g, ""))}
                          placeholder="1600000"
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <SalaryRange
                        minPaise={counterValid ? Math.round(Number(counterMin) * 100) : null}
                        maxPaise={counterValid ? Math.round(Number(counterMax) * 100) : null}
                        currency={detail.offer.currency}
                        period={detail.offer.period}
                      />
                    </div>
                    <DialogFooter className="mt-3 gap-2">
                      <Button variant="ghost" onClick={() => setConfirmAction(null)} disabled={busy}>
                        Back
                      </Button>
                      <Button
                        onClick={() =>
                          void act(
                            () =>
                              api(`/api/opportunities/me/invitations/${detail.id}/negotiation-request`, {
                                method: "POST",
                                json: counterValid
                                  ? {
                                      terms: {
                                        proposedSalaryMinPaise: Math.round(Number(counterMin) * 100),
                                        proposedSalaryMaxPaise: Math.round(Number(counterMax) * 100),
                                        proposedCurrency: detail.offer.currency,
                                        proposedPeriod: detail.offer.period,
                                      },
                                    }
                                  : {},
                              }),
                            "Negotiation requested — the employer has been notified."
                          )
                        }
                        disabled={busy}
                      >
                        <Handshake className="size-4" aria-hidden />
                        {counterValid ? "Request negotiation with proposal" : "Request negotiation"}
                      </Button>
                    </DialogFooter>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Negotiation history ({detail.negotiations?.length ?? 0}/6 proposals)
                  </p>
                  {(detail.negotiations?.length ?? 0) === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No proposals yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {(detail.negotiations ?? []).map((n) => (
                        <li key={n.id} className="rounded-md border border-border/50 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium">
                              #{n.seq} · {n.proposerRole === "EMPLOYER" ? "Employer proposal" : "Your proposal"}
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
                          {n.status === "PENDING" && n.proposerRole === "EMPLOYER" && detail.status === "NEGOTIATION_REQUESTED" && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/api/opportunities/me/invitations/${detail.id}/negotiations/${n.id}/accept`, {
                                        method: "POST",
                                        json: {},
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
                                      api(`/api/opportunities/me/invitations/${detail.id}/negotiations/${n.id}/decline`, {
                                        method: "POST",
                                        json: {},
                                      }),
                                    "Proposal rejected — the invitation is now declined."
                                  )
                                }
                                disabled={busy}
                              >
                                Reject
                              </Button>
                            </div>
                          )}
                          {n.status === "PENDING" && n.proposerRole === "CANDIDATE" && detail.status === "NEGOTIATION_REQUESTED" && (
                            <div className="mt-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/api/opportunities/me/invitations/${detail.id}/negotiations/${n.id}/withdraw`, {
                                        method: "POST",
                                        json: {},
                                      }),
                                    "Your proposal was withdrawn — the thread stays open."
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
                      Send a counter-proposal (compensation only)
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
                            api(`/api/opportunities/me/invitations/${detail.id}/negotiations`, {
                              method: "POST",
                              json: {
                                proposedSalaryMinPaise: Math.round(Number(counterMin) * 100),
                                proposedSalaryMaxPaise: Math.round(Number(counterMax) * 100),
                                proposedCurrency: detail.offer.currency,
                                proposedPeriod: detail.offer.period,
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

                <p className="text-xs text-muted-foreground">
                  Negotiation is compensation-only — six proposals maximum per invitation, one pending at a time.
                  Declining the standing proposal declines the invitation.
                </p>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
