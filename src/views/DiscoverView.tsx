"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CloudOff, Compass, Film, Flame, Hash, Inbox, Loader2, PenLine, Search, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PersonCard } from "@/components/bean/PersonCard";
import { PostCard, recordPostView } from "@/components/bean/PostCard";
import { VideoCard } from "@/components/bean/VideoCard";
import { PostComposer } from "@/components/bean/PostComposer";
import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import type { FeedMode, FeedResponse, PublicPost, SearchResults, SuggestedCreator } from "@/lib/types";

/**
 * The Discover homepage: the creator social feed.
 *
 * Section order (owner spec): navigation (global shell, unchanged) → hero →
 * Suggested Profiles → Reels & Video feed → Recent creator posts → more
 * creators to explore. Project cards no longer appear here — project
 * discovery stays on its existing surfaces (/explore, profiles, /p/ deep
 * links, published websites), none of which are modified.
 *
 * Every section paginates progressively (offset cursors) and renders honest
 * empty states. All content comes from real database-backed endpoints — no
 * mock profiles, no mock posts, no placeholder media.
 */

const SUGGESTED_PAGE = 8;
const POSTS_PAGE = 10;

export default function DiscoverView() {
  const { user } = useSession();
  const [composerOpen, setComposerOpen] = useState(false);

  const startCta = (
    <Button onClick={() => navigate(user ? "/studio" : "/auth")} className="h-11">
      Start your portfolio
    </Button>
  );

  return (
    <>
      {/* ---------------------------------------------------------- hero (unchanged) */}
      <motion.section
        aria-label="Welcome"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="border-b border-border/60"
      >
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 md:py-10">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-primary">A portfolio platform for every profession</p>
          <div className="mt-3 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="max-w-2xl">
              <h1 className="text-balance font-display text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl md:text-[2.75rem]">
                Show your work. <span className="italic text-primary">Find your people.</span>
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Showcase your skills, experience, projects, and achievements in one professional portfolio — whatever your profession.
              </p>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Build your own personalized website with{" "}
                <span className="font-medium text-foreground">GIFTZ</span>, powered by BEAN Intelligence × BEAN Folio.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {startCta}
              <Button variant="outline" onClick={() => navigate("/explore")} className="h-11">
                <Compass className="size-4" aria-hidden /> Explore work
              </Button>
            </div>
          </div>
        </div>
      </motion.section>

      {/* ---------------------------------------------------------- create post */}
      <section aria-label="Create a post" className="py-6 md:py-7">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 sm:px-6">
          {user ? (
            <Button onClick={() => setComposerOpen(true)} className="h-11 gap-2">
              <PenLine className="size-4" aria-hidden /> Create post
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sign in to post updates, reels and photos — and to follow the creators you find here.
            </p>
          )}
        </div>
      </section>

      <SuggestedProfiles />
      <TrendingHashtags />
      <VideoFeed onCompose={() => setComposerOpen(true)} />
      <CreatorFeed onCompose={() => setComposerOpen(true)} />
      <MoreCreators />

      {user ? (
        <PostComposer
          open={composerOpen}
          onOpenChange={setComposerOpen}
          onCreated={() => {
            // A fresh post is prepended by RecentPosts itself on the next
            // load-more cycle; nudge it with a custom event to refresh now.
            window.dispatchEvent(new CustomEvent("bean:post-created"));
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- profiles

function SuggestedProfiles() {
  const [items, setItems] = useState<SuggestedCreator[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const reqRef = useRef(0);

  const load = useCallback((nextCursor: string | null, append: boolean) => {
    const id = ++reqRef.current;
    if (append) setLoadingMore(true);
    else setPhase("loading");
    const params = new URLSearchParams({ limit: String(SUGGESTED_PAGE) });
    if (nextCursor) params.set("cursor", nextCursor);
    api<{ items: SuggestedCreator[]; nextCursor: string | null }>(`/api/discover/suggested?${params}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  // Initial page fetch — state updates happen only after the await (never
  // synchronously inside the effect).
  useEffect(() => {
    const id = ++reqRef.current;
    api<{ items: SuggestedCreator[]; nextCursor: string | null }>(`/api/discover/suggested?limit=${SUGGESTED_PAGE}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  return (
    <section aria-label="Suggested profiles" className="border-b border-border/60 py-8 md:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeader
          title="Suggested profiles"
          description="Creators matched by profession, skills, location and community activity."
        />
        <div className="mt-6">
          {phase === "loading" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : phase === "error" ? (
            <EmptyState
              icon={CloudOff}
              title="Suggestions could not load"
              description="Please try again in a moment."
              action={
                <Button variant="outline" onClick={() => load(null, false)}>
                  Try again
                </Button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No creator suggestions yet"
              description="As creators publish work and posts, their profiles will appear here."
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {items.map((p) => (
                  <div key={p.username} className="flex flex-col gap-2">
                    <PersonCard person={p} />
                    {p.reason ? <p className="px-1 text-xs text-muted-foreground">{p.reason}</p> : null}
                  </div>
                ))}
              </div>
              {cursor ? (
                <div className="mt-6 flex justify-center">
                  <Button variant="outline" onClick={() => void load(cursor, true)} disabled={loadingMore} className="h-11 min-w-44">
                    {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
                    {loadingMore ? "Loading…" : "More suggested creators"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- video feed

function VideoFeed({ onCompose }: { onCompose: () => void }) {
  const { user } = useSession();
  const [items, setItems] = useState<PublicPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const reqRef = useRef(0);

  const load = useCallback((nextCursor: string | null, append: boolean) => {
    const id = ++reqRef.current;
    if (append) setLoadingMore(true);
    else setPhase("loading");
    const params = new URLSearchParams({ kind: "video", limit: String(POSTS_PAGE) });
    if (nextCursor) params.set("cursor", nextCursor);
    api<{ items: PublicPost[]; nextCursor: string | null }>(`/api/discover/posts?${params}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  // Initial page fetch — state updates happen only after the await.
  useEffect(() => {
    const id = ++reqRef.current;
    api<{ items: PublicPost[]; nextCursor: string | null }>(`/api/discover/posts?kind=video&limit=${POSTS_PAGE}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  // Register a deduped view (server: one per viewer per UTC day) for reels
  // that actually render in the feed.
  useEffect(() => {
    for (const p of items) recordPostView(p.id);
  }, [items]);

  function patch(next: PublicPost) {
    setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  }

  return (
    <section aria-label="Reels and video feed" className="border-b border-border/60 py-8 md:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeader
          title="Reels & video"
          description="Short reels, showreels, tutorials and behind-the-scenes work from the community."
          action={
            <Button variant="outline" onClick={onCompose} className="gap-2">
              <Film className="size-4" aria-hidden /> Post a reel
            </Button>
          }
        />
        <div className="mt-6">
          {phase === "loading" ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[9/16] rounded-xl" />
              ))}
            </div>
          ) : phase === "error" ? (
            <EmptyState
              icon={CloudOff}
              title="The video feed could not load"
              description="Please try again in a moment."
              action={
                <Button variant="outline" onClick={() => load(null, false)}>
                  Try again
                </Button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Film}
              title="No reels yet — be the first"
              description="Share an editing showreel, a motion piece, a tutorial or behind-the-scenes footage with Create post → Video."
              action={
                user ? undefined : (
                  <Button onClick={() => navigate("/auth")}>Sign in to post</Button>
                )
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {items.map((p) => (
                  <VideoCard key={p.id} post={p} onChange={patch} />
                ))}
              </div>
              {cursor ? (
                <div className="mt-6 flex justify-center">
                  <Button variant="outline" onClick={() => void load(cursor, true)} disabled={loadingMore} className="h-11 min-w-44">
                    {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {loadingMore ? "Loading…" : "More reels"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- search

/** Unified search entry — navigates to the /search view. */
function SearchBar() {
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const query = q.trim();
        if (query) navigate(`/search/${encodeURIComponent(query)}`);
      }}
      className="flex w-full max-w-md items-center gap-2"
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search creators, posts, hashtags…"
          aria-label="Search creators, posts and hashtags"
          className="pl-9"
          maxLength={80}
        />
      </div>
      <Button type="submit" variant="outline" disabled={!q.trim()} aria-label="Run search">
        Search
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- hashtags

/** Trending hashtags — real usage counts from the Hashtag dictionary. */
function TrendingHashtags() {
  const [items, setItems] = useState<{ name: string; postCount: number }[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ items: { name: string; postCount: number }[] }>("/api/hashtags/trending")
      .then((r) => alive && setItems(r.items))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <section aria-label="Trending hashtags" className="border-b border-border/60 py-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 sm:px-6">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Flame className="size-3.5 text-primary" aria-hidden /> Trending
        </span>
        {items.slice(0, 10).map((h) => (
          <Button
            key={h.name}
            variant="secondary"
            size="sm"
            className="h-7 gap-1 rounded-full px-3 text-xs"
            onClick={() => navigate(`/hashtags/${h.name}`)}
            aria-label={`${h.postCount} posts tagged #${h.name}`}
          >
            <Hash className="size-3 text-primary" aria-hidden /> {h.name}
            <span className="text-muted-foreground">{h.postCount}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- posts feed

type FeedTab = "recent" | FeedMode;

const FEED_TABS: { id: FeedTab; label: string; hint: string }[] = [
  { id: "recent", label: "Recent", hint: "All public creator posts, newest first" },
  { id: "foryou", label: "For You", hint: "Ranked for you from real signals — profession, engagement, freshness" },
  { id: "following", label: "Following", hint: "Posts from creators you follow" },
  { id: "trending", label: "Trending", hint: "Fast-rising engagement over the last 72 hours" },
];

function CreatorFeed({ onCompose }: { onCompose: () => void }) {
  const { user } = useSession();
  const [tab, setTab] = useState<FeedTab>("recent");

  return (
    <section aria-label="Creator posts feed" className="border-b border-border/60 py-8 md:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeader
          title="Creator posts"
          description="Updates, questions, insights and work-in-progress from creators you can follow."
          action={
            user ? (
              <Button variant="outline" onClick={onCompose} className="gap-2">
                <PenLine className="size-4" aria-hidden /> Create post
              </Button>
            ) : null
          }
        />
        <div className="mt-2"><SearchBar /></div>

        {/* feed mode tabs */}
        <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Feed mode">
          {FEED_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              title={t.hint}
              onClick={() => setTab(t.id)}
              className={
                tab === t.id
                  ? "rounded-full border border-primary/60 bg-gold-soft px-4 py-1.5 text-sm font-medium text-foreground"
                  : "rounded-full border border-border/60 px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{FEED_TABS.find((t) => t.id === tab)?.hint}</p>

        {/* Keyed by mode: a tab switch remounts the list with a fresh
            "loading" phase — no synchronous setState in effects needed. */}
        <FeedBody key={tab} mode={tab} signedIn={Boolean(user)} />
      </div>
    </section>
  );
}

function FeedBody({ mode, signedIn }: { mode: FeedTab; signedIn: boolean }) {
  const [items, setItems] = useState<PublicPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [exclude, setExclude] = useState<string[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const reqRef = useRef(0);

  const fetchPage = useCallback(
    (nextCursor: string | null, seenIds: string[]) => {
      const params = new URLSearchParams({ limit: String(POSTS_PAGE) });
      if (nextCursor) params.set("cursor", nextCursor);
      if (seenIds.length > 0) params.set("exclude", seenIds.slice(-50).join(","));
      const url =
        mode === "recent"
          ? `/api/discover/posts?${params}`
          : `/api/feed?${new URLSearchParams({ mode, ...Object.fromEntries(params) })}`;
      return api<{ items: PublicPost[]; nextCursor: string | null }>(url);
    },
    [mode]
  );

  // Initial fetch — every state transition happens inside the fetch callbacks.
  useEffect(() => {
    const id = ++reqRef.current;
    fetchPage(null, [])
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setExclude([]);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, [fetchPage]);

  // A just-created post appears at the top of the Recent feed — refresh on
  // the composer's post-created event.
  useEffect(() => {
    const refresh = () => {
      const id = ++reqRef.current;
      fetchPage(null, [])
        .then((r) => {
          if (reqRef.current !== id) return;
          setItems(r.items);
          setCursor(r.nextCursor);
          setPhase("ready");
        })
        .catch(() => undefined);
    };
    window.addEventListener("bean:post-created", refresh);
    return () => window.removeEventListener("bean:post-created", refresh);
  }, [fetchPage]);

  // Deduped view registration for rendered posts.
  useEffect(() => {
    for (const p of items) recordPostView(p.id);
  }, [items]);

  function loadMore() {
    if (loadingMore || !cursor) return;
    const id = ++reqRef.current;
    setLoadingMore(true);
    const seen = [...new Set([...exclude, ...items.map((i) => i.id)])];
    fetchPage(cursor, seen)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems((prev) => [...prev, ...r.items]);
        setCursor(r.nextCursor);
        setExclude(seen);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }

  function patch(next: PublicPost) {
    setItems((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
  }

  function hideFromFeed(id: string) {
    setItems((prev) => prev.filter((p) => p.id !== id));
    setExclude((prev) => [...prev, id]);
  }

  const emptyCopy: Record<FeedTab, { title: string; description: string }> = {
    recent: {
      title: "No posts yet — start the conversation",
      description: "Share a professional update, a question or your latest work with the community.",
    },
    foryou: {
      title: "Nothing to recommend yet",
      description: "Follow creators and engage with posts — For You learns from real activity, never from guesses.",
    },
    following: {
      title: signedIn ? "Your Following feed is quiet" : "Sign in to see who you follow",
      description: signedIn
        ? "Posts from creators you follow appear here, newest first. Discover people in Suggested profiles above."
        : "Follow the creators you find here and their posts will appear in this feed.",
    },
    trending: {
      title: "Nothing is trending right now",
      description: "Posts with fast-rising engagement surface here as the community reacts.",
    },
  };

  return (
    <div className="mt-6">
      {phase === "loading" ? (
        <div className="mx-auto max-w-2xl space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      ) : phase === "error" ? (
        <EmptyState
          icon={CloudOff}
          title="Posts could not load"
          description="Please try again in a moment."
          action={
            <Button
              variant="outline"
              onClick={() => {
                const id = ++reqRef.current;
                setPhase("loading");
                fetchPage(null, [])
                  .then((r) => {
                    if (reqRef.current !== id) return;
                    setItems(r.items);
                    setCursor(r.nextCursor);
                    setPhase("ready");
                  })
                  .catch(() => setPhase("error"));
              }}
            >
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={emptyCopy[mode].title}
          description={emptyCopy[mode].description}
          action={null}
        />
      ) : (
        <>
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {items.map((p) => (
              <PostCard
                key={p.id}
                post={p}
                onChange={patch}
                onDelete={remove}
                onHidden={hideFromFeed}
              />
            ))}
          </div>
          {cursor ? (
            <div className="mt-6 flex justify-center">
              <Button variant="outline" onClick={loadMore} disabled={loadingMore} className="h-11 min-w-44">
                {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {loadingMore ? "Loading…" : "Load more posts"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- more creators

function MoreCreators() {
  const [items, setItems] = useState<SuggestedCreator[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const reqRef = useRef(0);

  const load = useCallback((nextCursor: string | null, append: boolean) => {
    const id = ++reqRef.current;
    if (append) setLoadingMore(true);
    else setPhase("loading");
    const params = new URLSearchParams({ limit: String(SUGGESTED_PAGE) });
    if (nextCursor) params.set("cursor", nextCursor);
    api<{ items: SuggestedCreator[]; nextCursor: string | null }>(`/api/discover/suggested?${params}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems((prev) => (append ? [...prev, ...r.items] : r.items));
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  // This section shows the CONTINUATION of the suggestion ranking — it starts
  // at page 2 so it never repeats the Suggested Profiles grid above it.
  useEffect(() => {
    const id = ++reqRef.current;
    api<{ items: SuggestedCreator[]; nextCursor: string | null }>(`/api/discover/suggested?limit=${SUGGESTED_PAGE}&cursor=${SUGGESTED_PAGE}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch(() => {
        if (reqRef.current !== id) return;
        setPhase("error");
      });
  }, []);

  if (phase === "ready" && items.length === 0) return null;

  return (
    <section aria-label="More creators to explore" className="py-8 md:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeader title="More creators to explore" description="Keep discovering — every profile here is a real BEAN Folio creator." />
        <div className="mt-6">
          {phase === "loading" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
          ) : phase === "error" ? (
            <p className="text-sm text-muted-foreground">More suggestions could not be loaded right now.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {items.map((p) => (
                  <div key={p.username} className="flex flex-col gap-2">
                    <PersonCard person={p} />
                    {p.reason ? <p className="px-1 text-xs text-muted-foreground">{p.reason}</p> : null}
                  </div>
                ))}
              </div>
              {cursor ? (
                <div className="mt-6 flex justify-center">
                  <Button variant="outline" onClick={() => void load(cursor, true)} disabled={loadingMore} className="h-11 min-w-44">
                    {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {loadingMore ? "Loading…" : "More creators"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
