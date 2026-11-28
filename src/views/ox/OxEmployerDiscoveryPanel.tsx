"use client";

/**
 * Opportunity Exchange (M-O5) — the employer discovery & shortlist console.
 *
 * Mounted inside the employer workspace section of the Opportunity Exchange.
 * Per-opportunity talent discovery (approved decision D11): pick a verified
 * organization and one of its opportunities, review the deterministic
 * `O4-MATCH-V1` matches with their factor explanations, and build the
 * opportunity's shortlist.
 *
 * The UI only MIRRORS what the server enforces (house rule): eligibility,
 * consent, visibility, salary disclosure and tenant authorization are all
 * re-validated server-side on every action; masked states (consent revoked,
 * candidate paused/hidden, blocked, unavailable) render truthfully exactly
 * as the API reports them (D7/D9/D14). PAUSED opportunities show frozen
 * matches with an honest banner; terminal opportunities are read-only (D6).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ListPlus, Loader2, RefreshCw, Search, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

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
}

interface MatchExplanationFactor {
  key: string;
  label: string;
  weight: number;
  earned?: number;
  max?: number;
  applied?: boolean;
  reason?: string;
}

interface MatchDTO {
  candidateUserId: string;
  matchVersion: string;
  score: number;
  generatedAt: string;
  state: string;
  explanation?: { activeFactorCount?: number; factors?: MatchExplanationFactor[] } | null;
  candidate?: {
    employmentTypes?: string[];
    workModes?: string[];
    preferredLocations?: string[];
    experienceMinYears?: number | null;
    experienceMaxYears?: number | null;
    availableFrom?: string | null;
    compensation?: { currency: string; period: string; minPaise: number; maxPaise: number } | null;
  } | null;
}

interface ShortlistEntryDTO {
  id: string;
  candidateUserId: string;
  note: string | null;
  scoreAtAdd: number | null;
  matchVersionAtAdd: string | null;
  status: string;
  addedAt: string;
  state: string;
  candidate?: Record<string, unknown> | null;
}

const STATE_LABEL: Record<string, string> = {
  LIVE: "Available",
  FROZEN: "Frozen (paused listing)",
  MASKED_CONSENT: "Consent withdrawn",
  MASKED_VISIBILITY: "Profile paused or hidden",
  MASKED_BLOCKED: "Not available",
  MASKED_UNAVAILABLE: "No longer available",
  LISTED: "On shortlist",
};

const REASON_LABEL: Record<string, string> = {
  NO_REQUIRED_SKILLS_DECLARED: "No required skills declared for this opportunity",
  NO_PREFERRED_SKILLS_DECLARED: "No preferred skills declared for this opportunity",
  OPPORTUNITY_PROFESSION_UNSET: "Opportunity has no profession set",
  CANDIDATE_PROFESSION_PREFERENCES_UNSET: "Candidate has not declared profession preferences",
  OPPORTUNITY_WORK_MODE_UNSET: "Opportunity has no work mode set",
  CANDIDATE_WORK_MODES_UNSET: "Candidate has not declared work modes",
  OPPORTUNITY_LOCATION_UNSET: "Opportunity has no location set",
  CANDIDATE_LOCATIONS_UNSET: "Candidate has not declared locations",
  CANDIDATE_AVAILABILITY_UNSET: "Candidate has not declared availability",
  COMPENSATION_NOT_DISCLOSED_TO_THIS_REQUESTER: "Compensation not compared — candidate keeps it private",
  NOT_EVALUABLE_NO_OPPORTUNITY_INPUT: "Experience not compared — no opportunity input exists",
};

function scoreTone(score: number): string {
  if (score >= 75) return "text-primary";
  if (score >= 50) return "text-foreground";
  return "text-muted-foreground";
}

function masked(state: string): boolean {
  return state.startsWith("MASKED");
}

// ------------------------------------------------------------------ component

export default function OxEmployerDiscoveryPanel() {
  const [memberships, setMemberships] = useState<MeMembershipDTO[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [opportunities, setOpportunities] = useState<OpportunityLiteDTO[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>("");
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
  const [matchState, setMatchState] = useState<string>("");
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [shortlist, setShortlist] = useState<ShortlistEntryDTO[] | null>(null);
  const [shortlistEditable, setShortlistEditable] = useState(true);
  const [noteTarget, setNoteTarget] = useState<{ candidateUserId: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const verifiedOrgs = useMemo(() => memberships.filter((m) => m.status === "ACTIVE" && m.organization.verificationStatus === "VERIFIED"), [memberships]);

  const loadMatches = useCallback(async (oid: string, opid: string) => {
    setLoading(true);
    try {
      const data = await api<{ matchState: string; total: number; matches: MatchDTO[] }>(
        `/api/employers/${oid}/opportunities/${opid}/matches`
      );
      setMatches(data.matches);
      setMatchState(data.matchState);
      setTotal(data.total);
    } catch (e) {
      setMatches(null);
      setTotal(0);
      if (e instanceof ApiError) {
        if (e.status === 409) toast.error("Matching requires a published opportunity.");
        else if (e.status === 403) toast.error("Discovery needs a verified organization.");
        else toast.error(e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShortlist = useCallback(async (oid: string, opid: string) => {
    try {
      const data = await api<{ editable: boolean; entries: ShortlistEntryDTO[] }>(
        `/api/employers/${oid}/opportunities/${opid}/shortlist`
      );
      setShortlist(data.entries);
      setShortlistEditable(data.editable);
    } catch {
      setShortlist(null);
    }
  }, []);

  useEffect(() => {
    api<{ memberships: MeMembershipDTO[] }>("/api/employers/me")
      .then((d) => setMemberships(d.memberships))
      .catch(() => setMemberships([]));
  }, []);

  useEffect(() => {
    if (!orgId) {
      setOpportunities([]);
      return;
    }
    api<{ opportunities: OpportunityLiteDTO[] }>(`/api/employers/${orgId}/opportunities`)
      .then((d) => {
        setOpportunities(d.opportunities);
        setOpportunityId("");
        setMatches(null);
        setShortlist(null);
      })
      .catch(() => setOpportunities([]));
  }, [orgId]);

  const selectOpportunity = useCallback(
    (opid: string) => {
      setOpportunityId(opid);
      if (orgId && opid) {
        void loadMatches(orgId, opid);
        void loadShortlist(orgId, opid);
      }
    },
    [orgId, loadMatches, loadShortlist]
  );

  const recompute = useCallback(async () => {
    if (!orgId || !opportunityId) return;
    setRecomputing(true);
    try {
      await api(`/api/employers/${orgId}/opportunities/${opportunityId}/matches`, { method: "POST" });
      toast.success("Matches recomputed.");
      await loadMatches(orgId, opportunityId);
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.status === 409 ? "Recomputation requires a published opportunity." : e.message);
    } finally {
      setRecomputing(false);
    }
  }, [orgId, opportunityId, loadMatches]);

  const addToShortlist = useCallback(
    async (candidateUserId: string, note?: string) => {
      if (!orgId || !opportunityId) return;
      setBusy(true);
      try {
        await api(`/api/employers/${orgId}/opportunities/${opportunityId}/shortlist`, {
          method: "POST",
          json: { candidateUserId, ...(note ? { note } : {}) },
        });
        toast.success("Added to shortlist.");
        setNoteTarget(null);
        await loadShortlist(orgId, opportunityId);
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 409 && e.message.includes("already")) toast.error("Already on this shortlist.");
          else if (e.status === 409) toast.error("The candidate is not currently an eligible match — the list was re-checked and they are no longer discoverable.");
          else toast.error(e.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [orgId, opportunityId, loadShortlist]
  );

  const removeFromShortlist = useCallback(
    async (entryId: string) => {
      if (!orgId || !opportunityId) return;
      setBusy(true);
      try {
        await api(`/api/employers/${orgId}/opportunities/${opportunityId}/shortlist/${entryId}`, { method: "DELETE" });
        toast.success("Removed from shortlist.");
        await loadShortlist(orgId, opportunityId);
      } catch (e) {
        if (e instanceof ApiError) toast.error(e.status === 409 ? "A terminal opportunity's shortlist is read-only." : e.message);
      } finally {
        setBusy(false);
      }
    },
    [orgId, opportunityId, loadShortlist]
  );

  const updateNote = useCallback(
    async (entryId: string, note: string) => {
      if (!orgId || !opportunityId) return;
      setBusy(true);
      try {
        await api(`/api/employers/${orgId}/opportunities/${opportunityId}/shortlist/${entryId}`, { method: "PATCH", json: { note } });
        toast.success("Note saved.");
        await loadShortlist(orgId, opportunityId);
      } catch (e) {
        if (e instanceof ApiError) toast.error(e.message);
      } finally {
        setBusy(false);
      }
    },
    [orgId, opportunityId, loadShortlist]
  );

  const shortlistedIds = useMemo(() => new Set((shortlist ?? []).map((e) => e.candidateUserId)), [shortlist]);

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6 lg:p-8">
        <SectionHeader
          title="Discover talent"
          description="Deterministic, explainable matches for one published opportunity — consented candidates only, re-verified on every view."
          as="h3"
        />

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ox-discovery-org">Organization</Label>
            <Select value={orgId} onValueChange={setOrgId}>
              <SelectTrigger id="ox-discovery-org" aria-label="Organization for discovery">
                <SelectValue placeholder="Choose a verified organization" />
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
          <div className="space-y-2">
            <Label htmlFor="ox-discovery-opp">Opportunity</Label>
            <Select value={opportunityId} onValueChange={selectOpportunity} disabled={!orgId}>
              <SelectTrigger id="ox-discovery-opp" aria-label="Opportunity for discovery">
                <SelectValue placeholder="Choose an opportunity" />
              </SelectTrigger>
              <SelectContent>
                {opportunities.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title} ({o.status})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {!orgId ? (
          <div className="mt-8">
            <EmptyState
              className="px-8 py-16"
              icon={Search}
              title="Pick a verified organization"
              description="Talent discovery is per-opportunity and only for VERIFIED organizations."
            />
          </div>
        ) : !opportunityId ? (
          <div className="mt-8">
            <EmptyState className="px-8 py-16" icon={Search} title="Pick an opportunity" description="Matches are computed for one opportunity at a time." />
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {matchState === "LIVE" && `${total} eligible match${total === 1 ? "" : "es"} — recomputed live on every view`}
                {matchState === "FROZEN" && `Frozen list — the listing is paused; no new matching runs (${total} stored)`}
                {matchState === "TERMINAL" && `Read-only — the listing has ended (${total} stored)`}
              </p>
              <Button variant="outline" size="sm" onClick={recompute} disabled={recomputing || matchState !== "LIVE"}>
                {recomputing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                Recompute
              </Button>
            </div>

            {loading ? (
              <div className="mt-4 space-y-3" role="status" aria-label="Loading matches">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : matches && matches.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {matches.map((m) => (
                  <li key={m.candidateUserId}>
                    <Card className="border-border/40">
                      <CardContent className="p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div
                              className={cn("grid size-12 shrink-0 place-items-center rounded-full border border-border/60 font-display text-sm font-semibold", scoreTone(m.score))}
                              aria-label={`Match score ${m.score} out of 100`}
                            >
                              {m.score}
                            </div>
                            <div>
                              <p className="font-medium">
                                Candidate <span className="font-mono text-xs text-muted-foreground">{m.candidateUserId.slice(0, 10)}…</span>
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {masked(m.state) ? STATE_LABEL[m.state] : `${m.explanation?.activeFactorCount ?? 0} factors evaluated · ${m.matchVersion}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {masked(m.state) ? (
                              <Badge variant="outline">{STATE_LABEL[m.state] ?? m.state}</Badge>
                            ) : shortlistedIds.has(m.candidateUserId) ? (
                              <Badge className="bg-gold-soft text-primary">On shortlist</Badge>
                            ) : (
                              <Button size="sm" variant="outline" onClick={() => setNoteTarget({ candidateUserId: m.candidateUserId, note: "" })} disabled={!shortlistEditable || busy}>
                                <ListPlus className="size-4" aria-hidden />
                                Shortlist
                              </Button>
                            )}
                          </div>
                        </div>

                        {!masked(m.state) && m.candidate && (
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            {(m.candidate.workModes ?? []).map((w) => (
                              <Badge key={w} variant="outline">{w}</Badge>
                            ))}
                            {(m.candidate.employmentTypes ?? []).map((t) => (
                              <Badge key={t} variant="outline">{t}</Badge>
                            ))}
                            {(m.candidate.preferredLocations ?? []).slice(0, 3).map((l) => (
                              <Badge key={l} variant="outline">{l}</Badge>
                            ))}
                            {m.candidate.availableFrom && (
                              <Badge variant="outline">available {new Date(m.candidate.availableFrom).toLocaleDateString()}</Badge>
                            )}
                          </div>
                        )}

                        {!masked(m.state) && m.explanation?.factors && (
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs font-medium text-primary">Why this score</summary>
                            <ul className="mt-2 space-y-1">
                              {m.explanation.factors.map((f) => (
                                <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <span>{f.label}</span>
                                  {f.applied ? (
                                    <span className="text-muted-foreground">
                                      {f.earned}/{f.max} (weight {f.weight})
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground italic">{REASON_LABEL[f.reason ?? ""] ?? f.reason}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                            <p className="mt-2 text-xs text-muted-foreground">
                              An explanation aid — never a hiring probability. Scores are deterministic for the same data.
                            </p>
                          </details>
                        )}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-8">
                <EmptyState
                  className="px-8 py-16"
                  icon={Users}
                  title={matchState === "LIVE" ? "No eligible matches right now" : "No stored matches"}
                  description={
                    matchState === "LIVE"
                      ? "Candidates appear here only when they have an active profile, a current DISCOVERY consent, and pass the compatibility boundaries."
                      : "Matches are stored when a published opportunity is discovered; this listing has none yet."
                  }
                />
              </div>
            )}

            {/* ---------------- shortlist ---------------- */}
            <div className="mt-8">
              <h4 className="font-display text-base font-semibold">Shortlist</h4>
              <p className="mt-1 text-sm text-muted-foreground">
                Your working record for this opportunity. Every view re-checks the candidate's current consent and visibility.
              </p>
              {!shortlistEditable && (
                <p className="mt-2 text-xs text-muted-foreground" role="status">
                  This opportunity is {matchState === "TERMINAL" ? "closed — the shortlist is read-only" : "paused — existing entries remain editable"}.
                </p>
              )}
              {shortlist === null ? (
                <p className="mt-3 text-sm text-muted-foreground">Shortlist loads with the opportunity.</p>
              ) : shortlist.length === 0 ? (
                <div className="mt-3">
                  <EmptyState className="px-8 py-16" icon={Users} title="No shortlisted candidates yet" description="Add candidates from the matches above." />
                </div>
              ) : (
                <ul className="mt-3 space-y-2">
                  {shortlist.map((entry) => (
                    <li key={entry.id}>
                      <Card className="border-border/40">
                        <CardContent className="flex flex-wrap items-start justify-between gap-3 p-3">
                          <div>
                            <p className="text-sm font-medium">
                              Candidate <span className="font-mono text-xs text-muted-foreground">{entry.candidateUserId.slice(0, 10)}…</span>
                              {masked(entry.state) && <Badge variant="outline" className="ml-2">{STATE_LABEL[entry.state] ?? entry.state}</Badge>}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              score at add: {entry.scoreAtAdd ?? "—"} · {entry.matchVersionAtAdd ?? "—"} · added{" "}
                              {new Date(entry.addedAt).toLocaleDateString()}
                              {entry.status === "ARCHIVED" && " · archived"}
                            </p>
                            {entry.note && <p className="mt-1 max-w-md text-xs">{entry.note}</p>}
                          </div>
                          {shortlistEditable && (
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const next = window.prompt("Note (max 500 chars)", entry.note ?? "");
                                  if (next !== null) void updateNote(entry.id, next.slice(0, 500));
                                }}
                                disabled={busy}
                              >
                                Note
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => void removeFromShortlist(entry.id)} disabled={busy}>
                                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                                <span className="sr-only">Remove candidate</span>
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {/* add-to-shortlist note dialog */}
        {noteTarget && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Add candidate to shortlist">
            <Card className="w-full max-w-md">
              <CardContent className="space-y-4 p-6">
                <div>
                  <h3 className="font-display text-lg font-semibold">Add to shortlist</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    An optional private note (max 500 chars). Eligibility is re-checked when you confirm.
                  </p>
                </div>
                <Textarea
                  value={noteTarget.note}
                  onChange={(e) => setNoteTarget({ ...noteTarget, note: e.target.value.slice(0, 500) })}
                  aria-label="Shortlist note"
                  rows={3}
                  placeholder="Why this candidate?"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setNoteTarget(null)}>
                    Cancel
                  </Button>
                  <Button onClick={() => void addToShortlist(noteTarget.candidateUserId, noteTarget.note || undefined)} disabled={busy}>
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
