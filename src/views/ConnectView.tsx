"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Info,
  Mail,
  MailCheck,
  MessageSquarePlus,
  ServerCrash,
  UserPlus,
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
import type { InquiryDTO, NotificationDTO, PublicPerson } from "@/lib/types";
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
  INQUIRY: Mail,
  INQUIRY_RESPONSE: MailCheck,
  SAVE: Bookmark,
  SYSTEM: Info,
};

/** Parse the stored payload into (actor, rest-of-sentence) defensively — never throw. */
function notificationParts(n: NotificationDTO): { actor: string; actorUsername: string; rest: string } {
  const actor = typeof n.payload.actor === "string" ? n.payload.actor : "Someone";
  const actorUsername = typeof n.payload.actorUsername === "string" ? n.payload.actorUsername : "";
  const subject = typeof n.payload.subject === "string" ? n.payload.subject : "";
  const projectTitle = typeof n.payload.projectTitle === "string" ? n.payload.projectTitle : "";
  const status = typeof n.payload.status === "string" ? n.payload.status.toLowerCase() : "";

  switch (n.type) {
    case "FOLLOW":
      return { actor, actorUsername, rest: " started following you" };
    case "INQUIRY":
      return { actor, actorUsername, rest: subject ? ` sent an inquiry: ${subject}` : " sent you an inquiry" };
    case "INQUIRY_RESPONSE":
      return {
        actor,
        actorUsername,
        rest: status === "accepted" || status === "declined" ? ` ${status} your inquiry` : " responded to your inquiry",
      };
    case "SAVE":
      return { actor, actorUsername, rest: projectTitle ? ` saved your project ${projectTitle}` : " saved your project" };
    case "SYSTEM":
      return {
        actor: "",
        actorUsername: "",
        rest: typeof n.payload.message === "string" ? n.payload.message : "Platform notice",
      };
    default:
      return { actor, actorUsername, rest: " interacted with your portfolio" };
  }
}

function NotificationsSection() {
  const section = useSection<{ notifications: NotificationDTO[]; unreadCount: number }>("/api/me/notifications");
  useEnsure(section);
  const [markingAll, setMarkingAll] = useState(false);
  // Local optimistic read state (≤ 30 rows) — avoids a full refetch per click.
  const [local, setLocal] = useState<NotificationDTO[] | null>(null);

  const items = local ?? section.data?.notifications ?? [];
  const unreadCount = items.filter((n) => !n.readAt).length;

  const applyRead = (ids: string[]) => {
    const idSet = new Set(ids);
    setLocal(
      items.map((n) => (idSet.has(n.id) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n))
    );
  };

  const markRead = async (ids: string[]) => {
    try {
      await api("/api/me/notifications/read", { method: "POST", json: { ids } });
      applyRead(ids);
      window.dispatchEvent(new Event("bean:unread-changed"));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await api("/api/me/notifications/read", { method: "POST", json: {} });
      setLocal(items.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
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

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        title="No notifications yet"
        description="When someone follows you, saves a project or sends an inquiry, it will show up here."
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
        {items.map((n) => {
          const Icon = NOTIFICATION_ICONS[n.type] ?? Info;
          const unread = !n.readAt;
          const parts = notificationParts(n);
          const fullText = `${parts.actor}${parts.rest}`;
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  if (unread) void markRead([n.id]);
                }}
                title={unread ? "Mark as read" : undefined}
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
                      </>
                    ) : (
                      fullText
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{formatDate(n.createdAt)}</span>
                </span>
                {unread && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
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
}: {
  path: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const section = useSection<{ people: PublicPerson[] }>(path);
  useEnsure(section);

  if (section.loading) return <ListSkeleton rows={3} />;
  if (section.error) return <SectionError message={section.error} onRetry={() => void section.reload()} />;

  const people = section.data?.people ?? [];
  if (people.length === 0) {
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
    <div className="grid gap-4 sm:grid-cols-2">
      {people.map((p) => (
        <PersonCard key={p.username} person={p} />
      ))}
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
          />
        </TabsContent>
        <TabsContent value="blocked" className="mt-4">
          <BlockedSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
