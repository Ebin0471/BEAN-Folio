"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Globe,
  ImageOff,
  Mail,
  MapPin,
  MessageSquare,
  Send,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import { api, ApiError, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSeo } from "@/lib/seo";
import { useSession } from "@/lib/session";
import { publicProfilePath, seoOrigin } from "@/lib/site-url";
import type { ProjectCardDTO, PublicProfileResponse } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/bean/EmptyState";
import { ProfileHeader } from "@/components/bean/ProfileHeader";
import { ProjectCard } from "@/components/bean/ProjectCard";
import { FollowButton } from "@/components/bean/FollowButton";
import { PostCard, recordPostView } from "@/components/bean/PostCard";
import { PersonCard } from "@/components/bean/PersonCard";
import { SectionHeader } from "@/components/bean/SectionHeader";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";
import { cn } from "@/lib/utils";
import type { FollowersResponse, PublicPost, PublicPerson, RelationshipResponse } from "@/lib/types";

const INQUIRY_TYPES = [
  { value: "INQUIRY", label: "General inquiry" },
  { value: "COLLABORATION", label: "Collaboration proposal" },
  { value: "INVITE", label: "Invitation / opportunity" },
] as const;

// ------------------------------------------------------------------ skeletons

function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading profile">
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <Skeleton className={cn("w-full rounded-xl", BANNER_ASPECT_CLASS)} />
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ view

/**
 * PublicProfileView — the BEAN Folio public PROFILE at `/u/<username>`.
 *
 * This route is ALWAYS the platform profile experience (identity, skills,
 * published projects, collections) — for every account, whether or not the
 * creator also has a standalone website. The published website is a separate,
 * independent page at `/site/<username>` (PublishedSiteView); the two routes
 * never render each other's content (see lib/site-url). The platform shell
 * (header/footer) stays visible here unconditionally — this view never
 * touches lib/standalone-site.
 */
export default function PublicProfileView({ username }: { username: string }) {
  const { user } = useSession();

  const [data, setData] = useState<PublicProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // contact dialog
  const [contactOpen, setContactOpen] = useState(false);
  const [inqType, setInqType] = useState<string>("INQUIRY");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // social graph (Phase: real social network)
  const [relationship, setRelationship] = useState<RelationshipResponse | null>(null);
  const [peopleDialog, setPeopleDialog] = useState<"followers" | "following" | null>(null);
  const [messageBusy, setMessageBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(username)}`);
      setData(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : "Could not load this profile");
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  // Relationship probe: follow state + mutuals (signed-in, non-self only).
  useEffect(() => {
    if (!user || user.username === username) {
      setRelationship(null);
      return;
    }
    let alive = true;
    api<RelationshipResponse>(`/api/profiles/${encodeURIComponent(username)}/follow`)
      .then((r) => alive && setRelationship(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [user, username]);

  async function startConversation() {
    if (!user) {
      navigate("/auth");
      return;
    }
    setMessageBusy(true);
    try {
      const r = await api<{ conversationId: string }>("/api/me/messages", {
        method: "POST",
        json: { username },
      });
      navigate(`/messages/${r.conversationId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open a conversation");
    } finally {
      setMessageBusy(false);
    }
  }

  // ------------------------------------------------------------- SEO
  // Applied once real data resolves (or an honest not-found/unavailable state).
  // ProfilePage + Person structured data ONLY from genuine profile values.
  const seoInput = useMemo(() => {
    if (loading) return null; // shell default stays in place while loading
    if (notFound) {
      return {
        title: "Profile not found — BEAN Folio",
        description: "This profile doesn't exist or is private.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (error || !data) {
      return {
        title: "Profile unavailable — BEAN Folio",
        description: "The profile could not be loaded.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    const { profile } = data;
    const title = `${profile.name}${profile.headline ? ` — ${profile.headline}` : ""} | BEAN Folio`;
    const description =
      profile.bio?.trim() ||
      profile.headline ||
      `Portfolio of ${profile.name} on BEAN Folio — published projects, skills and contact.`;
    // Metadata URLs use the VERIFIED configured production origin only (see
    // lib/site-url) — never the current preview/workspace host. Without one,
    // absolute URL/image fields are omitted instead of pointing at an
    // internal address.
    const origin = seoOrigin();
    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "ProfilePage",
      mainEntity: {
        "@type": "Person",
        name: profile.name,
        ...(profile.username ? { alternateName: `@${profile.username}` } : {}),
        ...(profile.headline ? { jobTitle: profile.headline } : {}),
        ...(profile.bio ? { description: profile.bio } : {}),
        ...(profile.location ? { address: profile.location } : {}),
        ...(profile.skills.length > 0 ? { knowsAbout: profile.skills } : {}),
        ...(profile.websiteUrl ? { sameAs: [profile.websiteUrl] } : {}),
        ...(origin && profile.avatarUrl ? { image: `${origin}${profile.avatarUrl}` } : {}),
        ...(origin && publicProfilePath(profile.username)
          ? { url: `${origin}${publicProfilePath(profile.username)}` } // PATH form — served at the path by src/proxy.ts; matches the canonical.
          : {}),
      },
    };
    return {
      title,
      description: description.slice(0, 300),
      path: publicProfilePath(username) ?? `/u/${username}`,
      type: "profile" as const,
      image: profile.avatarUrl,
      jsonLd,
    };
  }, [data, loading, notFound, error, username]);
  useSeo(seoInput);

  function openContact() {
    if (!user) {
      toast.error("Sign in to send an inquiry", {
        action: { label: "Sign in", onClick: () => navigate("/auth") },
      });
      return;
    }
    setSubject("");
    setMessage("");
    setInqType("INQUIRY");
    setContactOpen(true);
  }

  async function sendInquiry() {
    if (!subject.trim() || !message.trim()) {
      toast.error("Add a subject and a message first.");
      return;
    }
    setSending(true);
    try {
      await api("/api/inquiries", {
        method: "POST",
        json: {
          recipientUsername: username,
          type: inqType,
          subject: subject.trim(),
          message: message.trim(),
        },
      });
      toast.success("Inquiry sent — it will appear in their Connect inbox.");
      setContactOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast.error("Sign in to send an inquiry", {
          action: { label: "Sign in", onClick: () => navigate("/auth") },
        });
      } else {
        toast.error(e instanceof Error ? e.message : "Could not send inquiry");
      }
    } finally {
      setSending(false);
    }
  }

  // ------------------------------------------------------------ render guards

  if (loading) return <ProfileSkeleton />;

  if (notFound) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title="This profile doesn't exist or is private."
          description="The person you're looking for may have changed their username, or their profile is hidden."
          action={<Button onClick={() => navigate("/explore")}>Explore projects</Button>}
        />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title="Something went wrong"
          description={error ?? "Could not load this profile."}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => navigate("/")}>Back to Discover</Button>
            </div>
          }
        />
      </div>
    );
  }

  const { profile, isSelf, isFollowing, projects, collections } = data;
  const contactDialog = (
    <Dialog open={contactOpen} onOpenChange={setContactOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Contact {profile.name}</DialogTitle>
          <DialogDescription>Your message goes to their Connect inbox. Be specific and kind.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="inq-type">Type</Label>
            <Select value={inqType} onValueChange={setInqType}>
              <SelectTrigger id="inq-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INQUIRY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inq-subject">Subject</Label>
            <Input
              id="inq-subject"
              value={subject}
              maxLength={140}
              placeholder="e.g. Exhibition opportunity this autumn"
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inq-message">Message</Label>
            <Textarea
              id="inq-message"
              value={message}
              maxLength={2000}
              placeholder="Introduce yourself and what you have in mind…"
              className={cn("min-h-28")}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground">{message.length}/2000</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setContactOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void sendInquiry()} disabled={sending || !subject.trim() || !message.trim()}>
            <Send className="size-4" aria-hidden /> {sending ? "Sending…" : "Send inquiry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // ---------------------------------------------------------------- standard mode
  // Always the BEAN Folio profile experience. A published custom website is
  // NOT rendered here — it is a separate, independent page at
  // /site/<username> (PublishedSiteView). The platform shell stays visible.

  const person = {
    username: profile.username,
    name: profile.name,
    headline: profile.headline,
    avatarUrl: profile.avatarUrl,
    location: profile.location,
    availability: profile.availability,
    professions: profile.professions,
    skills: profile.skills,
    stats: { followers: profile.stats.followers, projects: profile.stats.projects },
  };

  const hasBio = Boolean(profile.bio);
  const hasSkills = profile.skills.length > 0;
  const hasCollections = collections.length > 0;
  // Portfolio curation: projects the creator FEATURED in their Studio lead the
  // profile. When they haven't curated anything yet, fall back to the recent-3
  // showcase so the section still earns its place (backward compatible).
  const curated = projects.filter((p) => p.featured);
  const hasCurated = curated.length > 0;
  const hasFeatured = hasCurated || projects.length > 3;
  const featured = hasCurated ? curated.slice(0, 6) : projects.slice(0, 3);

  return (
    <div>
      {/* ---------------- 1. header + cover */}
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        {isSelf && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-gold-soft/40 px-4 py-2.5">
            <p className="text-sm text-primary">This is how your profile appears to others.</p>
            <Button variant="outline" size="sm" onClick={() => navigate("/folio")}>
              Edit profile
            </Button>
          </div>
        )}

        <ProfileHeader
          variant="public"
          profile={{
            name: profile.name,
            username: profile.username,
            headline: profile.headline,
            location: profile.location,
            availability: profile.availability,
            experienceLevel: profile.experienceLevel,
            professions: profile.professions,
            skills: profile.skills,
            avatarUrl: profile.avatarUrl,
            coverUrl: profile.coverUrl,
            coverPositionY: profile.coverPositionY,
            avatarFit: profile.avatarFit,
            avatarZoom: profile.avatarZoom,
            avatarPosX: profile.avatarPosX,
            avatarPosY: profile.avatarPosY,
          }}
          actions={
            <>
              <FollowButton person={person} size="default" initialState={isFollowing ? "ACTIVE" : "NONE"} />
              <Button variant="outline" onClick={() => void startConversation()} disabled={messageBusy} className="gap-1.5">
                <MessageSquare className="size-4" aria-hidden /> Message
              </Button>
              <Button variant="outline" onClick={openContact} className="gap-1.5">
                <Mail className="size-4" aria-hidden /> Contact
              </Button>
            </>
          }
        />
      </div>

      {/* ---------------- 2. biography + skills */}
      {(hasBio || hasSkills) && (
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <section className="mt-6 rounded-xl border border-border/60 bg-card p-4 sm:p-6" aria-label="Biography">
            {hasBio && (
              <>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">About {profile.name.split(" ")[0]}</h2>
                <p className="mt-2 max-w-3xl whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">{profile.bio}</p>
              </>
            )}
            {hasSkills && (
              <div className={cn(hasBio && "mt-5")}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Skills</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.skills.map((s) => (
                    <Badge key={s} variant="secondary" className="rounded-full font-normal">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---------------- 3. public stats (no estimated view counts for visitors) */}
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <section className="mt-6 grid grid-cols-3 gap-4" aria-label="Profile statistics">
          {(
            [
              { label: "Projects", value: profile.stats.projects, dialog: null as "followers" | "following" | null },
              { label: "Followers", value: profile.stats.followers, dialog: "followers" as const },
              { label: "Following", value: profile.stats.following, dialog: "following" as const },
              ...(isSelf ? [{ label: "Profile views (est.)", value: profile.stats.profileViews ?? 0, dialog: null }] : []),
            ] as const
          ).map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={s.dialog ? () => setPeopleDialog(s.dialog) : undefined}
              aria-label={s.dialog ? `${s.label} — view list` : s.label}
              className={cn(
                "rounded-xl border border-border/60 bg-card p-4 text-left",
                s.dialog && "transition-colors hover:border-primary/40"
              )}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.label}</p>
              <p className="mt-1.5 font-display text-2xl font-semibold">{s.value}</p>
            </button>
          ))}
        </section>

        {/* mutual connections (real follow graph) */}
        {relationship && relationship.mutuals.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Followed by {relationship.mutuals.length} connection{relationship.mutuals.length === 1 ? "" : "s"} you know:
            {" "}
            {relationship.mutuals.slice(0, 3).map((m) => (
              <a key={m.username} href={`#/u/${m.username}`} className="font-medium text-foreground hover:text-primary">
                {m.name}
              </a>
            ))}
            {relationship.mutuals.length > 3 ? " and more" : ""}
          </p>
        ) : null}

        {/* ---------------- social posts (separate from Featured Work) */}
        <SocialPostsSection username={username} isSelf={isSelf} />

        {/* ---------------- 4. featured projects (only when there are more than three) */}
        {hasFeatured && (
          <section className="mt-10" aria-label="Featured projects">
            <SectionHeader
              title="Featured work"
              description={hasCurated ? "Hand-picked by the creator in their Studio." : "A selection of recently published projects."}
            />
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((p: ProjectCardDTO) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          </section>
        )}

        {/* ---------------- 5. all published projects */}
        <section className="mt-10" aria-label="All projects">
          <SectionHeader
            title={hasFeatured ? "All projects" : "Projects"}
            description={isSelf ? "Published work on your profile — drafts stay private." : undefined}
          />
          <div className="mt-5">
            {projects.length === 0 ? (
              <EmptyState
                icon={UserRound}
                title={isSelf ? "You haven't published anything yet" : "No published projects yet"}
                description={
                  isSelf
                    ? "Publish a project from your studio and it will appear here for everyone."
                    : `${profile.name} hasn't published any work yet. Check back soon.`
                }
                action={isSelf ? <Button onClick={() => navigate("/studio/new")}>New project</Button> : undefined}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {projects.map((p: ProjectCardDTO) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ---------------- 6. collections (only when populated) */}
        {hasCollections && (
          <section className="mt-10" aria-label="Collections">
            <SectionHeader title="Collections" description="Curated sets of published work." />
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {collections.map((c) => (
                <div key={c.id} className="rounded-xl border border-border/60 bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium">{c.name}</p>
                    <Badge variant="secondary" className="rounded-full">
                      {c.items.length} {c.items.length === 1 ? "item" : "items"}
                    </Badge>
                  </div>
                  {c.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---------------- 7. contact & social */}
        <section className="mt-10 mb-12" aria-label="Contact and social links">
          <SectionHeader title="Get in touch" description="Open for inquiries, collaborations and opportunities." />
          <div className="mt-5 flex flex-col gap-4 rounded-xl border border-border/60 bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="space-y-1.5 text-sm">
              {profile.contactEmail ? (
                <p className="flex items-center gap-2">
                  <Mail className="size-4 text-muted-foreground" aria-hidden />
                  <a href={`mailto:${profile.contactEmail}`} className="text-primary underline-offset-4 hover:underline">
                    {profile.contactEmail}
                  </a>
                </p>
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Mail className="size-4" aria-hidden /> Use the contact button to reach {profile.name.split(" ")[0]}.
                </p>
              )}
              {profile.websiteUrl && (
                <p className="flex items-center gap-2">
                  <Globe className="size-4 text-muted-foreground" aria-hidden />
                  <a href={profile.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">
                    {profile.websiteUrl.replace(/^https?:\/\//, "")}
                  </a>
                </p>
              )}
              {profile.location && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="size-4" aria-hidden /> {profile.location}
                </p>
              )}
              <p className="text-xs text-muted-foreground">Member since {formatDate(profile.createdAt)}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button onClick={openContact} className="gap-1.5">
                <Mail className="size-4" aria-hidden /> Send inquiry
              </Button>
              {profile.websiteUrl && (
                <Button variant="outline" onClick={() => window.open(profile.websiteUrl ?? "", "_blank", "noopener")} className="gap-1.5">
                  <ExternalLink className="size-4" aria-hidden /> Website
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* ---------------- contact dialog */}
      {contactDialog}

      {/* ---------------- followers / following dialog */}
      <PeopleDialog
        mode={peopleDialog}
        username={username}
        onClose={() => setPeopleDialog(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ social posts

/**
 * The creator's POSTS tab (social posts — strictly separate from Featured
 * Work / projects). The author additionally sees drafts + scheduled here.
 */
function SocialPostsSection({ username, isSelf }: { username: string; isSelf: boolean }) {
  const [items, setItems] = useState<PublicPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let alive = true;
    api<{ items: PublicPost[]; nextCursor: string | null }>(`/api/profiles/${encodeURIComponent(username)}/posts?limit=6`)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => alive && setPhase("hidden"));
    return () => {
      alive = false;
    };
  }, [username]);

  useEffect(() => {
    for (const p of items) recordPostView(p.id);
  }, [items]);

  function patch(next: PublicPost) {
    setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  }
  function remove(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  if (phase === "loading") {
    return (
      <section className="mt-10" aria-label="Posts">
        <Skeleton className="h-48 max-w-2xl rounded-xl" />
      </section>
    );
  }
  if (phase === "hidden" || items.length === 0) return null; // quiet creators stay clean

  return (
    <section className="mt-10" aria-label="Posts">
      <SectionHeader
        title="Posts"
        description={isSelf ? "Your social posts — drafts and scheduled posts are only visible to you." : "Updates, reels and questions shared with the community."}
      />
      <div className="mt-5 mx-auto flex max-w-2xl flex-col gap-4">
        {items.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            onChange={patch}
            onDelete={remove}
          />
        ))}
      </div>
      {cursor ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() =>
              void api<{ items: PublicPost[]; nextCursor: string | null }>(
                `/api/profiles/${encodeURIComponent(username)}/posts?limit=6&cursor=${cursor}`
              ).then((r) => {
                setItems((prev) => [...prev, ...r.items]);
                setCursor(r.nextCursor);
              })
            }
          >
            Load more posts
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ people dialog

function PeopleDialog({
  mode,
  username,
  onClose,
}: {
  mode: "followers" | "following" | null;
  username: string;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<PublicPerson[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!mode) return;
    api<FollowersResponse>(`/api/profiles/${encodeURIComponent(username)}/${mode}?limit=40`)
      .then((r) => setPeople(r.people.map((x) => ("person" in x ? x.person : (x as unknown as PublicPerson)))))
      .catch(() => setPeople([]))
      .finally(() => setLoading(false));
  }, [mode, username]);

  return (
    <Dialog open={mode !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">{mode === "followers" ? "Followers" : "Following"}</DialogTitle>
          <DialogDescription>@{username} — real follow graph, ACTIVE connections only.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : people.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nobody here yet.</p>
        ) : (
          <div className="space-y-2">
            {people.map((p) => (
              <PersonCard key={p.username} person={p} />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
