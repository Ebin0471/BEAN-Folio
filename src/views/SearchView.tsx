"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudOff, Hash, Loader2, Search } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/bean/EmptyState";
import { PersonCard } from "@/components/bean/PersonCard";
import { SectionHeader } from "@/components/bean/SectionHeader";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import type { HashtagPage, PublicPerson, SearchResults } from "@/lib/types";

/**
 * Unified search over REAL public data: people, posts and hashtags — plus
 * hashtag pages (#/hashtags/<tag>) with related-tag navigation. Only
 * publicly discoverable content is served by the APIs behind this view;
 * private posts and hidden accounts never appear. Signed-in users get their
 * private search history below (clearable — privacy control).
 */

export function SearchView({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState<SearchResults | null>(null);
  // Lazy init: a boot query starts in "loading" without a synchronous setState.
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "idle">(initialQuery.trim() ? "loading" : "idle");
  const [history, setHistory] = useState<{ query: string }[]>([]);

  const run = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setPhase("loading");
    api<SearchResults>(`/api/search/all?q=${encodeURIComponent(trimmed)}`)
      .then((r) => {
        setResults(r);
        setPhase("ready");
      })
      .catch(() => setPhase("error"));
  }, []);

  // Boot query + private search history — all state transitions in callbacks.
  useEffect(() => {
    const query = initialQuery.trim();
    api<{ items: { query: string }[] }>("/api/me/search-history")
      .then((r) => setHistory(r.items.slice(0, 8)))
      .catch(() => undefined);
    if (!query) return;
    api<SearchResults>(`/api/search/all?q=${encodeURIComponent(query)}`)
      .then((r) => {
        setResults(r);
        setPhase("ready");
      })
      .catch(() => setPhase("error"));
  }, [initialQuery]);

  async function clearHistory() {
    try {
      await api("/api/me/search-history", { method: "DELETE" });
      setHistory([]);
    } catch {
      // privacy control is best-effort in UI; server enforces ownership
    }
  }

  const empty = results && results.people.length === 0 && results.posts.length === 0 && results.hashtags.length === 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <SectionHeader title="Search" description="Find creators, posts and hashtags across the community." />

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/search/${encodeURIComponent(q.trim())}`);
          run(q);
        }}
        className="mt-6 flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Creators, posts, hashtags…" aria-label="Search" className="pl-9" maxLength={80} />
        </div>
        <Button type="submit" disabled={!q.trim()}>Search</Button>
      </form>

      {history.length > 0 && phase !== "ready" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Recent:</span>
          {history.map((h) => (
            <Button key={h.query} variant="secondary" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => { setQ(h.query); navigate(`/search/${encodeURIComponent(h.query)}`); run(h.query); }}>
              {h.query}
            </Button>
          ))}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void clearHistory()}>Clear history</Button>
        </div>
      ) : null}

      <div className="mt-8 space-y-10">
        {phase === "loading" ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : phase === "error" ? (
          <EmptyState icon={CloudOff} title="Search failed" description="Please try again in a moment." action={<Button variant="outline" onClick={() => run(q)}>Try again</Button>} />
        ) : phase === "idle" ? (
          <EmptyState icon={Search} title="Search BEAN Folio" description="Try a creator's name, a hashtag, or words from a post." />
        ) : empty ? (
          <EmptyState icon={Search} title={`No results for “${initialQuery}”`} description="Check the spelling or try a broader term — only public content is searchable." />
        ) : (
          <>
            {results?.hashtags.length ? (
              <section aria-label="Hashtag results">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Hashtags</h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {results.hashtags.map((h) => (
                    <Button key={h.name} variant="secondary" className="gap-1.5 rounded-full" onClick={() => navigate(`/hashtags/${h.name}`)}>
                      <Hash className="size-3.5 text-primary" aria-hidden /> {h.name}
                      <span className="text-xs text-muted-foreground">{h.postCount}</span>
                    </Button>
                  ))}
                </div>
              </section>
            ) : null}

            {results?.people.length ? (
              <section aria-label="People results">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">People</h2>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {results.people.map((p) => (
                    <PersonCard key={p.username} person={p} />
                  ))}
                </div>
              </section>
            ) : null}

            {results?.posts.length ? (
              <section aria-label="Post results">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Posts</h2>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {results.posts.map((p) => (
                    <a key={p.id} href={`#/post/${p.id}`} className="focus:outline-none">
                      <Card className="overflow-hidden transition-colors hover:border-primary/40">
                        <CardContent className="flex gap-3 p-4">
                          {p.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.thumbUrl} alt={p.body.slice(0, 80) || "Post media"} className="size-16 shrink-0 rounded-lg object-cover" />
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm text-foreground/90">{p.body || `(${p.mediaKind.toLowerCase()} post)`}</p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">{p.author.name}</p>
                            {p.hashtags.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {p.hashtags.slice(0, 3).map((t) => (
                                  <Badge key={t} variant="secondary" className="text-[10px] text-primary">#{t}</Badge>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A hashtag page: the real posts carrying the tag + related hashtags
 * (co-occurring tags computed server-side from matched posts).
 */
export function HashtagView({ tag }: { tag: string }) {
  const [data, setData] = useState<HashtagPage | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const { user } = useSession();

  // Initial fetch — state transitions only inside the fetch callbacks.
  useEffect(() => {
    api<HashtagPage>(`/api/hashtags/${encodeURIComponent(tag)}?limit=12`)
      .then((r) => {
        setData(r);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => setPhase("ready"));
  }, [tag]);

  function loadMore(nextCursor: string) {
    setLoadingMore(true);
    api<HashtagPage>(`/api/hashtags/${encodeURIComponent(tag)}?limit=12&cursor=${nextCursor}`)
      .then((r) => {
        setData((prev) => (prev ? { ...r, items: [...prev.items, ...r.items] } : r));
        setCursor(r.nextCursor);
      })
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }

  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <Skeleton className="h-24 rounded-xl" />
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || !data.tag) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <EmptyState
          icon={Hash}
          title={`#${tag}`}
          description="No public posts carry this hashtag yet."
          action={user ? <Button variant="outline" onClick={() => navigate("/")}>Explore the feed</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-4">
        <span className="flex size-14 items-center justify-center rounded-full bg-gold-soft text-primary" aria-hidden>
          <Hash className="size-6" />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold">#{data.tag.name}</h1>
          <p className="text-sm text-muted-foreground">{data.tag.postCount} public post{data.tag.postCount === 1 ? "" : "s"}</p>
        </div>
      </div>

      {data.related.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Related</span>
          {data.related.map((t) => (
            <Button key={t} variant="secondary" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => navigate(`/hashtags/${t}`)}>
              #{t}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {data.items.map((p) => (
          <a key={p.id} href={`#/post/${p.id}`} className="group focus:outline-none">
            <div className="overflow-hidden rounded-xl border border-border/60 transition-colors group-hover:border-primary/40">
              {p.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.thumbUrl} alt={p.body.slice(0, 80) || `Post by ${p.author.name}`} className="aspect-square w-full object-cover" />
              ) : (
                <div className="flex aspect-square items-center justify-center bg-secondary/30 p-4 text-xs text-muted-foreground">
                  {p.body.slice(0, 120) || "Text post"}
                </div>
              )}
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground">{p.author.name}</p>
          </a>
        ))}
      </div>

      {cursor ? (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={() => loadMore(cursor)} disabled={loadingMore} className="h-11 min-w-44">
            {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
