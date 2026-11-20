"use client";

/**
 * Opportunity Exchange (M-O7) — employer hiring-rooms console.
 *
 * Mounted inside the employer workspace section of the Opportunity Exchange
 * (after the invitations console). Covers the approved O7 decision set:
 *   - the room list with status + opportunity filters (RD-21 — no automatic
 *     lifecycle, filters instead), cards mirroring the invitations panel
 *     (frozen candidateDisplayName, stage + status badges, updatedAt);
 *   - explicit room creation from ACCEPTED invitations only (RD-3), with an
 *     optional IANA-validated display-only candidate timezone (RD-14);
 *   - the room detail dialog: frozen accepted terms (employer-only surface),
 *     forward-only stage controls (RD-9/RD-10), HIRED reachable only from
 *     OFFER, REJECTED with the closed reason vocabulary + employer-private
 *     note (RD-11), interview scheduling protocol (RD-12/RD-13) with the
 *     confirm/alternate/reschedule/cancel/complete lifecycle and meeting
 *     links shown only on PROPOSED/CONFIRMED rows (RD-15), room-scoped
 *     HIRING_MANAGER assignment (RD-4), pause/resume + cancel (RD-2), and
 *     the server-derived activity timeline (RD-16).
 *
 * The UI only MIRRORS server state (house rule): the machines, vocabularies
 * and every authorization answer are re-validated server-side on every
 * action; rule refusals (409 OX_ROOM_NOT_ACTIONABLE and friends) surface as
 * honest toasts. Employer-private notes are NEVER rendered anywhere on a
 * candidate surface — this panel is employer-only.
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BadgeCheck,
  CalendarPlus,
  DoorOpen,
  History,
  Inbox,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
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
  userId: string;
  organization: OrgDTO;
}

interface OpportunityLiteDTO {
  id: string;
  title: string;
  status: string;
}

interface OrgMemberDTO {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  status: string;
  user?: { id: string; name: string; username: string | null; avatarUrl: string | null };
}

interface AcceptedInvitationDTO {
  id: string;
  organizationId: string;
  opportunityId: string;
  candidateUserId: string | null;
  status: string;
  accepted: {
    salaryMinPaise: number | null;
    salaryMaxPaise: number | null;
    currency: string | null;
    period: string | null;
    acceptedAt: string;
  } | null;
}

interface RoomMemberDTO {
  id: string;
  userId: string | null;
  roomRole: string;
  removedAt: string | null;
  assignedAt: string;
}

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
  id: string;
  stage: string;
  fromStage: string | null;
  actorRole: string;
  actorUserId: string | null;
  reason: string | null;
  note: string | null;
  at: string;
}

interface ActivityEventDTO {
  at: string;
  kind: string;
  label: string;
  actorUserId?: string | null;
  actorRole?: string;
  detail?: string;
}

interface RoomClosureDTO {
  outcome: string | null;
  reason: string | null;
  at: string | null;
}

interface RoomDetailDTO {
  id: string;
  invitationId?: string;
  organizationId?: string;
  opportunityId?: string;
  /** Viewer-shape rows carry the opportunity title inline (RD-6 allowlist). */
  opportunity?: { id: string; title: string | null };
  candidateUserId?: string | null;
  candidateDisplayName: string;
  status: string;
  currentStage: string;
  candidateTimezone?: string | null;
  compensation?: {
    salaryMinPaise: number;
    salaryMaxPaise: number;
    currency: string;
    period: string;
  } | null;
  members?: RoomMemberDTO[];
  interviews?: InterviewDTO[];
  stageHistory?: StageEventDTO[];
  activity?: { events: ActivityEventDTO[] };
  pausedAt?: string | null;
  closure?: RoomClosureDTO;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

interface RoomListItemDTO {
  id: string;
  invitationId?: string;
  opportunityId?: string;
  opportunity?: { id: string; title: string | null };
  candidateDisplayName: string;
  status: string;
  currentStage: string;
  createdAt: string;
  updatedAt?: string;
}

// ------------------------------------------------------------- vocabularies

const ROOM_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  ON_HOLD: "On hold",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  CANDIDATE_WITHDRAWN: "Candidate withdrew",
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

/** Forward-movable stages (RD-9) — the terminal events are never buttons. */
const FORWARD_STAGES = ["INITIAL_REVIEW", "SCREENING", "INTERVIEW", "ASSESSMENT", "REFERENCE_CHECK", "OFFER"] as const;

const REJECT_REASONS = [
  "NOT_A_FIT",
  "SKILL_GAP",
  "EXPERIENCE_MISMATCH",
  "COMPENSATION_MISMATCH",
  "POSITION_FILLED",
  "POSITION_CLOSED",
  "OTHER",
] as const;

const ROOM_CANCEL_REASONS = ["REQUISITION_CANCELLED", "OPPORTUNITY_CLOSED", "DUPLICATE", "OTHER"] as const;

const INTERVIEW_TYPES = ["PHONE_SCREEN", "VIDEO", "ONSITE", "ASSESSMENT", "OTHER"] as const;

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

const DURATION_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240] as const;

const EMPLOYER_ADMIN_ROLES = new Set(["OWNER", "ADMIN", "RECRUITER"]);

const TERMINAL_ROOM_STATUSES = new Set(["CLOSED", "CANCELLED", "CANDIDATE_WITHDRAWN"]);

// ------------------------------------------------------------------ helpers

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** RD-14: candidate timezone is display-only — render in it when present. */
function formatRoomTime(iso: string, timezone: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined);
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function isIanaTimezone(tz: string): boolean {
  const candidate = tz.trim();
  if (!candidate) return false;
  try {
    const supported: readonly string[] | undefined = Intl.supportedValuesOf?.("timeZone");
    if (supported && supported.includes(candidate)) return true;
    // Registry-alias fallback, mirroring the server's own honesty check.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/** datetime-local → ISO UTC (the input is the employer's local wall time). */
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

export default function OxEmployerHiringRoomsPanel() {
  const [memberships, setMemberships] = useState<MeMembershipDTO[]>([]);
  const [orgId, setOrgId] = useState<string>("");
  const [opportunities, setOpportunities] = useState<OpportunityLiteDTO[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const [rooms, setRooms] = useState<RoomListItemDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // create-room dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [eligibleInvitations, setEligibleInvitations] = useState<AcceptedInvitationDTO[] | null>(null);
  const [pickInvitationId, setPickInvitationId] = useState<string>("");
  const [candidateTimezone, setCandidateTimezone] = useState<string>("");

  // detail state
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoomDetailDTO | null>(null);

  // stage / terminal controls
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState<string>("");
  const [rejectNote, setRejectNote] = useState<string>("");
  const [hireConfirm, setHireConfirm] = useState(false);

  // interview state
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeType, setProposeType] = useState<string>("VIDEO");
  const [proposeStart, setProposeStart] = useState<string>("");
  const [proposeDuration, setProposeDuration] = useState<string>("60");
  const [proposeEnd, setProposeEnd] = useState<string>("");
  const [proposeLink, setProposeLink] = useState<string>("");
  const [timeInterviewId, setTimeInterviewId] = useState<string | null>(null);
  const [timeInterviewMode, setTimeInterviewMode] = useState<"ALTERNATE" | "RESCHEDULE">("ALTERNATE");
  const [timeStart, setTimeStart] = useState<string>("");
  const [timeEnd, setTimeEnd] = useState<string>("");
  const [cancelInterviewId, setCancelInterviewId] = useState<string | null>(null);
  const [cancelInterviewReason, setCancelInterviewReason] = useState<string>("");

  // member state
  const [assignOpen, setAssignOpen] = useState(false);
  const [orgMembers, setOrgMembers] = useState<OrgMemberDTO[] | null>(null);
  const [assignUserId, setAssignUserId] = useState<string>("");
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null);

  // room cancel state
  const [cancelRoomOpen, setCancelRoomOpen] = useState(false);
  const [cancelRoomReason, setCancelRoomReason] = useState<string>("");

  const verifiedOrgs = useMemo(
    () => memberships.filter((m) => m.status === "ACTIVE" && m.organization.verificationStatus === "VERIFIED"),
    [memberships]
  );
  const myOrgMembership = useMemo(
    () => verifiedOrgs.find((m) => m.organization.id === orgId) ?? null,
    [verifiedOrgs, orgId]
  );
  const opportunityTitle = useCallback(
    (id: string) => opportunities.find((o) => o.id === id)?.title ?? null,
    [opportunities]
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

  const loadRooms = useCallback(async () => {
    if (!orgId) {
      setRooms(null);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ organizationId: orgId });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (opportunityId) params.set("opportunityId", opportunityId);
      const data = await api<{ rooms?: RoomListItemDTO[] }>(`/api/opportunities/hiring-rooms?${params.toString()}`);
      setRooms(data.rooms ?? []);
    } catch (e) {
      setRooms(null);
      if (e instanceof ApiError && e.status !== 401) toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  }, [orgId, statusFilter, opportunityId]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  const refreshAll = useCallback(async () => {
    await loadRooms();
    if (detailId) {
      try {
        // The detail route returns { room, activity } — the server-derived
        // RD-16 timeline rides as a sibling, merged here for rendering.
        const data = await api<{ room: RoomDetailDTO; activity?: { events: ActivityEventDTO[] } }>(
          `/api/opportunities/hiring-rooms/${detailId}`
        );
        setDetail({ ...data.room, activity: data.activity });
      } catch {
        setDetail(null);
      }
    }
  }, [loadRooms, detailId]);

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

  const openDetail = useCallback(async (roomId: string) => {
    setDetailId(roomId);
    setDetail(null);
    setHireConfirm(false);
    setRejectOpen(false);
    setRejectReason("");
    setRejectNote("");
    setProposeOpen(false);
    setTimeInterviewId(null);
    setCancelInterviewId(null);
    setAssignOpen(false);
    setRemoveMemberId(null);
    setCancelRoomOpen(false);
    try {
      // { room, activity } — the RD-16 timeline rides as a sibling.
      const data = await api<{ room: RoomDetailDTO; activity?: { events: ActivityEventDTO[] } }>(
        `/api/opportunities/hiring-rooms/${roomId}`
      );
      setDetail({ ...data.room, activity: data.activity });
    } catch (e) {
      setDetail(null);
      if (e instanceof ApiError) toast.error(errText(e));
    }
  }, []);

  // -------- create-room dialog (RD-3: explicit creation from ACCEPTED only)

  const openCreate = useCallback(async () => {
    setCreateOpen(true);
    setPickInvitationId("");
    setCandidateTimezone("");
    setEligibleInvitations(null);
    if (!orgId) return;
    try {
      // The O6 employer invitations list supports the status param; filter
      // client-side too so a list-shape change can never offer a non-ACCEPTED row.
      const params = new URLSearchParams({ organizationId: orgId, status: "ACCEPTED" });
      const data = await api<{ invitations: AcceptedInvitationDTO[] }>(`/api/opportunities/invitations?${params.toString()}`);
      const roomedIds = new Set((rooms ?? []).flatMap((r) => (r.invitationId ? [r.invitationId] : [])));
      setEligibleInvitations(
        data.invitations.filter((inv) => inv.status === "ACCEPTED" && inv.accepted && !roomedIds.has(inv.id))
      );
    } catch (e) {
      setEligibleInvitations([]);
      if (e instanceof ApiError) toast.error(errText(e));
    }
  }, [orgId, rooms]);

  const createRoom = useCallback(async () => {
    if (!pickInvitationId) return;
    const tz = candidateTimezone.trim();
    if (tz && !isIanaTimezone(tz)) {
      toast.error("Enter a valid IANA timezone (e.g. Asia/Kolkata) or leave the field empty.");
      return;
    }
    setBusy(true);
    try {
      // The route answers { room } (201) — only success/failure matters here.
      await api<{ room: { id: string } }>("/api/opportunities/hiring-rooms", {
        method: "POST",
        json: tz ? { invitationId: pickInvitationId, candidateTimezone: tz } : { invitationId: pickInvitationId },
      });
      toast.success("Hiring room created — the candidate has been notified.");
      setCreateOpen(false);
      await loadRooms();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }, [pickInvitationId, candidateTimezone, loadRooms]);

  // -------- derived detail helpers

  const roomActive = detail?.status === "ACTIVE";
  const roomWritable = roomActive || detail?.status === "ON_HOLD";
  const terminal = detail ? TERMINAL_ROOM_STATUSES.has(detail.status) : false;
  const isAssignedManager = Boolean(
    detail &&
      myOrgMembership &&
      (detail.members ?? []).some(
        (m) => m.userId === myOrgMembership.userId && m.roomRole === "HIRING_MANAGER" && m.removedAt === null
      )
  );
  // RD-5/RD-6: mirrors the server's party resolution — employer roles and the
  // ASSIGNED manager hold room powers; everyone else reads (the server 404s
  // or refuses regardless — the UI only hides what the caller cannot do).
  const canOperateRoom = isAssignedManager || (myOrgMembership ? EMPLOYER_ADMIN_ROLES.has(myOrgMembership.role) : true);
  const canAdminRoom = myOrgMembership ? EMPLOYER_ADMIN_ROLES.has(myOrgMembership.role) : true;

  const currentStageIndex = detail ? FORWARD_STAGES.indexOf(detail.currentStage as (typeof FORWARD_STAGES)[number]) : -1;
  const nextStages = detail ? FORWARD_STAGES.slice(currentStageIndex + 1) : [];
  const hireEnabled = detail?.currentStage === "OFFER" && roomActive && canOperateRoom;

  const activeMembers = (detail?.members ?? []).filter((m) => m.removedAt === null);
  const removedMembers = (detail?.members ?? []).filter((m) => m.removedAt !== null);
  const assignableOrgMembers = (orgMembers ?? []).filter((m) => m.status === "ACTIVE" && m.role !== "VIEWER");

  const openAssign = useCallback(async () => {
    setAssignOpen(true);
    setAssignUserId("");
    setOrgMembers(null);
    if (!orgId) return;
    try {
      const data = await api<{ members: OrgMemberDTO[] }>(`/api/employers/${orgId}/members`);
      setOrgMembers(data.members);
    } catch (e) {
      setOrgMembers([]);
      if (e instanceof ApiError) toast.error(errText(e));
    }
  }, [orgId]);

  // -------- interview time validation (RD-13 mirror; the server re-validates)

  function validateTimeWindow(startIso: string | null, endIso: string | null): string | null {
    if (!startIso || !endIso) return "Set both the start and the end time.";
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "Enter valid dates and times.";
    if (endMs <= startMs) return "The end time must be after the start time.";
    const minutes = (endMs - startMs) / 60_000;
    if (minutes < 15 || minutes > 240) return "The window must be between 15 minutes and 4 hours.";
    if (startMs <= Date.now()) return "The start time must be in the future.";
    return null;
  }

  function resolveTimeWindow(
    start: string,
    end: string,
    durationMinutes: string
  ): { ok: true; startsAt: string; endsAt: string } | { ok: false; error: string } {
    const startIso = localInputToIso(start);
    let endIso = localInputToIso(end);
    if (!endIso) {
      const minutes = Number(durationMinutes);
      if (!startIso || !Number.isInteger(minutes) || minutes < 15 || minutes > 240) {
        return { ok: false, error: "Pick a start time and a duration between 15 and 240 minutes." };
      }
      endIso = new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString();
    }
    const invalid = validateTimeWindow(startIso, endIso);
    if (invalid) return { ok: false, error: invalid };
    return { ok: true, startsAt: startIso as string, endsAt: endIso as string };
  }

  const proposeValid = resolveTimeWindow(proposeStart, proposeEnd, proposeDuration);
  const timeValid = resolveTimeWindow(timeStart, timeEnd, "60");

  // ---------------------------------------------------------------- render

  return (
    <Card className="border-border/60">
      <CardContent className="p-4 sm:p-6">
        <SectionHeader
          title="Hiring rooms"
          description="Run the hiring process for accepted invitations — stages, interviews, hiring managers and the full activity history in one room."
          as="h3"
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="ox-room-org">Organization</Label>
            <Select
              value={orgId}
              onValueChange={(v) => {
                setOrgId(v);
                setOpportunityId("");
              }}
            >
              <SelectTrigger id="ox-room-org" aria-label="Select organization">
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
            <Label htmlFor="ox-room-opportunity">Opportunity</Label>
            <Select value={opportunityId} onValueChange={setOpportunityId} disabled={!orgId}>
              <SelectTrigger id="ox-room-opportunity" aria-label="Filter by opportunity">
                <SelectValue placeholder={orgId ? "All opportunities" : "Pick an organization first"} />
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
          <div className="space-y-1.5">
            <Label htmlFor="ox-room-status">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="ox-room-status" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {["ACTIVE", "ON_HOLD", "CLOSED", "CANCELLED", "CANDIDATE_WITHDRAWN"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {ROOM_STATUS_LABEL[s] ?? s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {orgId
              ? "Rooms are created explicitly from accepted invitations — accepting never auto-creates one."
              : "Pick an organization to open its room console."}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void loadRooms()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
              <span className="sr-only">Refresh hiring rooms</span>
            </Button>
            <Button size="sm" onClick={() => void openCreate()} disabled={!orgId || !canAdminRoom}>
              <DoorOpen className="size-4" aria-hidden />
              New room
            </Button>
          </div>
        </div>

        {loading && rooms === null ? (
          <div className="mt-5 space-y-3" role="status" aria-label="Loading hiring rooms">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : !orgId ? null : rooms === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Hiring rooms could not be loaded.</p>
        ) : rooms.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={Inbox}
              title="No hiring rooms"
              description="Create a room from an accepted invitation to start structured hiring — stages, interviews and history stay in one place."
            />
          </div>
        ) : (
          <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Hiring rooms">
            {rooms.map((room) => (
              <li key={room.id}>
                <Card className="border-border/40">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{room.candidateDisplayName}</p>
                        <p className="text-xs text-muted-foreground">
                          {opportunityTitle(room.opportunityId ?? "") ??
                            room.opportunity?.title ??
                            `Opportunity ${shortId(room.opportunityId)}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated {new Date(room.updatedAt ?? room.createdAt).toLocaleString()}
                        </p>
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

        {/* -------- create-room dialog -------- */}
        <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">New hiring room</DialogTitle>
              <DialogDescription>
                Only ACCEPTED invitations can open a room — acceptance is the immutable join contract. One room per
                invitation, ever.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-invitation">Accepted invitation</Label>
                <Select value={pickInvitationId} onValueChange={setPickInvitationId}>
                  <SelectTrigger id="ox-room-invitation" aria-label="Select accepted invitation">
                    <SelectValue
                      placeholder={
                        eligibleInvitations === null
                          ? "Loading accepted invitations…"
                          : eligibleInvitations.length === 0
                            ? "No roomless accepted invitations"
                            : "Select an accepted invitation"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(eligibleInvitations ?? []).map((inv) => (
                      <SelectItem key={inv.id} value={inv.id}>
                        Candidate {shortId(inv.candidateUserId)} ·{" "}
                        {opportunityTitle(inv.opportunityId) ?? `Opportunity ${shortId(inv.opportunityId)}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {eligibleInvitations !== null && eligibleInvitations.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Every accepted invitation for this organization already has a room, or none has been accepted yet.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-tz">Candidate timezone (optional)</Label>
                <Input
                  id="ox-room-tz"
                  value={candidateTimezone}
                  onChange={(e) => setCandidateTimezone(e.target.value)}
                  placeholder="Asia/Kolkata"
                  aria-describedby="ox-room-tz-hint"
                />
                <p id="ox-room-tz-hint" className="text-xs text-muted-foreground">
                  IANA name, display-only — interview times are stored in UTC and rendered in this zone when given.
                </p>
              </div>
              {(() => {
                const picked = (eligibleInvitations ?? []).find((inv) => inv.id === pickInvitationId);
                if (!picked?.accepted) return null;
                return (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Accepted terms (frozen into the room)
                    </p>
                    <div className="mt-1.5">
                      <SalaryRange
                        minPaise={picked.accepted.salaryMinPaise}
                        maxPaise={picked.accepted.salaryMaxPaise}
                        currency={picked.accepted.currency}
                        period={picked.accepted.period}
                      />
                    </div>
                  </div>
                );
              })()}
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void createRoom()} disabled={!pickInvitationId || busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <DoorOpen className="size-4" aria-hidden />}
                  Create room
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* -------- detail dialog -------- */}
        <Dialog open={detailId !== null} onOpenChange={(open) => !open && setDetailId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="font-display">Hiring room{detail ? ` — ${detail.candidateDisplayName}` : ""}</DialogTitle>
              <DialogDescription>
                {detail
                  ? (opportunityTitle(detail.opportunityId ?? "") ?? detail.opportunity?.title ?? `Opportunity ${shortId(detail.opportunityId)}`) +
                    ` · opened ${new Date(detail.createdAt).toLocaleString()}`
                  : "Loading the room…"}
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
                    {detail.status === "ON_HOLD" && detail.pausedAt && (
                      <span className="text-xs text-muted-foreground">Paused {new Date(detail.pausedAt).toLocaleString()}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Candidate identity frozen at room creation{detail.candidateTimezone ? ` · tz ${detail.candidateTimezone}` : ""}
                  </p>
                </div>

                {terminal && detail.closure && (
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

                {detail.compensation && (
                  <div className="rounded-md border border-border/60 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Original accepted terms (immutable)
                    </p>
                    <div className="mt-1.5">
                      <SalaryRange
                        minPaise={detail.compensation.salaryMinPaise}
                        maxPaise={detail.compensation.salaryMaxPaise}
                        currency={detail.compensation.currency}
                        period={detail.compensation.period}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Frozen from the accepted invitation — never recomputed from the opportunity.
                    </p>
                  </div>
                )}

                {/* -------- stage controls -------- */}
                <div className="rounded-md border border-border/60 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stage — forward only, history is append-only
                  </p>
                  {terminal ? (
                    <p className="mt-2 text-sm text-muted-foreground">This room has concluded — no further stage changes.</p>
                  ) : detail.status === "ON_HOLD" ? (
                    <p className="mt-2 text-sm text-muted-foreground">On hold — resume the room to change stages.</p>
                  ) : !canOperateRoom ? (
                    <p className="mt-2 text-sm text-muted-foreground">Your org role is read-only for this room.</p>
                  ) : (
                    <>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {nextStages.map((stage) => (
                          <Button
                            key={stage}
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => api(`/api/opportunities/hiring-rooms/${detail.id}/stages`, { method: "POST", json: { stage } }),
                                `Stage moved to ${STAGE_LABEL[stage] ?? stage}.`
                              )
                            }
                          >
                            → {STAGE_LABEL[stage] ?? stage}
                          </Button>
                        ))}
                        {nextStages.length === 0 && detail.currentStage === "OFFER" && (
                          <p className="text-sm text-muted-foreground">Final stage — mark the outcome below.</p>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span tabIndex={hireEnabled ? -1 : 0}>
                              <Button
                                size="sm"
                                disabled={!hireEnabled || busy}
                                onClick={() => setHireConfirm(true)}
                                aria-label="Mark candidate as hired (only from the Offer stage)"
                              >
                                <BadgeCheck className="size-4" aria-hidden />
                                Mark HIRED
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {!hireEnabled && (
                            <TooltipContent>
                              {detail.currentStage !== "OFFER"
                                ? "HIRED is reachable only from the Offer stage."
                                : !roomActive
                                  ? "The room is not active."
                                  : "Read-only role."}
                            </TooltipContent>
                          )}
                        </Tooltip>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-destructive/40 text-destructive"
                          disabled={busy}
                          onClick={() => {
                            setRejectReason("");
                            setRejectNote("");
                            setRejectOpen(true);
                          }}
                        >
                          <XCircle className="size-4" aria-hidden />
                          Reject…
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                {hireConfirm && (
                  <div className="rounded-md border border-emerald-600/40 bg-emerald-600/5 p-3">
                    <p className="text-sm font-medium">Mark this candidate HIRED?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The room closes permanently as CLOSED with outcome HIRED and can never be reopened.
                    </p>
                    <DialogFooter className="mt-3 gap-2">
                      <Button variant="ghost" onClick={() => setHireConfirm(false)} disabled={busy}>
                        Back
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              api(`/api/opportunities/hiring-rooms/${detail.id}/stages`, {
                                method: "POST",
                                json: { stage: "HIRED" },
                              }),
                            "Candidate marked HIRED — the room is closed."
                          )
                        }
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <BadgeCheck className="size-4" aria-hidden />}
                        Confirm HIRED
                      </Button>
                    </DialogFooter>
                  </div>
                )}

                {/* -------- interviews -------- */}
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Interviews ({(detail.interviews ?? []).length})
                    </p>
                    {roomActive && canOperateRoom && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setProposeType("VIDEO");
                          setProposeStart("");
                          setProposeDuration("60");
                          setProposeEnd("");
                          setProposeOpen(true);
                        }}
                      >
                        <CalendarPlus className="size-4" aria-hidden />
                        Propose interview
                      </Button>
                    )}
                  </div>
                  {(detail.interviews ?? []).length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No interviews scheduled yet.</p>
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
                                  {iv.proposedByRole === "CANDIDATE" ? "Proposed by candidate" : "Proposed by employer"}
                                </Badge>
                                <Badge className={cn("border-transparent", INTERVIEW_STATUS_TONE[iv.status] ?? "bg-muted")}>
                                  {iv.status}
                                </Badge>
                              </span>
                            </div>
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              {formatRoomTime(iv.startsAt, detail.candidateTimezone)} →{" "}
                              {formatRoomTime(iv.endsAt, detail.candidateTimezone)}
                              {detail.candidateTimezone ? ` (${detail.candidateTimezone})` : " (your local time)"}
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
                            {roomActive && canOperateRoom && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {iv.status === "PROPOSED" && iv.proposedByRole === "CANDIDATE" && (
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
                                        "Interview confirmed."
                                      )
                                    }
                                  >
                                    Confirm
                                  </Button>
                                )}
                                {iv.status === "PROPOSED" && iv.proposedByRole === "CANDIDATE" && (
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
                                    Propose alternate time…
                                  </Button>
                                )}
                                {iv.status === "CONFIRMED" && (
                                  <>
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
                                      Reschedule…
                                    </Button>
                                    <Button
                                      size="sm"
                                      disabled={busy}
                                      onClick={() =>
                                        void act(
                                          () =>
                                            api(`/api/opportunities/hiring-rooms/${detail.id}/interviews/${iv.id}/complete`, {
                                              method: "POST",
                                              json: {},
                                            }),
                                          "Interview marked completed."
                                        )
                                      }
                                    >
                                      Complete
                                    </Button>
                                  </>
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

                {/* -------- members -------- */}
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Users className="size-3.5" aria-hidden />
                      Room members ({activeMembers.length})
                    </p>
                    {roomWritable && canAdminRoom && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void openAssign()}>
                        <UserPlus className="size-4" aria-hidden />
                        Assign HIRING_MANAGER…
                      </Button>
                    )}
                  </div>
                  {activeMembers.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No HIRING_MANAGER assigned to this room.</p>
                  ) : (
                    <ul className="mt-2 max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Room members">
                      {activeMembers.map((m) => (
                        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 p-3">
                          <span className="text-sm">
                            HIRING_MANAGER · <span className="font-mono text-xs text-muted-foreground">{shortId(m.userId)}</span>
                            <span className="ml-2 text-xs text-muted-foreground">assigned {new Date(m.assignedAt).toLocaleString()}</span>
                          </span>
                          {roomWritable && canAdminRoom && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-destructive/40 text-destructive"
                              disabled={busy}
                              onClick={() => setRemoveMemberId(m.id)}
                            >
                              Remove
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {removedMembers.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {removedMembers.length} previously assigned member{removedMembers.length === 1 ? "" : "s"} removed (kept in
                      history).
                    </p>
                  )}
                </div>

                {/* -------- room status controls -------- */}
                <div className="flex flex-wrap items-center gap-2">
                  {detail.status === "ACTIVE" && canOperateRoom && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api(`/api/opportunities/hiring-rooms/${detail.id}/pause`, { method: "POST", json: {} }),
                          "Room paused — writes are blocked while on hold."
                        )
                      }
                    >
                      <Pause className="size-4" aria-hidden />
                      Pause room
                    </Button>
                  )}
                  {detail.status === "ON_HOLD" && canOperateRoom && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api(`/api/opportunities/hiring-rooms/${detail.id}/resume`, { method: "POST", json: {} }),
                          "Room resumed."
                        )
                      }
                    >
                      <Play className="size-4" aria-hidden />
                      Resume room
                    </Button>
                  )}
                  {roomWritable && canAdminRoom && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/40 text-destructive"
                      disabled={busy}
                      onClick={() => {
                        setCancelRoomReason("");
                        setCancelRoomOpen(true);
                      }}
                    >
                      <XCircle className="size-4" aria-hidden />
                      Cancel room…
                    </Button>
                  )}
                  {terminal && (
                    <p className="text-xs text-muted-foreground">This room is in a terminal state — history stays read-only.</p>
                  )}
                </div>

                {/* -------- stage history (employer: codes + private notes) -------- */}
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stage history ({(detail.stageHistory ?? []).length})
                  </p>
                  {(detail.stageHistory ?? []).length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No stage events yet.</p>
                  ) : (
                    <ul className="mt-2 max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]" aria-label="Stage history">
                      {(detail.stageHistory ?? []).map((s) => (
                        <li key={s.id} className="rounded-md border border-border/50 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium">
                              {s.fromStage ? `${STAGE_LABEL[s.fromStage] ?? s.fromStage} → ` : ""}
                              {STAGE_LABEL[s.stage] ?? s.stage}
                            </span>
                            <span className="flex flex-wrap items-center gap-2">
                              {s.reason && <Badge variant="outline">{s.reason}</Badge>}
                              <Badge variant="outline" className="text-[11px]">
                                {s.actorRole === "CANDIDATE" ? "Candidate" : "Employer"}
                              </Badge>
                            </span>
                          </div>
                          {s.note && <p className="mt-1.5 text-xs text-muted-foreground">Note: {s.note}</p>}
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

        {/* -------- reject dialog (RD-11: 7-code vocabulary + private note) -------- */}
        <Dialog open={rejectOpen} onOpenChange={(open) => !open && setRejectOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">Reject candidate</DialogTitle>
              <DialogDescription>
                Rejecting closes the room permanently as CLOSED with outcome REJECTED. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-reject-reason">Reason</Label>
                <Select value={rejectReason} onValueChange={setRejectReason}>
                  <SelectTrigger id="ox-room-reject-reason" aria-label="Rejection reason">
                    <SelectValue placeholder="Select a reason" />
                  </SelectTrigger>
                  <SelectContent>
                    {REJECT_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ox-room-reject-note">Note (optional)</Label>
                  <span className={cn("text-xs", rejectNote.length > 500 ? "text-destructive" : "text-muted-foreground")}>
                    {rejectNote.length}/500
                  </span>
                </div>
                <Textarea
                  id="ox-room-reject-note"
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value.slice(0, 500))}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">Employer-private note — never shown to the candidate.</p>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy}>
                  Back
                </Button>
                <Button
                  variant="outline"
                  className="border-destructive/40 text-destructive"
                  disabled={!rejectReason || busy}
                  onClick={() =>
                    detail &&
                    void act(
                      () =>
                        api(`/api/opportunities/hiring-rooms/${detail.id}/stages`, {
                          method: "POST",
                          json: rejectNote.trim() ? { stage: "REJECTED", reason: rejectReason, note: rejectNote.trim() } : { stage: "REJECTED", reason: rejectReason },
                        }),
                      "Candidate rejected — the room is closed."
                    )
                  }
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
                  Confirm rejection
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* -------- propose-interview dialog (RD-12/RD-13) -------- */}
        <Dialog open={proposeOpen} onOpenChange={(open) => !open && setProposeOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">Propose interview</DialogTitle>
              <DialogDescription>
                Times are stored in UTC; the candidate confirms or proposes an alternate. Window: 15 minutes – 4 hours,
                strictly in the future.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-iv-type">Type</Label>
                <Select value={proposeType} onValueChange={setProposeType}>
                  <SelectTrigger id="ox-room-iv-type" aria-label="Interview type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVIEW_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {INTERVIEW_TYPE_LABEL[t] ?? t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ox-room-iv-start">Start (your local time)</Label>
                  <Input
                    id="ox-room-iv-start"
                    type="datetime-local"
                    value={proposeStart}
                    onChange={(e) => setProposeStart(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ox-room-iv-duration">Duration</Label>
                  <Select value={proposeDuration} onValueChange={setProposeDuration} disabled={proposeEnd !== ""}>
                    <SelectTrigger id="ox-room-iv-duration" aria-label="Interview duration">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATION_MINUTES.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m} minutes
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-iv-end">Explicit end (optional — overrides duration)</Label>
                <Input id="ox-room-iv-end" type="datetime-local" value={proposeEnd} onChange={(e) => setProposeEnd(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ox-room-iv-link">Meeting link (optional)</Label>
                <Input
                  id="ox-room-iv-link"
                  type="url"
                  value={proposeLink}
                  onChange={(e) => setProposeLink(e.target.value.trim())}
                  placeholder="https://meet.example.com/room"
                />
                <p className="text-xs text-muted-foreground">
                  HTTPS only — shown to the candidate while the interview is live (PROPOSED/CONFIRMED) and never on
                  cancelled or completed rows.
                </p>
              </div>
              {!proposeValid.ok && <p className="text-xs text-destructive">{proposeValid.error}</p>}
              <DialogFooter className="gap-2">
                <Button variant="ghost" onClick={() => setProposeOpen(false)} disabled={busy}>
                  Back
                </Button>
                <Button
                  disabled={
                    busy ||
                    !proposeValid.ok ||
                    (proposeLink !== "" && !/^https:\/\//i.test(proposeLink))
                  }
                  onClick={() => {
                    if (!detail || !proposeValid.ok) return;
                    void act(
                      () =>
                        api(`/api/opportunities/hiring-rooms/${detail.id}/interviews`, {
                          method: "POST",
                          json: {
                            type: proposeType,
                            startsAt: proposeValid.startsAt,
                            endsAt: proposeValid.endsAt,
                            ...(proposeLink ? { meetingLink: proposeLink } : {}),
                          },
                        }),
                      "Interview proposed — the candidate holds the confirmation right."
                    );
                  }}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CalendarPlus className="size-4" aria-hidden />}
                  Propose
                </Button>
              </DialogFooter>
            </div>
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
                  ? "Your alternate flips the proposal — the candidate then holds the confirmation right."
                  : "Rescheduling returns the interview to PROPOSED; the other side re-confirms."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ox-room-time-start">Start (your local time)</Label>
                  <Input id="ox-room-time-start" type="datetime-local" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ox-room-time-end">End (your local time)</Label>
                  <Input id="ox-room-time-end" type="datetime-local" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
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
              <Label htmlFor="ox-room-iv-cancel-reason">Reason</Label>
              <Select value={cancelInterviewReason} onValueChange={setCancelInterviewReason}>
                <SelectTrigger id="ox-room-iv-cancel-reason" aria-label="Interview cancellation reason">
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

        {/* -------- assign member dialog (RD-4) -------- */}
        <Dialog open={assignOpen} onOpenChange={(open) => !open && setAssignOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Assign HIRING_MANAGER</DialogTitle>
              <DialogDescription>
                Room-scoped: the assigned manager may run stages, interviews and pause/resume — but cannot close the
                room or manage members. Active org members only; VIEWERs are not assignable.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="ox-room-assign-member">Org member</Label>
              <Select value={assignUserId} onValueChange={setAssignUserId}>
                <SelectTrigger id="ox-room-assign-member" aria-label="Select org member">
                  <SelectValue
                    placeholder={
                      orgMembers === null ? "Loading org members…" : assignableOrgMembers.length === 0 ? "No assignable members" : "Select a member"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {assignableOrgMembers.map((m) => (
                    <SelectItem key={m.id} value={m.userId}>
                      {m.user?.name ?? `Member ${shortId(m.userId)}`} · {m.role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setAssignOpen(false)} disabled={busy}>
                Back
              </Button>
              <Button
                disabled={!assignUserId || busy}
                onClick={() =>
                  detail &&
                  void act(
                    () => api(`/api/opportunities/hiring-rooms/${detail.id}/members`, { method: "POST", json: { userId: assignUserId } }),
                    "HIRING_MANAGER assigned."
                  )
                }
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
                Assign
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* -------- remove member confirm -------- */}
        <Dialog open={removeMemberId !== null} onOpenChange={(open) => !open && setRemoveMemberId(null)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Remove room member</DialogTitle>
              <DialogDescription>
                The membership row is soft-removed (kept in history) and the member loses room powers immediately.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setRemoveMemberId(null)} disabled={busy}>
                Back
              </Button>
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive"
                disabled={busy}
                onClick={() =>
                  detail &&
                  removeMemberId &&
                  void act(
                    () => api(`/api/opportunities/hiring-rooms/${detail.id}/members/${removeMemberId}`, { method: "DELETE" }),
                    "Member removed from the room."
                  )
                }
              >
                Confirm removal
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* -------- cancel-room dialog (RD-2: reason required) -------- */}
        <Dialog open={cancelRoomOpen} onOpenChange={(open) => !open && setCancelRoomOpen(false)}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display">Cancel hiring room</DialogTitle>
              <DialogDescription>
                Cancelling is the outcome-less closure path — the candidate decision is implied by nothing. The room can
                never be reopened.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="ox-room-cancel-reason">Reason</Label>
              <Select value={cancelRoomReason} onValueChange={setCancelRoomReason}>
                <SelectTrigger id="ox-room-cancel-reason" aria-label="Room cancellation reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_CANCEL_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setCancelRoomOpen(false)} disabled={busy}>
                Back
              </Button>
              <Button
                variant="outline"
                className="border-destructive/40 text-destructive"
                disabled={!cancelRoomReason || busy}
                onClick={() =>
                  detail &&
                  void act(
                    () =>
                      api(`/api/opportunities/hiring-rooms/${detail.id}/cancel`, {
                        method: "POST",
                        json: { reason: cancelRoomReason },
                      }),
                    "Room cancelled."
                  )
                }
              >
                Confirm cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <p className="mt-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">Forward-only stages (RD-10)</Badge>
          <Badge variant="outline">HIRED only from OFFER</Badge>
          <Badge variant="outline">Interview window 15 min – 4 h</Badge>
          <Badge variant="outline">Rooms never reopen</Badge>
        </p>
      </CardContent>
    </Card>
  );
}
