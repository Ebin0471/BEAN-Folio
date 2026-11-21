"use client";

/**
 * OX admin verification review panel — the pilot's manual-review surface.
 *
 * Rendered inside the existing admin Moderation view (Trust & Safety), below
 * the community reports queue. Every action goes through the OX admin API
 * (requireAdmin server-side); decisions are recorded to the audit trail by
 * the API, never by this panel.
 */

import { useCallback, useEffect, useState } from "react";
import { Building2, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, formatDate } from "@/lib/client";
import { cn } from "@/lib/utils";

interface VerificationItem {
  id: string;
  status: string;
  method: string;
  evidenceReference: string | null;
  rejectionReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
  organization: {
    id: string;
    displayName: string;
    legalName: string;
    slug: string;
    industry: string | null;
    companySize: string | null;
    headquarters: string | null;
    verificationStatus: string;
    createdAt: string;
  };
}

function statusPill(status: string) {
  const map: Record<string, string> = {
    PENDING: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    VERIFIED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    REJECTED: "bg-red-500/15 text-red-300 border-red-500/30",
  };
  return (
    <Badge variant="outline" className={cn("text-[11px]", map[status] ?? "border-border text-muted-foreground")}>
      {status}
    </Badge>
  );
}

export default function OxAdminVerificationPanel() {
  const [items, setItems] = useState<VerificationItem[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<VerificationItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async (all: boolean) => {
    setError(null);
    try {
      const res = await api<{ verifications: VerificationItem[] }>(
        `/api/admin/ox/verifications?status=${all ? "ALL" : "PENDING"}`
      );
      setItems(res.verifications);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Could not load the verification queue.");
    }
  }, []);

  useEffect(() => {
    void load(showAll);
  }, [load, showAll]);

  async function decide(v: VerificationItem, decision: "APPROVE" | "REJECT", rejectionReason?: string) {
    setBusyId(v.id);
    try {
      await api(`/api/admin/ox/verifications/${v.id}`, {
        method: "PATCH",
        json: { decision, ...(rejectionReason ? { rejectionReason } : {}) },
      });
      toast.success(decision === "APPROVE" ? "Organization verified" : "Verification rejected");
      setRejectTarget(null);
      setRejectReason("");
      await load(showAll);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not record the decision.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-labelledby="ox-verifications-heading" className="mt-10 border-t border-border/60 pt-8">
      <SectionHeader
        title="Employer verifications"
        description="Opportunity Exchange pilot — manual review of employer organization submissions. Decisions are audit-recorded."
        as="h2"
      />
      <h2 id="ox-verifications-heading" className="sr-only">
        Employer verifications
      </h2>

      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant={showAll ? "ghost" : "secondary"} onClick={() => setShowAll(false)}>
          Pending
        </Button>
        <Button size="sm" variant={showAll ? "secondary" : "ghost"} onClick={() => setShowAll(true)}>
          All recent
        </Button>
      </div>

      {items === null ? (
        <p className="py-6 text-sm text-muted-foreground" role="status">
          Loading verification queue…
        </p>
      ) : error ? (
        <p className="py-6 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden />
          No {showAll ? "" : "pending "}verification submissions.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((v) => (
            <li
              key={v.id}
              className="rounded-lg border border-border/60 bg-card p-4"
              aria-label={`Verification from ${v.organization.displayName}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-gold-soft text-primary">
                    <Building2 className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{v.organization.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      /{v.organization.slug}
                      {v.organization.industry ? ` · ${v.organization.industry}` : ""}
                      {v.organization.companySize ? ` · ${v.organization.companySize}` : ""}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      Evidence reference: <span className="font-mono">{v.evidenceReference ?? "—"}</span>
                      {v.rejectionReason ? ` · Rejection: ${v.rejectionReason}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Submitted {formatDate(v.createdAt)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusPill(v.status)}
                  {v.status === "PENDING" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === v.id}
                        onClick={() => void decide(v, "APPROVE")}
                      >
                        <CheckCircle2 className="size-4" aria-hidden />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === v.id}
                        onClick={() => setRejectTarget(v)}
                      >
                        <XCircle className="size-4" aria-hidden />
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={rejectTarget !== null} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject verification</DialogTitle>
            <DialogDescription>
              {rejectTarget?.organization.displayName} stays unverified and may submit again. A reason is
              required and is recorded to the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="ox-reject-reason">Reason</Label>
            <Textarea
              id="ox-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="What must the organization provide or fix?"
              rows={3}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length === 0 || busyId === rejectTarget?.id}
              onClick={() => rejectTarget && void decide(rejectTarget, "REJECT", rejectReason.trim())}
            >
              Reject verification
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
