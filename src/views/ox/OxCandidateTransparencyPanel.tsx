"use client";

/**
 * Opportunity Exchange (M-O5) — candidate transparency workspace
 * (approved decision D12): "How employers see your profile."
 *
 * One surface for:
 *   - the candidate's OWN stored matches, each with the verified employer's
 *     PUBLIC identity and the audience-safe factor explanation;
 *   - the discovery-access audit trail — WHO viewed the discoverable
 *     information, when, for which opportunity (org + recruiter identity
 *     per O0 §6.7);
 *   - a truthful discovery-state banner (ACTIVE / PAUSED / HIDDEN /
 *     INVITE_ONLY / REVOKED / EXPIRED / NO_DISCOVERY) re-read from the
 *     server on every load — the UI never guesses the state.
 *
 * The UI only MIRRORS server state (house rule): consent and visibility
 * controls live in the existing candidate profile workspace (O2) and are
 * not duplicated here.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Eye, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";

interface ExplanationFactor {
  key: string;
  label: string;
  weight: number;
  earned?: number;
  max?: number;
  applied?: boolean;
  reason?: string;
}

interface OwnMatchDTO {
  opportunityId: string;
  opportunity: { id: string; title: string; status: string };
  organization: { id: string; displayName: string; slug: string };
  matchVersion: string;
  score: number;
  generatedAt: string;
  discoveryState: string;
  explanation?: Record<string, unknown> | null;
}

interface AuditEventDTO {
  at: string;
  action: string;
  organizationId: string | null;
  opportunityId: string | null;
  purpose: string;
  viewerUserId: string | null;
}

const STATE_BANNER: Record<string, { label: string; tone: string }> = {
  DISCOVERY_ACTIVE: { label: "Discovery is ACTIVE — verified employers can find you through your consented matches.", tone: "bg-gold-soft text-primary" },
  DISCOVERY_PAUSED: { label: "Discovery is PAUSED — you are hidden from discovery; your data and records are preserved.", tone: "bg-muted text-foreground" },
  DISCOVERY_HIDDEN: { label: "Discovery is HIDDEN — your profile is not discoverable.", tone: "bg-muted text-foreground" },
  DISCOVERY_INVITE_ONLY: { label: "Discovery is INVITE-ONLY — in this release invite-only profiles stay hidden from discovery.", tone: "bg-muted text-foreground" },
  DISCOVERY_REVOKED: { label: "Your DISCOVERY consent is REVOKED — you are hidden everywhere; historical records are masked for employers.", tone: "bg-muted text-foreground" },
  DISCOVERY_EXPIRED: { label: "Your DISCOVERY consent has EXPIRED — you are not discoverable until you grant it again.", tone: "bg-muted text-foreground" },
  NO_DISCOVERY: { label: "No discovery consent on record — you are not discoverable.", tone: "bg-muted text-foreground" },
};

const REASON_LABEL: Record<string, string> = {
  NO_REQUIRED_SKILLS_DECLARED: "This opportunity declares no required skills",
  NO_PREFERRED_SKILLS_DECLARED: "This opportunity declares no preferred skills",
  OPPORTUNITY_PROFESSION_UNSET: "The opportunity has no profession set",
  CANDIDATE_PROFESSION_PREFERENCES_UNSET: "You have not declared profession preferences",
  OPPORTUNITY_WORK_MODE_UNSET: "The opportunity has no work mode set",
  CANDIDATE_WORK_MODES_UNSET: "You have not declared work modes",
  OPPORTUNITY_LOCATION_UNSET: "The opportunity has no location set",
  CANDIDATE_LOCATIONS_UNSET: "You have not declared location preferences",
  CANDIDATE_AVAILABILITY_UNSET: "You have not declared your availability",
  COMPENSATION_NOT_DISCLOSED_TO_THIS_REQUESTER: "Compensation not compared — you keep it private",
  NOT_EVALUABLE_NO_OPPORTUNITY_INPUT: "Experience not compared — no opportunity input exists",
};

export default function OxCandidateTransparencyPanel() {
  const [matches, setMatches] = useState<OwnMatchDTO[] | null>(null);
  const [discoveryState, setDiscoveryState] = useState<string>("NO_DISCOVERY");
  const [audit, setAudit] = useState<AuditEventDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const m = await api<{ discoveryState: string; matches: OwnMatchDTO[] }>("/api/opportunities/me/matches");
      setMatches(m.matches);
      setDiscoveryState(m.discoveryState);
      const a = await api<{ events: AuditEventDTO[] }>("/api/opportunities/me/discovery-audit");
      setAudit(a.events);
    } catch (e) {
      if (e instanceof ApiError) toast.error(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const banner = STATE_BANNER[discoveryState] ?? STATE_BANNER.NO_DISCOVERY;

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6">
        <SectionHeader
          title="How employers see your profile"
          description="Your matches, who viewed your discoverable profile, and the real state of your discoverability — all in one place."
          as="h3"
        />

        <div className={banner.tone} role="status" aria-live="polite">
          <p className="mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-sm font-medium">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            {banner.label}
          </p>
        </div>

        {loading ? (
          <div className="mt-5 space-y-3" role="status" aria-label="Loading transparency data">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="mt-6 grid gap-8 lg:grid-cols-2">
            {/* -------- own matches -------- */}
            <section aria-labelledby="ox-own-matches-heading">
              <div className="flex items-center justify-between">
                <h4 id="ox-own-matches-heading" className="font-display text-base font-semibold">
                  Your matches
                </h4>
                <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing}>
                  {refreshing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                  <span className="sr-only">Refresh</span>
                </Button>
              </div>
              {matches === null ? (
                <p className="mt-3 text-sm text-muted-foreground">Matches could not be loaded.</p>
              ) : matches.length === 0 ? (
                <div className="mt-3">
                  <EmptyState
                    icon={ShieldCheck}
                    title="No stored matches yet"
                    description="When a verified employer discovers your consented profile for a published opportunity, the match appears here with its explanation."
                  />
                </div>
              ) : (
                <ul className="mt-3 space-y-3">
                  {matches.map((m) => (
                    <li key={m.opportunityId}>
                      <Card className="border-border/40">
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{m.organization.displayName}</p>
                              <p className="text-xs text-muted-foreground">
                                {m.opportunity.title} · {m.opportunity.status}
                              </p>
                            </div>
                            <div
                              className="grid size-11 shrink-0 place-items-center rounded-full border border-border/60 font-display text-sm font-semibold text-primary"
                              aria-label={`Your match score ${m.score} out of 100`}
                            >
                              {m.score}
                            </div>
                          </div>
                          {m.explanation && Array.isArray((m.explanation as { factors?: ExplanationFactor[] }).factors) && (
                            <details className="mt-3">
                              <summary className="cursor-pointer text-xs font-medium text-primary">Why this score</summary>
                              <ul className="mt-2 space-y-1">
                                {((m.explanation as { factors: ExplanationFactor[] }).factors ?? []).map((f) => (
                                  <li key={f.key} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                    <span>{f.label}</span>
                                    {f.applied ? (
                                      <span className="text-muted-foreground">
                                        {f.earned}/{f.max}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground italic">{REASON_LABEL[f.reason ?? ""] ?? f.reason}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          <p className="mt-2 text-xs text-muted-foreground">computed {new Date(m.generatedAt).toLocaleString()}</p>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* -------- discovery activity -------- */}
            <section aria-labelledby="ox-audit-heading">
              <h4 id="ox-audit-heading" className="font-display text-base font-semibold">
                Discovery activity — who viewed your profile
              </h4>
              {audit === null ? (
                <p className="mt-3 text-sm text-muted-foreground">Audit trail could not be loaded.</p>
              ) : audit.length === 0 ? (
                <div className="mt-3">
                  <EmptyState
                    icon={Eye}
                    title="No employer previews yet"
                    description="Every time an authorized employer views your discoverable details, the access is recorded here."
                  />
                </div>
              ) : (
                <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Discovery access history">
                  {audit.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      <Card className="border-border/40">
                        <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs">
                          <span>
                            <Eye className="mr-1 inline size-3.5" aria-hidden />
                            {e.purpose === "DISCOVERY" ? "Talent discovery preview" : e.purpose}
                            {e.opportunityId && <span className="text-muted-foreground"> · opportunity {e.opportunityId.slice(0, 8)}…</span>}
                          </span>
                          <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Employer identities are shown for organization-level records; the accessing member is recorded for accountability and retained with the audit trail.
              </p>
            </section>
          </div>
        )}

        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Consent-first</Badge>
          <Badge variant="outline">No contact details ever shown</Badge>
          <Badge variant="outline">Deterministic scores — never a hiring probability</Badge>
        </p>
      </CardContent>
    </Card>
  );
}
