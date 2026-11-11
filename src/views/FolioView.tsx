"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Eye,
  FolderHeart,
  LayoutGrid,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  SquarePen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { api, formatDate } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import type { ProjectCardDTO, PublicMe } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { ProfileHeader } from "@/components/bean/ProfileHeader";
import { CompletionChecklist } from "@/components/bean/CompletionChecklist";
import { TagInput } from "@/components/bean/TagInput";
import { StatCard, SectionHeader } from "@/components/bean/SectionHeader";
import { categoryLabel } from "@/components/bean/ProjectCard";
import type { MediaDTO, ProfessionDTO, SkillDTO } from "@/lib/types";

// ------------------------------------------------------------------ types

interface FolioData {
  user: PublicMe;
  stats: { projects: number; published: number; followers: number; following: number; profileViews: number };
}

interface CollectionItem {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  items: ProjectCardDTO[];
}

// ------------------------------------------------------------------ helpers

function StatusBadge({ status }: { status: string }) {
  return status === "PUBLISHED" ? (
    <Badge className="rounded-full bg-gold-soft text-primary ring-1 ring-primary/25 border-transparent">Published</Badge>
  ) : (
    <Badge variant="secondary" className="rounded-full">Draft</Badge>
  );
}

function VisibilityBadge({ visibility }: { visibility: string }) {
  const label = visibility === "UNLISTED" ? "Unlisted" : visibility === "PRIVATE" ? "Private" : "Public";
  return (
    <Badge variant="outline" className="rounded-full text-muted-foreground">
      {label}
    </Badge>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your folio">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <Skeleton className="h-36 w-full rounded-none" />
        <div className="flex items-end gap-4 p-6">
          <Skeleton className="size-20 -mt-16 rounded-full" />
          <div className="space-y-2 pb-1">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

const EXPERIENCE_LEVELS = ["Student", "Early career", "Mid-career", "Senior", "Veteran (15+ years)"] as const;

// ------------------------------------------------------------------ view

export default function FolioView() {
  const { refresh } = useSession();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FolioData | null>(null);

  // profile form
  const [name, setName] = useState("");
  const [headline, setHeadline] = useState("");
  const [bio, setBio] = useState("");
  const [location, setLocation] = useState("");
  const [availability, setAvailability] = useState("");
  const [experienceLevel, setExperienceLevel] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [professions, setProfessions] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [bioAiBusy, setBioAiBusy] = useState(false);

  const [allProfessions, setAllProfessions] = useState<ProfessionDTO[]>([]);
  const [allSkills, setAllSkills] = useState<SkillDTO[]>([]);

  // projects + collections
  const [projects, setProjects] = useState<ProjectCardDTO[] | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [collections, setCollections] = useState<CollectionItem[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectCardDTO | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ------------------------------------------------------------ load

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<FolioData>("/api/me/profile");
      setData(res);
      setName(res.user.name);
      setHeadline(res.user.headline ?? "");
      setBio(res.user.bio ?? "");
      setLocation(res.user.location ?? "");
      setAvailability(res.user.availability ?? "");
      setExperienceLevel(res.user.experienceLevel ?? "");
      setContactEmail(res.user.contactEmail ?? "");
      setWebsiteUrl(res.user.websiteUrl ?? "");
      setProfessions(res.user.professions ?? []);
      setSkills(res.user.skills ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your folio");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<{ professions: ProfessionDTO[] }>("/api/professions")
      .then((r) => setAllProfessions(r.professions))
      .catch(() => undefined);
    api<{ skills: SkillDTO[] }>("/api/skills")
      .then((r) => setAllSkills(r.skills))
      .catch(() => undefined);
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await api<{ projects: ProjectCardDTO[] }>("/api/projects");
      setProjects(res.projects);
    } catch {
      // project list failures are non-fatal for the profile form
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    api<{ collections: CollectionItem[] }>("/api/me/collections")
      .then((r) => setCollections(r.collections))
      .catch(() => setCollections([]));
  }, []);

  // ------------------------------------------------------------ actions

  async function patchProfile(json: object, successMsg: string) {
    const res = await api<{ user: PublicMe }>("/api/me/profile", { method: "PATCH", json });
    setData((d) => (d ? { ...d, user: res.user } : d));
    await refresh(); // keep the shell avatar/name in sync
    toast.success(successMsg);
    return res.user;
  }

  async function saveProfile() {
    if (!name.trim()) {
      toast.error("Your name can't be empty.");
      return;
    }
    const url = websiteUrl.trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      toast.error("Website must be a full http(s) URL, e.g. https://example.com");
      return;
    }
    const email = contactEmail.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error("Contact email doesn't look valid — leave it empty or use a full address.");
      return;
    }
    setSavingProfile(true);
    try {
      await patchProfile(
        {
          name: name.trim(),
          headline: headline.trim(),
          bio: bio.trim(),
          location: location.trim(),
          availability: availability.trim(),
          experienceLevel: experienceLevel.trim() || null,
          contactEmail: contactEmail.trim() || null,
          websiteUrl: url || null,
          professions,
          skills,
        },
        "Profile saved"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save profile");
    } finally {
      setSavingProfile(false);
    }
  }

  /**
   * AI-assisted bio improvement (RIISHE improve endpoint). The suggestion is
   * inserted into the textarea for REVIEW — it is never saved until the user
   * presses "Save profile", and the server prompt forbids invented claims.
   */
  async function improveBioWithAi() {
    const draft = bio.trim();
    if (!draft) return;
    setBioAiBusy(true);
    try {
      const context = [
        headline.trim() ? `Headline: ${headline.trim()}` : "",
        professions.length ? `Professions: ${professions.join(", ")}` : "",
        skills.length ? `Skills: ${skills.join(", ")}` : "",
        location.trim() ? `Location: ${location.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const res = await api<{ text: string }>("/api/ai/improve", {
        method: "POST",
        json: { field: "bio", content: draft, ...(context ? { projectContext: context } : {}) },
      });
      setBio(res.text.slice(0, 2000));
      toast.success("Suggestion added below — review and edit it, then save your profile.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reach the AI assistant");
    } finally {
      setBioAiBusy(false);
    }
  }

  function toggleProfession(slug: string) {
    setProfessions((cur) => {
      if (cur.includes(slug)) return cur.filter((s) => s !== slug);
      if (cur.length >= 5) {
        toast.error("Pick up to 5 professions");
        return cur;
      }
      return [...cur, slug];
    });
  }

  async function onAvatarUploaded(m: MediaDTO) {
    try {
      await patchProfile({ avatarMediaId: m.id }, "Avatar updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set avatar");
    }
  }

  async function onCoverUploaded(m: MediaDTO) {
    try {
      await patchProfile({ coverMediaId: m.id }, "Cover updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set cover");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`"${deleteTarget.title}" deleted`);
      setDeleteTarget(null);
      await loadProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete project");
    } finally {
      setDeleting(false);
    }
  }

  // ------------------------------------------------------------ render guards

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <ProfileSkeleton />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={RefreshCw}
          title="Could not load your folio"
          description={error ?? "Something went wrong."}
          action={<Button onClick={() => void load()}>Try again</Button>}
        />
      </div>
    );
  }

  const u = data.user;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* ---------------- unified profile header (owner variant) */}
      <ProfileHeader
        variant="owner"
        profile={{
          name: u.name,
          username: u.username,
          headline: u.headline,
          location: u.location,
          availability: u.availability,
          professions: u.professions,
          skills: u.skills.map((slug) => allSkills.find((s) => s.slug === slug)?.label ?? slug),
          avatarUrl: u.avatarUrl,
          coverUrl: u.coverUrl,
          coverPositionY: u.coverPositionY,
          avatarFit: u.avatarFit,
          avatarZoom: u.avatarZoom,
          avatarPosX: u.avatarPosX,
          avatarPosY: u.avatarPosY,
        }}
        ownerControls={{
          onCoverUploaded: (m) => void onCoverUploaded(m),
          onAvatarUploaded: (m) => void onAvatarUploaded(m),
          onPatch: async (patch) => {
            await patchProfile(patch, "Saved");
          },
          onRemoveCover: () => {
            void patchProfile({ coverMediaId: null }, "Cover removed");
          },
          onRemoveAvatar: () => {
            void patchProfile({ avatarMediaId: null }, "Avatar removed");
          },
        }}
      />

      {/* ---------------- portfolio completion checklist (honest, data-derived) */}
      <CompletionChecklist
        profile={{
          id: u.id,
          username: u.username,
          name: u.name,
          headline: u.headline,
          bio: u.bio,
          avatarUrl: u.avatarUrl,
          coverUrl: u.coverUrl,
          professions: u.professions,
          skills: u.skills,
          profileVisibility: u.profileVisibility,
        }}
        publishedProjects={(projects ?? []).filter((p) => p.status === "PUBLISHED")}
      />

      {/* ---------------- stats */}
      <section className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Profile statistics">
        <StatCard label="Projects" value={data.stats.projects} />
        <StatCard label="Published" value={data.stats.published} />
        <StatCard label="Followers" value={data.stats.followers} />
        <StatCard label="Following" value={data.stats.following} />
        <StatCard label="Profile views" value={data.stats.profileViews} hint="estimated" />
      </section>

      {/* ---------------- edit form */}
      <section id="profile-editor" className="mt-6 rounded-xl border border-border/60 bg-card p-4 sm:p-6" aria-label="Edit profile">
        <Tabs defaultValue="profile">
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="work">Work</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="mt-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fp-name">Name</Label>
                <Input id="fp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-headline">Headline</Label>
                <Input
                  id="fp-headline"
                  value={headline}
                  maxLength={120}
                  placeholder="e.g. Architect & set designer"
                  onChange={(e) => setHeadline(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-location">Location</Label>
                <Input
                  id="fp-location"
                  value={location}
                  maxLength={100}
                  placeholder="e.g. Lisbon, Portugal"
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-availability">Availability</Label>
                <Input
                  id="fp-availability"
                  value={availability}
                  maxLength={80}
                  placeholder="e.g. Available for commissions"
                  onChange={(e) => setAvailability(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-experience">Experience level</Label>
                <Select value={experienceLevel} onValueChange={setExperienceLevel}>
                  <SelectTrigger id="fp-experience">
                    <SelectValue placeholder="Optional — how established you are" />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPERIENCE_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-email">Contact email</Label>
                <Input
                  id="fp-email"
                  type="email"
                  value={contactEmail}
                  placeholder="Shown on your public profile for inquiries"
                  onChange={(e) => setContactEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-website">Website</Label>
                <Input
                  id="fp-website"
                  type="url"
                  value={websiteUrl}
                  placeholder="https://your-site.com"
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor="fp-bio">Bio</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                    disabled={bioAiBusy || !bio.trim()}
                    onClick={() => void improveBioWithAi()}
                    title={bio.trim() ? "Get an AI-polished draft to review" : "Write a few words first — the AI refines your own draft"}
                  >
                    {bioAiBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
                    {bioAiBusy ? "Thinking…" : "Improve with AI"}
                  </Button>
                </div>
                <Textarea
                  id="fp-bio"
                  value={bio}
                  maxLength={2000}
                  placeholder="A short introduction — what you make, who you work with, what you're looking for."
                  className="min-h-28"
                  onChange={(e) => setBio(e.target.value)}
                />
                <p className="text-right text-xs text-muted-foreground">
                  {bio.length}/2000
                  {!bioAiBusy && bio.trim() && <span className="ml-2">AI suggestions land here for your review — nothing is saved until you press Save.</span>}
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="work" className="mt-5">
            <div className="space-y-6">
              <div className="space-y-1.5">
                <Label>Professions</Label>
                <p className="text-xs text-muted-foreground">Pick up to 5 — these power Discover recommendations.</p>
                <div className="flex flex-wrap gap-2">
                  {allProfessions.length === 0 && (
                    <div className="flex gap-2">
                      <Skeleton className="h-7 w-20 rounded-full" />
                      <Skeleton className="h-7 w-24 rounded-full" />
                      <Skeleton className="h-7 w-16 rounded-full" />
                    </div>
                  )}
                  {allProfessions.map((p) => {
                    const active = professions.includes(p.slug);
                    return (
                      <button
                        key={p.slug}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleProfession(p.slug)}
                        className={
                          active
                            ? "rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                            : "rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                        }
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fp-skills">Skills</Label>
                <TagInput
                  value={skills}
                  onChange={setSkills}
                  max={20}
                  placeholder="e.g. Rendering, Copywriting, Color grading…"
                  ariaLabel="Add skills"
                />
                <p className="text-xs text-muted-foreground">Press Enter or comma to add · max 20</p>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex justify-end border-t border-border/50 pt-4">
          <Button onClick={() => void saveProfile()} disabled={savingProfile}>
            {savingProfile ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </section>

      {/* ---------------- projects management */}
      <section className="mt-10" aria-label="Your projects">
        <SectionHeader
          title="Your projects"
          description="Everything you've created — drafts and published."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/studio")}>
              <LayoutGrid className="size-4" aria-hidden /> Manage in Studio
            </Button>
          }
        />

        <div className="mt-5">
          {projectsLoading && (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-xl border border-border/60 bg-card p-4">
                  <Skeleton className="h-[63px] w-28 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <Skeleton className="hidden h-8 w-24 sm:block" />
                </div>
              ))}
            </div>
          )}

          {!projectsLoading && projects !== null && projects.length === 0 && (
            <EmptyState
              icon={SquarePen}
              title="No projects yet"
              description="Start your first project in the studio — from brief to published piece."
              action={<Button onClick={() => navigate("/studio/new")}>New project</Button>}
            />
          )}

          {!projectsLoading && projects !== null && projects.length > 0 && (
            <div className="space-y-3">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/25 sm:flex-row sm:items-center"
                >
                  <button
                    type="button"
                    className="w-full shrink-0 sm:w-28"
                    onClick={() => navigate(`/p/${p.id}`)}
                    aria-label={`Open ${p.title}`}
                  >
                    <MediaThumb src={p.coverUrl} alt={p.title} aspect="aspect-[16/9]" className="rounded-lg sm:w-28" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => navigate(`/p/${p.id}`)}
                      className="line-clamp-1 text-left font-medium transition-colors hover:text-primary"
                    >
                      {p.title}
                    </button>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={p.status} />
                      <VisibilityBadge visibility={p.visibility} />
                      <span className="text-xs text-muted-foreground">{categoryLabel(p.category)}</span>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      <span>Updated {formatDate(p.updatedAt)}</span>
                      <span className="inline-flex items-center gap-1">
                        <Eye className="size-3" aria-hidden /> {p.counts.views} views (est.)
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
                    <Button variant="outline" size="sm" onClick={() => navigate(`/studio/${p.id}/edit`)}>
                      <Pencil className="size-3.5" aria-hidden /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${p.id}`)}>
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${p.title}`}
                      onClick={() => setDeleteTarget(p)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ---------------- collections */}
      <section className="mt-10" aria-label="Your collections">
        <SectionHeader
          title="Public collections"
          description="Curated sets of saved work on your profile."
          action={
            <Button variant="outline" size="sm" onClick={() => navigate("/collections")}>
              <FolderHeart className="size-4" aria-hidden /> Manage collections
            </Button>
          }
        />
        <div className="mt-5">
          {collections === null && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-28 rounded-xl" />
              ))}
            </div>
          )}
          {collections !== null && collections.length === 0 && (
            <EmptyState
              icon={FolderHeart}
              title="No collections yet"
              description="Group the work you save into named collections and share them from your profile."
              action={<Button variant="outline" onClick={() => navigate("/collections")}>Go to Saves & collections</Button>}
            />
          )}
          {collections !== null && collections.length > 0 && (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {collections.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => navigate("/collections")}
                    className="h-full w-full rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-primary/25"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-medium">{c.name}</p>
                      <Badge variant="secondary" className="rounded-full">
                        {c.items.length} {c.items.length === 1 ? "item" : "items"}
                      </Badge>
                    </div>
                    {c.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>}
                    <p className="mt-3 text-xs text-muted-foreground">{c.isPublic ? "Public" : "Private"} collection</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ---------------- delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the project and its media links. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete project"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
