"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkX,
  Eye,
  FolderHeart,
  FolderPlus,
  Lock,
  Plus,
  Search,
  ServerCrash,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";
import { SectionHeader } from "@/components/bean/SectionHeader";

import { api, ApiError, formatCompact } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import type { Paginated, ProjectCardDTO } from "@/lib/types";

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

interface CollectionDTO {
  id: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  items: ProjectCardDTO[];
}

// ------------------------------------------------------------------ saved projects

function SavedProjects() {
  const [projects, setProjects] = useState<ProjectCardDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ projects: ProjectCardDTO[] }>("/api/me/saves");
      setProjects(res.projects);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unsave = async (projectId: string) => {
    setRemovingId(projectId);
    try {
      await api(`/api/projects/${projectId}/save`, { method: "DELETE" });
      setProjects((prev) => (prev ? prev.filter((p) => p.id !== projectId) : prev));
      toast.success("Removed from your saves");
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={ServerCrash}
        title="Couldn't load your saves"
        description={error}
        action={<Button variant="outline" onClick={() => void load()}>Try again</Button>}
      />
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <EmptyState
        icon={Bookmark}
        title="Nothing saved yet"
        description="Tap the bookmark on any project to keep it here for later."
        action={<Button variant="outline" onClick={() => navigate("/explore")}>Explore projects</Button>}
      />
    );
  }

  return (
    <ul className="space-y-3" aria-label="Saved projects">
      {projects.map((p) => (
        <li
          key={p.id}
          className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 transition-colors hover:border-primary/25 sm:gap-4 sm:p-4"
        >
          <a href={`#/p/${p.id}`} className="shrink-0" aria-label={`Open ${p.title}`}>
            <MediaThumb src={p.coverUrl} alt={p.title} aspect="aspect-[4/3]" className="w-16 rounded-lg sm:w-20" />
          </a>
          <div className="min-w-0 flex-1">
            <a
              href={`#/p/${p.id}`}
              className="block truncate text-sm font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
            >
              {p.title}
            </a>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              by {p.owner.name} ·{" "}
              <span className="inline-flex items-center gap-1">
                <Eye className="size-3" aria-hidden /> {formatCompact(p.counts.views)}
              </span>{" "}
              ·{" "}
              <span className="inline-flex items-center gap-1">
                <Bookmark className="size-3" aria-hidden /> {formatCompact(p.counts.saves)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" className="hidden sm:inline-flex" asChild>
              <a href={`#/p/${p.id}`}>View</a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={removingId === p.id}
              onClick={() => void unsave(p.id)}
              aria-label={`Remove ${p.title} from saves`}
            >
              <BookmarkX className="size-4" aria-hidden />
              <span className="hidden sm:inline">{removingId === p.id ? "Removing…" : "Remove"}</span>
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ add-projects dialog

function AddProjectsDialog({
  collection,
  onOpenChange,
  onAdded,
}: {
  collection: CollectionDTO | null;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectCardDTO[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIds = new Set((collection?.items ?? []).map((i) => i.id));

  // Debounced live search while the dialog is open.
  useEffect(() => {
    if (!collection) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api<Paginated<ProjectCardDTO>>(
          `/api/search/projects?q=${encodeURIComponent(query.trim())}`
        );
        setResults(res.items);
      } catch (e) {
        toast.error(errText(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, collection]);

  // Reset local search state whenever the target collection changes.
  useEffect(() => {
    setQuery("");
    setResults(null);
  }, [collection?.id]);

  const add = async (projectId: string) => {
    if (!collection) return;
    setBusyId(projectId);
    try {
      await api(`/api/collections/${collection.id}/items`, { method: "POST", json: { projectId } });
      toast.success("Added to collection");
      onAdded();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={Boolean(collection)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Add projects to “{collection?.name}”</DialogTitle>
          <DialogDescription>
            Search published projects and add them. {collection?.items.length ?? 0} already in this collection.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects by title, summary or skill…"
            className="h-11 pl-9"
            aria-label="Search projects"
          />
        </div>

        <div className="max-h-80 min-h-40 overflow-y-auto pr-1" aria-busy={searching}>
          {searching ? (
            <div className="space-y-2 py-1">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </div>
          ) : (results ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {results === null ? "Searching…" : "No published projects match that search."}
            </p>
          ) : (
            <ul className="space-y-2 py-1" aria-label="Search results">
              {results!.map((p) => {
                const inCollection = memberIds.has(p.id);
                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 p-2.5"
                  >
                    <MediaThumb src={p.coverUrl} alt={p.title} aspect="aspect-square" className="w-10 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <a
                        href={`#/p/${p.id}`}
                        className="block truncate text-sm font-medium text-foreground hover:text-primary"
                      >
                        {p.title}
                      </a>
                      <p className="truncate text-xs text-muted-foreground">by {p.owner.name}</p>
                    </div>
                    <Button
                      variant={inCollection ? "secondary" : "outline"}
                      size="sm"
                      disabled={inCollection || busyId === p.id}
                      onClick={() => void add(p.id)}
                    >
                      {inCollection ? "Added" : busyId === p.id ? "Adding…" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ collection card

function CollectionCard({
  collection,
  onEditItems,
  onChanged,
}: {
  collection: CollectionDTO;
  onEditItems: (c: CollectionDTO) => void;
  onChanged: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const removeItem = async (projectId: string) => {
    setBusyKey(projectId);
    try {
      await api(`/api/collections/${collection.id}/items?projectId=${encodeURIComponent(projectId)}`, {
        method: "DELETE",
      });
      toast.success("Removed from collection");
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteCollection = async () => {
    setBusyKey("__delete");
    try {
      await api(`/api/collections/${collection.id}`, { method: "DELETE" });
      toast.success(`Collection “${collection.name}” deleted`);
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card>
      <CardContent className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-lg font-semibold text-foreground">{collection.name}</h3>
              {collection.isPublic ? (
                <Badge variant="outline" className="rounded-full text-[11px] font-normal">
                  Public
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1 rounded-full text-[11px] font-normal">
                  <Lock className="size-3" aria-hidden /> Private
                </Badge>
              )}
            </div>
            {collection.description && (
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">{collection.description}</p>
            )}
          </div>
          <p className="shrink-0 text-xs text-muted-foreground">
            {collection.items.length} {collection.items.length === 1 ? "project" : "projects"}
          </p>
        </div>

        {collection.items.length > 0 ? (
          <div className="mt-4 max-h-96 overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-2">
              {collection.items.map((item) => (
                <span
                  key={item.id}
                  className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-background/40 py-1 pl-2.5 pr-1.5 text-xs"
                >
                  <a
                    href={`#/p/${item.id}`}
                    className="max-w-44 truncate text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
                  >
                    {item.title}
                  </a>
                  <button
                    type="button"
                    disabled={busyKey === item.id}
                    onClick={() => void removeItem(item.id)}
                    aria-label={`Remove ${item.title} from ${collection.name}`}
                    className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
            Empty collection — add projects to curate it.
          </p>
        )}

        <div className="mt-5 flex items-center justify-between gap-2 border-t border-border/50 pt-4">
          <Button variant="outline" size="sm" onClick={() => onEditItems(collection)}>
            <FolderPlus className="size-4" aria-hidden /> Add projects
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={busyKey === "__delete"}
              >
                <Trash2 className="size-4" aria-hidden /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="font-display">Delete “{collection.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the collection and its curation. Projects themselves are not affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/40"
                  onClick={(e) => {
                    e.preventDefault();
                    void deleteCollection();
                  }}
                >
                  Delete collection
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ collections section

function CollectionsSection() {
  const [collections, setCollections] = useState<CollectionDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [creating, setCreating] = useState(false);

  const [dialogCollectionId, setDialogCollectionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ collections: CollectionDTO[] }>("/api/me/collections");
      setCollections(res.collections);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await api("/api/me/collections", {
        method: "POST",
        json: { name: name.trim(), description: description.trim() || undefined, isPublic },
      });
      toast.success(`Collection “${name.trim()}” created`);
      setName("");
      setDescription("");
      setIsPublic(false);
      await load();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={ServerCrash}
        title="Couldn't load collections"
        description={error}
        action={<Button variant="outline" onClick={() => void load()}>Try again</Button>}
      />
    );
  }

  // Derived from the freshest fetched collections so the dialog's member set stays accurate after refetches.
  const dialogCollection = dialogCollectionId
    ? collections?.find((c) => c.id === dialogCollectionId) ?? null
    : null;

  return (
    <div className="space-y-6">
      {/* Create form */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <h3 className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
            <Plus className="size-4 text-primary" aria-hidden /> New collection
          </h3>
          <form className="mt-4 space-y-4" onSubmit={create}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="collection-name">Name</Label>
                <Input
                  id="collection-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="e.g. Brutalist references"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="collection-description">Description (optional)</Label>
                <Input
                  id="collection-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={300}
                  placeholder="What ties these projects together?"
                />
              </div>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <Switch id="collection-public" checked={isPublic} onCheckedChange={setIsPublic} />
                <Label htmlFor="collection-public" className="text-sm font-normal text-muted-foreground">
                  {isPublic ? "Public — visible on your profile" : "Private — only you can see it"}
                </Label>
              </div>
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create collection"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Collection list */}
      {(!collections || collections.length === 0) ? (
        <EmptyState
          icon={FolderHeart}
          title="No collections yet"
          description="Group saved work into curated sets — moodboards, references, or “hire me” case studies. Create your first one above."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {collections!.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              onEditItems={(col) => setDialogCollectionId(col.id)}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}

      <AddProjectsDialog
        collection={dialogCollection}
        onOpenChange={(open) => {
          if (!open) setDialogCollectionId(null);
        }}
        onAdded={() => void load()}
      />
    </div>
  );
}

// ------------------------------------------------------------------ view

export default function CollectionsView() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <SectionHeader
        title="Saves & collections"
        description="Projects you've bookmarked and the curated sets you've built."
        className="mb-6"
      />

      <Tabs defaultValue="saved">
        <TabsList className="h-auto w-full flex-wrap sm:w-fit">
          <TabsTrigger value="saved" className="px-4">
            Saved projects
          </TabsTrigger>
          <TabsTrigger value="collections" className="px-4">
            Collections
          </TabsTrigger>
        </TabsList>
        <TabsContent value="saved" className="mt-4">
          <SavedProjects />
        </TabsContent>
        <TabsContent value="collections" className="mt-4">
          <CollectionsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
