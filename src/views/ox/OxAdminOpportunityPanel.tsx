"use client";

/**
 * Trust & Safety (O3) — admin review queue for employer opportunities.
 *
 * Mounted in the Moderation view next to the O1 verification panel. Shows
 * the PENDING_REVIEW queue (or any status filter) with the organization,
 * salary and skill chips; APPROVE publishes (the only route to PUBLISHED —
 * approved lifecycle), REJECT requires a reason and returns the row to
 * DRAFT. Both decisions are enforced and audited server-side; this panel
 * only mirrors them.
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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Briefcase, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import { paiseToRupees } from "./candidate-profile-state";

interface SkillChipDTO {
  skillId: string;
  slug: string;
  label: string;
  kind: string;
}

interface OpportunityRowDTO {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  status: string;
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
  rejectionReason: string | null;
  skills: SkillChipDTO[];
  organization: {
    id: string;
    legalName: string;
    displayName: string;
    slug: string;
    verificationStatus: string;
  };
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

export default function OxAdminOpportunityPanel() {
  const [rows, setRows] = useState<OpportunityRowDTO[] | null>(null);
  const [filter, setFilter] = useState("PENDING_REVIEW");
  const [busy, setBusy] = useState("");
  const [rejecting, setRejecting] = useState<OpportunityRowDTO | null>(null);
  const [reason, setReason] = useState("");

  const reload = useCallback(async (status: string) => {
    setRows(null);
    try {
      const data = await api<{ opportunities: OpportunityRowDTO[] }>(
        `/api/admin/ox/opportunities?status=${encodeURIComponent(status)}`
      );
      setRows(data.opportunities);
    } catch (e) {
      toast.error(errText(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void reload(filter);
  }, [filter, reload]);

  async function decide(row: OpportunityRowDTO, decision: "APPROVE" | "REJECT") {
    setBusy(decision + row.id);
    try {
      await api(`/api/admin/ox/opportunities/${row.id}`, {
        method: "PATCH",
        json: decision === "REJECT" ? { decision, rejectionReason: reason.trim() } : { decision },
      });
      toast.success(decision === "APPROVE" ? "Approved — the opportunity is published." : "Rejected — returned to the employer as a draft.");
      setRejecting(null);
      setReason("");
      await reload(filter);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy("");
    }
  }

  return (
    <section aria-labelledby="ox-opportunity-review-heading" className="mt-10">
      <SectionHeader
        title="Opportunity review"
        description="Admin approval is the only route to publication. Rejected rows return to the employer as editable drafts."
        as="h2"
      />
      <h2 id="ox-opportunity-review-heading" className="sr-only">
        Opportunity review
      </h2>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Label className="sr-only" htmlFor="ox-opportunity-filter">
            Status filter
          </Label>
          <Select
            value={filter}
            onValueChange={(v) => {
              setFilter(v);
            }}
          >
            <SelectTrigger id="ox-opportunity-filter" aria-label="Status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING_REVIEW">Awaiting review</SelectItem>
              <SelectItem value="PUBLISHED">Published</SelectItem>
              <SelectItem value="PAUSED">Paused</SelectItem>
              <SelectItem value="DRAFT">Drafts</SelectItem>
              <SelectItem value="FILLED">Filled</SelectItem>
              <SelectItem value="CLOSED">Closed</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {rows === null ? (
          <>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="Nothing in this queue"
            description="Submitted opportunities awaiting review will appear here."
          />
        ) : (
          rows.map((row) => (
            <Card key={row.id}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-medium text-foreground">{row.title}</h4>
                      <Badge variant="outline" className="text-[11px]">
                        {row.status}
                      </Badge>
                      {row.organization.verificationStatus === "VERIFIED" && (
                        <Badge variant="outline" className="gap-1 border-primary/40 bg-gold-soft text-[11px] text-primary">
                          <ShieldCheck className="size-3" aria-hidden /> Verified org
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.organization.displayName} · {row.organization.slug}
                      {row.location ? ` · ${row.location}` : ""}
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{row.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.salaryMinPaise !== null && row.salaryMaxPaise !== null
                        ? `₹${paiseToRupees(row.salaryMinPaise)} – ₹${paiseToRupees(row.salaryMaxPaise)}${
                            row.salaryCurrency ? ` ${row.salaryCurrency}` : ""
                          }${row.compensationPeriod ? ` · ${row.compensationPeriod}` : ""}`
                        : "Salary: incomplete"}
                      {row.positions !== null ? ` · ${row.positions} position${row.positions > 1 ? "s" : ""}` : ""}
                    </p>
                    {row.skills.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Attached skills">
                        {row.skills.map((s) => (
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
                  {row.status === "PENDING_REVIEW" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => decide(row, "APPROVE")} disabled={busy !== ""} className="gap-1.5">
                        {busy === "APPROVE" + row.id && <Loader2 className="size-4 animate-spin" aria-hidden />}
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setRejecting(row);
                          setReason("");
                        }}
                        disabled={busy !== ""}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this opportunity?</DialogTitle>
            <DialogDescription>
              {rejecting?.title} returns to the employer as an editable draft. A reason is required and is shared with
              the organization.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ox-opportunity-reject-reason">Reason</Label>
            <Textarea
              id="ox-opportunity-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="What must change before this listing can be approved?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => rejecting && decide(rejecting, "REJECT")}
              disabled={busy !== "" || reason.trim().length === 0}
              className="gap-2"
            >
              {busy === "REJECT" + rejecting?.id && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
