"use client";

/**
 * Opportunity Exchange (M-O7) — candidate hiring-rooms surface.
 *
 * Mounted inside the "For professionals" section of the Opportunity Exchange
 * (after the invitations inbox). This surface is the candidate's side of the
 * room: the room list, the stage history (reason CODES as badges — RD-11;
 * the employer-private note is structurally absent from the candidate DTO
 * and is never rendered here), the interview scheduling protocol
 * (confirm / propose-alternate / reschedule / cancel — RD-12), meeting links
 * shown ONLY on PROPOSED/CONFIRMED rows (RD-15), and withdrawal with the
 * closed reason vocabulary (RD-7/RD-11).
 *
 * Privacy invariants mirrored from RD-18/RD-19: the room's identity is its
 * own — NO compensation is ever rendered (the server never sends it on the
 * candidate surface) and no org data is fetched; the opportunity title is
 * resolved only from the candidate's OWN invitations list when available.
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
import { CalendarPlus, Check, History, Inbox, Loader2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ types

interface InterviewDTO {
  id: string;
  type: string;
  status: string;
  startsAt: string;
  endsAt: string;
  proposedByRole: string;
  cancelReason: string | null;
  completedAt: string | null;
  meetingLink: string | null;
}

interface StageEventDTO {
  stage: string;
  fromStage: string | null;
  actorRole: string;
  reason: string | null;
  at: string;
}

interface ActivityEventDTO {
  at: string;
  kind: string;
  label: string;
  actorRole?: string;
  detail?: string;
}

interface RoomClosureDTO {
  outcome: string | null;
  reason: string | null;
  at: string | null;
}

interface CandidateRoomDTO {
  id: string;
  opportunityId: string;
  status: string;
  currentStage: string;
  candidateDisplayName: string;
  interviews?: InterviewDTO[];
  stageHistory?: StageEventDTO[];
  closure: RoomClosureDTO;
  createdAt: string;
  activity?: { events: ActivityEventDTO[] };
}

interface OwnInvitationDTO {
  id: string;
  opportunity: { id: string; title: string; status: string };
}

// ------------------------------------------------------------- vocabularies

const ROOM_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  ON_HOLD: "On hold",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  CANDIDATE_WITHDRAWN: "You withdrew",
};

const ROOM_STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-emerald-600 text-white",
  ON_HOLD: "bg-gold-soft text-primary",
  CLOSED: "bg-muted text-muted-foreground",
  CANCELLED: "bg-destructive/10 text-destructive",
  CANDIDATE_WITHDRAWN: "bg-muted text-muted-foreground",
};

const STAGE_LABEL: Record<string, string> = {
  INVITATION_ACCEPTED: "Invitation accepted",
  INITIAL_REVIEW: "Initial review",
  SCREENING: "Screening",
  INTERVIEW: "Interview",
  ASSESSMENT: "Assessment",
  REFERENCE_CHECK: "Reference check",
  OFFER: "Offer",
  HIRED: "Hired",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

const STAGE_TONE: Record<string, string> = {
  INVITATION_ACCEPTED: "bg-gold-soft text-primary",
  INITIAL_REVIEW: "bg-secondary text-secondary-foreground",
  SCREENING: "bg-secondary text-secondary-foreground",
  INTERVIEW: "bg-secondary text-secondary-foreground",
  ASSESSMENT: "bg-secondary text-secondary-foreground",
  REFERENCE_CHECK: "bg-secondary text-secondary-foreground",
  OFFER: "bg-gold-soft text-primary",
  HIRED: "bg-emerald-600 text-white",
  REJECTED: "bg-destructive/10 text-destructive",
  WITHDRAWN: "bg-muted text-muted-foreground",
};

const INTERVIEW_TYPE_LABEL: Record<string, string> = {
  PHONE_SCREEN: "Phone screen",
  VIDEO: "Video",
  ONSITE: "On-site",
  ASSESSMENT: "Assessment",
  OTHER: "Other",
};

const INTERVIEW_STATUS_TONE: Record<string, string> = {
  PROPOSED: "bg-gold-soft text-primary",
  CONFIRMED: "bg-emerald-600 text-white",
  CANCELLED: "bg-destructive/10 text-destructive",
  COMPLETED: "bg-muted text-muted-foreground",
};

const INTERVIEW_CANCEL_REASONS = ["SCHEDULING_CONFLICT", "UNAVAILABLE", "NO_LONGER_REQUIRED", "OTHER"] as const;

const WITHDRAW_REASONS = [
  "ACCEPTED_OTHER_OFFER",
  "DECLINED_FURTHER_PROCESS",
  "PERSONAL",
  "COMPENSATION",
  "TIMING",
  "OTHER",
] as const;

const TERMINAL_ROOM_STATUSES = new Set(["CLOSED", "CANCELLED", "CANDIDATE_WITHDRAWN"]);

// ------------------------------------------------------------------ helpers

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** RD-14: the room's candidate timezone is display-only when the server sends one. */
function formatRoomTime(iso: string, timezone: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined);
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** datetime-local → ISO UTC (the input is the candidate's local wall time). */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 10)}…` : "—";
}

function linkLabel(link: string | null | undefined): string {
  if (!link) return "Meeting link";
  try {
    return new URL(link).hostname;
  } catch {
    return "Meeting link";
  }
}

// ------------------------------------------------------------------ component

export default function OxCandidateHiringRoomsPanel() {
  const [rooms, setRooms] = useState<CandidateRoomDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CandidateRoomDTO | null>(null);

  // interview state
  const [timeInterviewId, setTimeInterviewId] = useState<string | null>(null);
  const [timeInterviewMode, setTimeInterviewMode] = useState<"ALTERNATE" | "RESCHEDULE">("ALTERNATE");
  const [timeStart, setTimeStart] = useState<string>("");
  const [timeEnd, setTimeEnd] = useState<string>("");
  const [cancelInterviewId, setCancelInterviewId] = useState<string | null>(null);
  const [cancelInterviewReason, setCancelInterviewReason] = useState<string>("");

  // withdraw state
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState<string>("");
  const [withdrawConfirmText, setWithdrawConfirmText] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api<{ rooms?: CandidateRoomDTO[] }>("/api/opportunities/me/hiring-rooms");
      // The route returns a { rooms: [...] } envelope.
      setRooms(data.rooms ?? []);
    } catch (e) {
      setRooms(null);
      if (e instanceof ApiError && e.status !== 401) toast.error(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Opportunity titles come ONLY from the candidate's own invitations list —
  // no org data is fetched (RD-18/RD-19: the room's identity is its own).
  const [ownInvitations, setOwnInvitations] = useState<OwnInvitationDTO[]>([]);
  useEffect(() => {
    api<{ invitations: OwnInvitationDTO[] }>("/api/opportunities/me/invitations")
      .then((d) => setOwnInvitations(d.invitations))
      .catch(() => setOwnInvitations([]));
  }, []);

  const opportunityTitle = useMemo(() => {
    const map = new Map<string, string>();
    for (const inv of ownInvitations) {
      if (!map.has(inv.opportunity.id)) map.set(inv.opportunity.id, inv.opportunity.title);
    }
    return map;
  }, [ownInvitations]);

  const titleFor = useCallback(
    (opportunityId: string) => opportunityTitle.get(opportunityId) ?? `Opportunity ${shortId(opportunityId)}`,
    [opportunityTitle]
  );

  const refreshAll = useCallback(async () => {
    await load();
    if (detailId) {
      try {
        // The detail route returns { room, activity } — the server-derived
        // RD-16 timeline rides as a sibling, merged here for rendering.
        const data = await api<{ room: CandidateRoomDTO; activity?: { events: ActivityEventDTO[] } }>(
          `/api/opportunities/me/hiring-rooms/${detailId}`
        );
        setDetail({ ...data.room, activity: data.activity });
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
        toast.error(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [refreshAll]
  );

  const openDetail = useCallback(
    async (roomId: string) => {
      setDetailId(roomId);
      setDetail(null);
      setTimeInterviewId(null);
      setCancelInterviewId(null);
      setWithdrawOpen(false);
      setWithdrawReason("");
      setWithdrawConfirmText(false);
      try {
        // { room, activity } — the RD-16 timeline rides as a sibling.
        const data = await api<{ room: CandidateRoomDTO; activity?: { events: ActivityEventDTO[] } }>(
          `/api/opportunities/me/hiring-rooms/${roomId}`
        );
        setDetail({ ...data.room, activity: data.activity });
      } catch (e) {
        setDetail(null);
        if (e instanceof ApiError) toast.error(errText(e));
      }
    },
    []
  );

  // -------- interview time validation (RD-13 mirror; the server re-validates)

  const timeValid = useMemo(() => {
    const startIso = localInputToIso(timeStart);
    const endIso = localInputToIso(timeEnd);
    if (!startIso || !endIso) return { ok: false as const, error: "Set both the start and the end time." };
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return { ok: false as const, error: "Enter valid dates and times." };
    if (endMs <= startMs) return { ok: false as const, error: "The end time must be after the start time." };
    const minutes = (endMs - startMs) / 60_000;
    if (minutes < 15 || minutes > 240) return { ok: false as const, error: "The window must be between 15 minutes and 4 hours." };
    if (startMs <= Date.now()) return { ok: false as const, error: "The start time must be in the future." };
    return { ok: true as const, startsAt: startIso, endsAt: endIso };
  }, [timeStart, timeEnd]);

  const roomWritable = detail?.status === "ACTIVE";
  const withdrawable = detail ? detail.status === "ACTIVE" || detail.status === "ON_HOLD" : false;
  const terminal = detail ? TERMINAL_ROOM_STATUSES.has(detail.status) : false;

  // ---------------------------------------------------------------- render

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6">
        <SectionHeader
          title="Hiring rooms"
          description="Rooms opened for your accepted invitations — follow every stage, confirm interviews, and withdraw when you choose."
          as="h3"
        />

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {rooms !== null ? `${rooms.length} room${rooms.length === 1 ? "" : "s"}` : ""}
          </p>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={refreshing}>
            {refreshing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
            <span className="sr-only">Refresh hiring rooms</span>
          </Button>
        </div>

        {loading && rooms === null ? (
          <div className="mt-4 space-y-3" role="status" aria-label="Loading hiring rooms">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : rooms === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Hiring rooms could not be loaded.</p>
        ) : rooms.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={Inbox}
              title="No hiring rooms yet"
              description="When an employer opens a hiring room for one of your accepted invitations, it appears here with the full stage history."
            />
          </div>
        ) : (
          <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Your hiring rooms">
            {rooms.map((room) => (
              <li key={room.id}>
                <Card className="border-border/40">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{titleFor(room.opportunityId)}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Opened {new Date(room.createdAt).toLocaleString()}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[11px]">
                          {STAGE_LABEL[room.currentStage] ?? room.currentStage}
                        </Badge>
                        <Badge className={cn("border-transparent", ROOM_STATUS_TONE[room.status] ?? "bg-muted")}>
                          {ROOM_STATUS_LABEL[room.status] ?? room.status}
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => void openDetail(room.id)}>
                          <History className="size-4" aria-hidden />
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
              <DialogTitle className="font-display">Hiring room{detail ? ` — ${titleFor(detail.opportunityId)}` : ""}</DialogTitle>
              <DialogDescription>
                {detail ? `Opened ${new Date(detail.createdAt).toLocaleString()}` : "Loading the room…"}
              </DialogDescription>
            </DialogHeader>
            {!detail ? (
              <div className="space-y-3" role="status" aria-label="Loading hiring room">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      {STAGE_LABEL[detail.currentStage] ?? detail.currentStage}
                    </Badge>
                    <Badge className={cn("border-transparent", ROOM_STATUS_TONE[detail.status] ?? "bg-muted")}>
                      {ROOM_STATUS_LABEL[detail.status] ?? detail.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Opened {new Date(detail.createdAt).toLocaleString()}</p>
                </div>

                {terminal && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Closure (final — rooms never reopen)</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                      {detail.closure.outcome && (
                        <Badge className={cn("border-transparent", STAGE_TONE[detail.closure.outcome] ?? "bg-muted")}>
                          {STAGE_LABEL[detail.closure.outcome] ?? detail.closure.outcome}
                        </Badge>
                      )}
                      {detail.closure.reason && <Badge variant="outline">{detail.closure.reason}</Badge>}
                      {detail.closure.at && <span className="text-xs text-muted-foreground">{new Date(detail.closure.at).toLocaleString()}</span>}
                    </div>
                  </div>
                )}

                {/* -------- interviews -------- */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Interviews ({(detail.interviews ?? []).length})
                  </p>
                  {detail.status === "ON_HOLD" && (
                    <p className="mt-2 text-sm text-muted-foreground">The room is on hold — interview actions are paused.</p>
                  )}
                  {(detail.interviews ?? []).length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No interviews yet — proposed times appear here.</p>
                  ) : (
                    <ul className="mt-2 max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Room interviews">
                      {(detail.interviews ?? []).map((iv) => {
                        const showLink = (iv.status === "PROPOSED" || iv.status === "CONFIRMED") && iv.meetingLink;
                        return (
                          <li key={iv.id} className="rounded-md border border-border/50 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium">{INTERVIEW_TYPE_LABEL[iv.type] ?? iv.type}</span>
                              <span className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline" className="text-[11px]">
                                  {iv.proposedByRole === "CANDIDATE" ? "Proposed by you" : "Proposed by employer"}
                                </Badge>
                                <Badge className={cn("border-transparent", INTERVIEW_STATUS_TONE[iv.status] ?? "bg-muted")}>
                                  {iv.status}
                                </Badge>
                              </span>
                            </div>
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              {formatRoomTime(iv.startsAt, undefined)} → {formatRoomTime(iv.endsAt, undefined)} (your local time)
                            </p>
                            {iv.status === "CANCELLED" && iv.cancelReason && (
                              <p className="mt-1 text-xs text-destructive">Cancelled · {iv.cancelReason}</p>
                            )}
                            {iv.status === "COMPLETED" && iv.completedAt && (
                              <p className="mt-1 text-xs text-muted-foreground">Completed {new Date(iv.completedAt).toLocaleString()}</p>
                            )}
                            {showLink && (
                              <p className="mt-1 text-xs">
                                <a
                                  href={iv.meetingLink as string}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className="text-primary underline underline-offset-2"
                                >
                                  {linkLabel(iv.meetingLink)} — join link
                                </a>
                              </p>
                            )}
                            {roomWritable && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {iv.status === "PROPOSED" && iv.proposedByRole === "EMPLOYER" && (
                                  <Button
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void act(
                                        () =>
                                          api(`/api/opportunities/hiring-rooms/${detail.id}/interviews/${iv.id}/confirm`, {
                                            method: "POST",
                                            json: {},
                                          }),
                                        "Interview confirmed — see you there."
                                      )
                                    }
                                  >
                                    <Check className="size-4" aria-hidden />
                                    Confirm
                                  </Button>
                                )}
                                {iv.status === "PROPOSED" && iv.proposedByRole === "EMPLOYER" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => {
                                      setTimeInterviewMode("ALTERNATE");
                                      setTimeInterviewId(iv.id);
                                      setTimeStart("");
                                      setTimeEnd("");
                                    }}
                                  >
                                    <CalendarPlus className="size-4" aria-hidden />
                                    Propose alternate time…
                                  </Button>
                                )}
                                {iv.status === "CONFIRMED" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => {
                                      setTimeInterviewMode("RESCHEDULE");
                                      setTimeInterviewId(iv.id);
                                      setTimeStart("");
                                      setTimeEnd("");
                                    }}
                                  >
                                    <CalendarPlus className="size-4" aria-hidden />
                                    Reschedule…
                                  </Button>
                                )}
                                {(iv.status === "PROPOSED" || iv.status === "CONFIRMED") && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-destructive/40 text-destructive"
                                    disabled={busy}
                                    onClick={() => {
                                      setCancelInterviewId(iv.id);
                                      setCancelInterviewReason("");
                                    }}
                                  >
                                    <XCircle className="size-4" aria-hidden />
                                    Cancel…
                                  </Button>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* -------- withdraw (RD-7) -------- */}
                {withdrawable && (
                  <div className="rounded-md border border-destructive/40 p-3">
                    <p className="text-xs font-medium text-destructive">Withdraw from this room</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Withdrawal closes the room permanently, cancels all live interviews and keeps a read-only history
                      for both sides. It can never be undone and you can never re-enter this room.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 border-destructive/40 text-destructive"
                      disabled={busy}
                      onClick={() => {
                        setWithdrawReason("");
                        setWithdrawConfirmText(false);
                        setWithdrawOpen(true);
                      }}
                    >
                      <XCircle className="size-4" aria-hidden />
                      Withdraw…
                    </Button>
                  </div>
                )}
                {terminal && (
                  <p className="text-xs text-muted-foreground">This room is in a terminal state — history stays read-only.</p>
                )}

                {/* -------- stage history (codes only — no employer note exists here) -------- */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stage history ({(detail.stageHistory ?? []).length})
                  </p>
                  {(detail.stageHistory ?? []).length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No stage events yet.</p>
                  ) : (
                    <ul className="mt-2 max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Stage history">
                      {(detail.stageHistory ?? []).map((s, i) => (
                        <li key={`${s.at}-${i}`} className="rounded-md border border-border/50 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium">
                              {s.fromStage ? `${STAGE_LABEL[s.fromStage] ?? s.fromStage} → ` : ""}
                              {STAGE_LABEL[s.stage] ?? s.stage}
                            </span>
                            <span className="flex flex-wrap items-center gap-2">
                              {s.reason && <Badge variant="outline">{s.reason}</Badge>}
                              <Badge variant="outline" className="text-[11px]">
                                {s.actorRole === "CANDIDATE" ? "You" : "Employer"}
                              </Badge>
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{new Date(s.at).toLocaleString()}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* -------- activity timeline (RD-16) -------- */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Activity</p>
                  {detail.activity && detail.activity.events.length > 0 ? (
                    <ol className="mt-2 max-h-96 space-y-2 overflow-y-auto border-l border-border/60 pl-3 pr-1 [scrollbar-width:thin]" aria-label="Room activity">
                      {detail.activity.events.map((ev, i) => (
                        <li key={`${ev.at}-${i}`} className="relative">
                          <span className="absolute -left-[17px] top-1.5 size-2 rounded-full bg-primary" aria-hidden />
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[11px]">
                              {ev.kind}
                            </Badge>
                            <span className="text-sm">{ev.label}</span>
                            {ev.actorRole && <span className="text-xs text-muted-foreground">by {ev.actorRole}</span>}
                          </div>
                          {ev.detail && <p className="text-xs text-muted-foreground">{ev.detail}</p>}
                          <p className="text-xs text-muted-foreground">{new Date(ev.at).toLocaleString()}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">No activity recorded yet.</p>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* -------- alternate / reschedule time dialog -------- */}
        <Dialog open={timeInterviewId !== null} onOpenChange={(open) => !open && setTimeInterviewId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">
                {timeInterviewMode === "ALTERNATE" ? "Propose alternate time" : "Reschedule interview"}
              </DialogTitle>
              <DialogDescription>
                {timeInterviewMode === "ALTERNATE"
                  ? "Your alternate flips the proposal — the employer then holds the confirmation right."
                  : "Rescheduling returns the interview to PROPOSED; the employer re-confirms."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ox-my-room-time-start">Start (your local time)</Label>
                  <Input id="ox-my-room-time-start" type="datetime-local" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ox-my-room-time-end">End (your local time)</Label>
                  <Input id="ox-my-room-time-end" type="datetime-local" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
                </div>
              </div>
              {!timeValid.ok && <p className="text-xs text-destructive">{timeValid.error}</p>}
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setTimeInterviewId(null)} disabled={busy}>
                  Back
                </Button>
                <Button
                  disabled={busy || !timeValid.ok}
                  onClick={() => {
                    if (!timeInterviewId || !timeValid.ok) return;
                    const interviewId = timeInterviewId;
                    const roomId = detailId;
                    if (!roomId) return;
                    void act(
                      () =>
                        api(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/${timeInterviewMode === "ALTERNATE" ? "alternate" : "reschedule"}`, {
                          method: "POST",
                          json: { startsAt: timeValid.startsAt, endsAt: timeValid.endsAt },
                        }),
                      timeInterviewMode === "ALTERNATE" ? "Alternate time proposed." : "Interview rescheduled — awaiting confirmation."
                    );
                  }}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CalendarPlus className="size-4" aria-hidden />}
                  {timeInterviewMode === "ALTERNATE" ? "Propose alternate" : "Reschedule"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* -------- cancel-interview dialog -------- */}
        <Dialog open={cancelInterviewId !== null} onOpenChange={(open) => !open && setCancelInterviewId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Cancel interview</DialogTitle>
              <DialogDescription>The cancelled row stays in the history with its reason code.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="ox-my-room-iv-cancel-reason">Reason</Label>
              <Select value={cancelInterviewReason} onValueChange={setCancelInterviewReason}>
                <SelectTrigger id="ox-my-room-iv-cancel-reason" aria-label="Interview cancellation reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {INTERVIEW_CANCEL_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setCancelInterviewId(null)} disabled={busy}>
                Back
              </Button>
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive"
                disabled={!cancelInterviewReason || busy}
                onClick={() => {
                  if (!cancelInterviewId || !detailId) return;
                  const interviewId = cancelInterviewId;
                  const roomId = detailId;
                  void act(
                    () =>
                      api(`/api/opportunities/hiring-rooms/${roomId}/interviews/${interviewId}/cancel`, {
                        method: "POST",
                        json: { reason: cancelInterviewReason },
                      }),
                    "Interview cancelled."
                  );
                }}
              >
                Confirm cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* -------- withdraw dialog (RD-7/RD-11) -------- */}
        <Dialog open={withdrawOpen} onOpenChange={(open) => !open && setWithdrawOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Withdraw from the hiring room</DialogTitle>
              <DialogDescription>
                Withdrawal is permanent: the room closes as CANDIDATE_WITHDRAWN, all live interviews are cancelled, and
                the room can never be reopened.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ox-my-room-withdraw-reason">Reason</Label>
                <Select value={withdrawReason} onValueChange={setWithdrawReason}>
                  <SelectTrigger id="ox-my-room-withdraw-reason" aria-label="Withdrawal reason">
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {WITHDRAW_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={withdrawConfirmText}
                  onChange={(e) => setWithdrawConfirmText(e.target.checked)}
                  className="mt-0.5"
                  aria-label="I understand this closes the room permanently and cannot be undone"
                />
                <span>I understand the room closes permanently and cannot be reopened.</span>
              </label>
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setWithdrawOpen(false)} disabled={busy}>
                  Back
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/40 text-destructive"
                  disabled={!withdrawReason || !withdrawConfirmText || busy}
                  onClick={() =>
                    detail &&
                    void act(
                      () =>
                        api(`/api/opportunities/me/hiring-rooms/${detail.id}/withdraw`, {
                          method: "POST",
                          json: { reason: withdrawReason },
                        }),
                      "You withdrew from the room — the employer has been notified."
                    )
                  }
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
                  Confirm withdrawal
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
