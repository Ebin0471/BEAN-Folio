"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  AtSign,
  Bookmark,
  Check,
  Heart,
  Info,
  Mail,
  MailCheck,
  MailQuestion,
  MessageSquarePlus,
  ServerCrash,
  Share2,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { EmptyState } from "@/components/bean/EmptyState";
import { PersonCard } from "@/components/bean/PersonCard";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { InquiryDTO, NotificationGroupDTO, PublicPerson } from "@/lib/types";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ plumbing

type SectionState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  ensure: () => void;
  reload: () => Promise<void>;
};

function useSection<T>(path: string): SectionState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ensuredRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<T>(path);
      setData(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [path]);

  const ensure = useCallback(() => {
    if (!ensuredRef.current) {
      ensuredRef.current = true;
      void load();
    }
  }, [load]);

  return { data, loading, error, ensure, reload: load };
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={ServerCrash}
      title="Couldn't load this section"
      description={message}
      action={<Button variant="outline" onClick={onRetry}>Try again</Button>}
    />
  );
}

function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}

function useEnsure(section: { ensure: () => void }) {
  const { ensure } = section;
  useEffect(() => {
    ensure();
  }, [ensure]);
}

// ------------------------------------------------------------------ notifications

const NOTIFICATION_ICONS: Record<string, typeof Mail> = {
  FOLLOW: UserPlus,
  FOLLOW_REQUEST: UserPlus,
  FOLLOW_ACCEPTED: UserCheck,
  POST_LIKE: Heart,
  POST_COMMENT: MessageSquarePlus,
  COMMENT_REPLY: MessageSquarePlus,
  MENTION: AtSign,
  POST_SHARE: Share2,
  MESSAGE: Mail,
  MESSAGE_REQUEST: MailQuestion,
  INQUIRY: Mail,
  INQUIRY_RESPONSE: MailCheck,
  SAVE: Bookmark,
  SYSTEM: Info,
};

const GROUPABLE_TEXT: Record<string, string> = {
  FOLLOW: " started following you",
  FOLLOW_REQUEST: " requested to follow you",
  FOLLOW_ACCEPTED: " accepted your follow request",
  POST_LIKE: " liked your post",
  POST_COMMENT: " commented on your post",
  COMMENT_REPLY: " replied to your comment",
  MENTION: " mentioned you",
  POST_SHARE: " shared your post",
  MESSAGE: " sent you a message",
  MESSAGE_REQUEST: " sent a message request",
  SAVE: " saved your work",
};

/** Sentence text for a notification group (actor names prepended by caller). */
function groupText(g: NotificationGroupDTO): { actor: string; actorUsername: string; rest: string } {
  const first = g.actors[0];
  const actor = first?.name ?? (typeof g.payload.actor === "string" ? g.payload.actor : "Someone");
  const actorUsername = first?.username ?? (typeof g.payload.actorUsername === "string" ? g.payload.actorUsername : "");
  const excerpt = typeof g.payload.excerpt === "string" ? g.payload.excerpt : "";
  const subject = typeof g.payload.subject === "string" ? g.payload.subject : "";
  const projectTitle = typeof g.payload.projectTitle === "string" ? g.payload.projectTitle : "";
  const status = typeof g.payload.status === "string" ? g.payload.status.toLowerCase() : "";
  const message = typeof g.payload.message === "string" ? g.payload.message : "";

  switch (g.type) {
    case "FOLLOW":
    case "FOLLOW_REQUEST":
    case "FOLLOW_ACCEPTED":
      return { actor, actorUsername, rest: GROUPABLE_TEXT[g.type] ?? " interacted with you" };
    case "POST_LIKE":
      return { actor, actorUsername, rest: excerpt ? ` liked your post: “${excerpt.slice(0, 60)}”` : GROUPABLE_TEXT.POST_LIKE };
    case "POST_COMMENT":
      return { actor, actorUsername, rest: excerpt ? ` commented: “${excerpt.slice(0, 60)}”` : GROUPABLE_TEXT.POST_COMMENT };
    case "COMMENT_REPLY":
      return { actor, actorUsername, rest: excerpt ? ` replied: “${excerpt.slice(0, 60)}”` : GROUPABLE_TEXT.COMMENT_REPLY };
    case "MENTION":
      return { actor, actorUsername, rest: excerpt ? ` mentioned you: “${excerpt.slice(0, 60)}”` : GROUPABLE_TEXT.MENTION };
    case "POST_SHARE":
      return { actor, actorUsername, rest: GROUPABLE_TEXT.POST_SHARE };
    case "MESSAGE":
      return { actor, actorUsername, rest: excerpt ? `: ${excerpt.slice(0, 80)}` : GROUPABLE_TEXT.MESSAGE };
    case "MESSAGE_REQUEST":
      return { actor, actorUsername, rest: GROUPABLE_TEXT.MESSAGE_REQUEST };
    case "INQUIRY":
      return { actor, actorUsername, rest: subject ? ` sent an inquiry: ${subject}` : " sent you an inquiry" };
    case "INQUIRY_RESPONSE":
      return { actor, actorUsername, rest: status === "accepted" || status === "declined" ? ` ${status} your inquiry` : " responded to your inquiry" };
    case "SAVE":
      return { actor, actorUsername, rest: projectTitle ? ` saved your project ${projectTitle}` : GROUPABLE_TEXT.SAVE };
    case "SYSTEM":
      return { actor: "", actorUsername: "", rest: message || "Platform notice" };
    default:
      return { actor, actorUsername, rest: " interacted with your portfolio" };
  }
}

function groupTargetHref(g: NotificationGroupDTO): string | null {
  const postId = typeof g.payload.postId === "string" ? g.payload.postId : null;
  const conversationId = typeof g.payload.conversationId === "string" ? g.payload.conversationId : null;
  if (g.type === "MESSAGE" || g.type === "MESSAGE_REQUEST") return conversationId ? `#/messages/${conversationId}` : "#/messages";
  if (postId) return `#/post/${postId}`;
  if (g.type === "FOLLOW" || g.type === "FOLLOW_REQUEST" || g.type === "FOLLOW_ACCEPTED") {
    const username = typeof g.payload.actorUsername === "string" ? g.payload.actorUsername : null;
    return username ? `#/u/${username}` : "#/connect";
  }
  return null;
}

function NotificationsSection() {
  const section = useSection<{ groups: NotificationGroupDTO[]; unreadCount: number }>('/api/me/notifications');
  useEnsure(section);
  const [markingAll, setMarkingAll] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const groups = section.data?.groups ?? [];
  const unreadCount = groups.filter((g) => g.unread && !g.ids.every((id) => readIds.has(id))).length;

  const markRead = async (ids: string[]) => {
    try {
      await api("/api/me/notifications/read", { method: "POST", json: { ids } });
      setReadIds((prev) => new Set([...prev, ...ids]));
      window.dispatchEvent(new Event("bean:unread-changed"));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await api("/api/me/notifications/read", { method: "POST", json: {} });
      setReadIds(new Set(groups.flatMap((g) => g.ids)));
      window.dispatchEvent(new Event("bean:unread-changed"));
      toast.success("All notifications marked as read");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setMarkingAll(false);
    }
  };

  if (section.loading) return <ListSkeleton rows={5} />;
  if (section.error) return <SectionError message={section.error} onRetry={() => void section.reload()} />;

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        title="No notifications yet"
        description="When someone follows you, likes or comments on a post, mentions you or sends a message, it will show up here."
        action={<Button variant="outline" onClick={() => navigate("/messages")}><MailQuestion className="size-4" aria-hidden /> Open messages</Button>}
      />
    );
  }

  return (
    <div className="space-y-3">
      {unreadCount > 0 && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void markAll()} disabled={markingAll}>
            {markingAll ? "Marking…" : "Mark all read"}
          </Button>
        </div>
      )}
      <ul className="space-y-2" aria-label="Notifications">
        {groups.map((g) => {
          const Icon = NOTIFICATION_ICONS[g.type] ?? Info;
          const unread = g.unread && !g.ids.every((id) => readIds.has(id));
          const parts = groupText(g);
          const href = groupTargetHref(g);
          const otherCount = Math.max(0, g.count - g.actors.length);
          const fullText = parts.actor ? `${parts.actor}${parts.rest}` : parts.rest;
          return (
            <li key={g.key}>
              <div
                role={href ? "link" : undefined}
                aria-label={`${fullText}${unread ? " (unread)" : ""}`}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border bg-card p-4 text-left transition-all",
                  unread
                    ? "border-l-primary border-primary/50 hover:border-l-primary hover:border-primary/70"
                    : "border-l-transparent border-border/50 opacity-80 hover:opacity-100"
                )}
              >
                <span
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-full",
                    unread ? "bg-gold-soft text-primary" : "bg-secondary text-muted-foreground"
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-relaxed text-foreground">
                    {parts.actor && parts.actorUsername ? (
                      <>
                        <a
                          href={`#/u/${parts.actorUsername}`}
                          className="font-medium underline-offset-2 hover:text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {parts.actor}
                        </a>
                        {parts.rest}
                        {g.count > 1 ? <span className="text-muted-foreground"> · {g.count} notification{g.count === 1 ? "" : "s"}{otherCount > 0 ? ` from ${otherCount} more` : ""}</span> : null}
                      </>
                    ) : (
                      fullText
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{formatDate(g.latestAt)}</span>
                </span>
                {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
              </div>
            </li>
          );
        })}
      </ul>
      <NotificationPreferences />
    </div>
  );
}

// ------------------------------------------------------------------ notification preferences

const PREF_TYPES: { type: string; label: string }[] = [
  { type: "FOLLOW", label: "New followers and follow requests" },
  { type: "POST_LIKE", label: "Likes on your posts" },
  { type: "POST_COMMENT", label: "Comments and replies" },
  { type: "MENTION", label: "Mentions" },
  { type: "POST_SHARE", label: "Shares of your posts" },
  { type: "MESSAGE", label: "Direct messages" },
];

function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    api<{ preferences: Record<string, boolean> }>("/api/me/notifications/preferences")
      .then((r) => setPrefs(r.preferences))
      .catch(() => undefined);
  }, []);

  async function toggle(type: string) {
    if (!prefs) return;
    const next = !prefs[type];
    setPrefs({ ...prefs, [type]: next });
    try {
      await api("/api/me/notifications/preferences", { method: "PATCH", json: { type, enabled: next } });
    } catch (e) {
      setPrefs({ ...prefs, [type]: !next }); // revert on failure
      toast.error(errText(e));
    }
  }

  if (!prefs) return null;
  return (
    <details className="rounded-xl border border-border/50 bg-card p-4">
      <summary className="cursor-pointer text-sm font-medium">Notification preferences</summary>
      <ul className="mt-3 space-y-2">
        {PREF_TYPES.map(({ type, label }) => (
          <li key={type} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <button
              type="button"
              role="switch"
              aria-checked={prefs[type] ?? true}
              aria-label={label}
              onClick={() => void toggle(type)}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                prefs[type] ?? true ? "bg-primary" : "bg-secondary"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 size-4 rounded-full bg-background transition-all",
                  (prefs[type] ?? true) ? "left-4.5" : "left-0.5"
                )}
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ------------------------------------------------------------------ inquiries

function inquiryTypeBadge(type: string) {
  if (type === "INQUIRY") return <Badge className="rounded-full">Inquiry</Badge>;
  if (type === "COLLABORATION") return <Badge variant="outline" className="rounded-full">Collaboration</Badge>;
  if (type === "INVITE") return <Badge variant="secondary" className="rounded-full">Invite</Badge>;
  return <Badge variant="secondary" className="rounded-full">{type}</Badge>;
}

function inquiryStatusBadge(status: string) {
  if (status === "PENDING") return <Badge variant="secondary" className="rounded-full">Pending</Badge>;
  if (status === "ACCEPTED")
    return (
      <Badge variant="outline" className="rounded-full border-primary/40 text-primary">
        Accepted
      </Badge>
    );
  if (status === "DECLINED")
    return <Badge variant="outline" className="rounded-full text-muted-foreground">Declined</Badge>;
  return <Badge variant="secondary" className="rounded-full">{status}</Badge>;
}

function InquiryCard({
  inquiry,
  actionable,
  onRespond,
  busy,
}: {
  inquiry: InquiryDTO;
  actionable: boolean;
  onRespond: (id: string, status: "ACCEPTED" | "DECLINED") => void;
  busy: boolean;
}) {
  return (
    <Card className={cn(actionable && inquiry.status === "PENDING" && "border-primary/25")}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {inquiryTypeBadge(inquiry.type)}
            <p className="min-w-0 text-sm font-medium text-foreground">{inquiry.subject}</p>
          </div>
          {inquiryStatusBadge(inquiry.status)}
        </div>

        <p className="mt-2.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{inquiry.message}</p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <a
            href={`#/u/${inquiry.counterparty.username}`}
            className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
          >
            {inquiry.counterparty.name}
            <span className="font-normal text-muted-foreground">@{inquiry.counterparty.username}</span>
          </a>
          {inquiry.project && (
            <a
              href={`#/p/${inquiry.project.id}`}
              className="underline-offset-2 transition-colors hover:text-primary hover:underline"
            >
              Re: {inquiry.project.title}
            </a>
          )}
          <span>{formatDate(inquiry.createdAt)}</span>
        </div>

        {actionable && inquiry.status === "PENDING" && (
          <div className="mt-4 flex items-center gap-2 border-t border-border/50 pt-3">
            <Button size="sm" disabled={busy} onClick={() => onRespond(inquiry.id, "ACCEPTED")}>
              Accept
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onRespond(inquiry.id, "DECLINED")}>
              Decline
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InquiriesSection() {
  const section = useSection<{ incoming: InquiryDTO[]; outgoing: InquiryDTO[] }>("/api/me/inquiries");
  useEnsure(section);
  const [busyId, setBusyId] = useState<string | null>(null);

  const respond = async (id: string, status: "ACCEPTED" | "DECLINED") => {
    setBusyId(id);
    try {
      await api(`/api/inquiries/${id}`, { method: "PATCH", json: { status } });
      toast.success(status === "ACCEPTED" ? "Inquiry accepted — the sender has been notified" : "Inquiry declined");
      await section.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  if (section.loading) return <ListSkeleton rows={3} />;
  if (section.error) return <SectionError message={section.error} onRetry={() => void section.reload()} />;

  const incoming = section.data?.incoming ?? [];
  const outgoing = section.data?.outgoing ?? [];

  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <EmptyState
        icon={MessageSquarePlus}
        title="No inquiries yet"
        description="Inquiries and collaboration requests you send or receive will appear here. Reach out to people you find interesting from their profile."
        action={<Button variant="outline" onClick={() => navigate("/explore")}>Find projects</Button>}
      />
    );
  }

  return (
    <div className="space-y-6">
      <section aria-label="Received inquiries">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Received ({incoming.length})
        </h3>
        {incoming.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
            Nothing received yet.
          </p>
        ) : (
          <div className="space-y-3">
            {incoming.map((i) => (
              <InquiryCard key={i.id} inquiry={i} actionable busy={busyId === i.id} onRespond={(id, s) => void respond(id, s)} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Sent inquiries">
        <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Sent ({outgoing.length})
        </h3>
        {outgoing.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
            You haven&apos;t sent any inquiries yet.
          </p>
        ) : (
          <div className="space-y-3">
            {outgoing.map((i) => (
              <InquiryCard key={i.id} inquiry={i} actionable={false} busy={false} onRespond={() => undefined} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ people sections

function PeopleSection({
  path,
  emptyTitle,
  emptyDescription,
  withRequests = false,
}: {
  path: string;
  emptyTitle: string;
  emptyDescription: string;
  /** Followers path: also surface PENDING follow requests with approve/decline. */
  withRequests?: boolean;
}) {
  const section = useSection<
    | { people: PublicPerson[] }
    | { people: { person: PublicPerson }[]; requests?: { person: PublicPerson; requestedAt: string }[] }
  >(path);
  useEnsure(section);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [handled, setHandled] = useState<Set<string>>(new Set());

  // Normalize both shapes.
  const raw = section.data;
  const people: PublicPerson[] = raw
    ? (Array.isArray((raw as { people: unknown }).people)
        ? ((raw as { people: unknown[] }).people[0] && typeof (raw as { people: unknown[] }).people[0] === "object" && "person" in ((raw as { people: unknown[] }).people[0] as object)
            ? (raw as { people: { person: PublicPerson }[] }).people.map((x) => x.person)
            : (raw as { people: PublicPerson[] }).people)
        : [])
    : [];
  const requests = withRequests && raw && "requests" in raw ? ((raw as { requests?: { person: PublicPerson }[] }).requests ?? []) : [];
  const visiblePeople = people.filter((p) => !removed.has(p.username));
  const visibleRequests = requests.filter((r) => !handled.has(r.person.username));

  async function respondToRequest(username: string, action: "approve" | "decline") {
    if (!requests.some((r) => r.person.username === username)) return;
    setBusyId(username);
    try {
      await api("/api/me/requests", { method: "POST", json: { username, action } });
      setHandled((prev) => new Set([...prev, username]));
      toast.success(action === "approve" ? `@${username} approved` : "Request declined");
      await section.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyId(null);
    }
  }

  async function removeFollower(username: string) {
    if (!people.some((p) => p.username === username)) return;
    setBusyId(username);
    try {
      await api("/api/me/followers", { method: "DELETE", json: { username } });
      setRemoved((prev) => new Set([...prev, username]));
      toast.success(`@${username} removed from your followers`);
      await section.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyId(null);
    }
  }

  if (section.loading) return <ListSkeleton rows={3} />;
  if (section.error) return <SectionError message={section.error} onRetry={() => void section.reload()} />;

  if (visiblePeople.length === 0 && visibleRequests.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={emptyTitle}
        description={emptyDescription}
        action={<Button variant="outline" onClick={() => navigate("/explore")}>Find projects</Button>}
      />
    );
  }

  return (
    <div className="space-y-6">
      {visibleRequests.length > 0 ? (
        <section aria-label="Follow requests">
          <h3 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Follow requests ({visibleRequests.length})
          </h3>
          <ul className="space-y-2">
            {visibleRequests.map((r) => (
              <li key={r.person.username} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-card p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.person.name}</p>
                  <p className="truncate text-xs text-muted-foreground">@{r.person.username} · requested to follow you</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busyId === r.person.username} onClick={() => void respondToRequest(r.person.username, "approve")}>Approve</Button>
                  <Button size="sm" variant="outline" disabled={busyId === r.person.username} onClick={() => void respondToRequest(r.person.username, "decline")}>Decline</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={emptyTitle ? undefined : "People"}>
        {visiblePeople.length === 0 ? null : (
          <div className="grid gap-4 sm:grid-cols-2">
            {visiblePeople.map((p) => (
              <div key={p.username} className="relative">
                <PersonCard person={p} />
                {withRequests ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-2 top-2 gap-1 text-xs text-muted-foreground hover:text-destructive"
                    disabled={busyId === p.username}
                    onClick={() => void removeFollower(p.username)}
                  >
                    <UserX className="size-3.5" aria-hidden /> Remove
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ blocked

function BlockedSection() {
  const section = useSection<{ blocks: PublicPerson[] }>("/api/me/blocks");
  useEnsure(section);
  const [busy, setBusy] = useState<string | null>(null);

  const unblock = async (username: string) => {
    setBusy(username);
    try {
      await api(`/api/me/blocks?username=${encodeURIComponent(username)}`, { method: "DELETE" });
      toast.success(`@${username} unblocked`);
      await section.reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (section.loading) return <ListSkeleton rows={2} />;
  if (section.error) return <SectionError message={section.error} onRetry={() => void section.reload()} />;

  const blocks = section.data?.blocks ?? [];
  if (blocks.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="You haven't blocked anyone"
        description="Blocked accounts can't follow you, send inquiries, or see you in discovery. You can block from any profile or project page."
      />
    );
  }

  return (
    <ul className="space-y-2" aria-label="Blocked accounts">
      {blocks.map((p) => (
        <li
          key={p.username}
          className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card p-4"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
            <p className="truncate text-xs text-muted-foreground">@{p.username}</p>
          </div>
          <Button variant="outline" size="sm" disabled={busy === p.username} onClick={() => void unblock(p.username)}>
            {busy === p.username ? "Unblocking…" : "Unblock"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ view

const TABS = [
  { value: "notifications", label: "Notifications" },
  { value: "inquiries", label: "Inquiries" },
  { value: "following", label: "Following" },
  { value: "followers", label: "Followers" },
  { value: "blocked", label: "Blocked" },
] as const;

export default function ConnectView() {
  const [tab, setTab] = useState<string>("notifications");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <SectionHeader
        title="Connect"
        description="Notifications, inquiries and the people around your work."
        className="mb-6"
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="px-3.5">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="notifications" className="mt-4">
          <NotificationsSection />
        </TabsContent>
        <TabsContent value="inquiries" className="mt-4">
          <InquiriesSection />
        </TabsContent>
        <TabsContent value="following" className="mt-4">
          <PeopleSection
            path="/api/me/following"
            emptyTitle="You're not following anyone yet"
            emptyDescription="Follow creators whose work resonates with you — their new projects will surface for you."
          />
        </TabsContent>
        <TabsContent value="followers" className="mt-4">
          <PeopleSection
            path="/api/me/followers"
            emptyTitle="No followers yet"
            emptyDescription="Publish projects and share your Folio link — people who follow you will appear here."
            withRequests
          />
        </TabsContent>
        <TabsContent value="blocked" className="mt-4">
          <BlockedSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
