"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CloudOff, Compass, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ProjectCard, categoryFromLabel } from "@/components/bean/ProjectCard";
import { CategoryScroller } from "@/components/bean/CategoryScroller";
import { EmptyState } from "@/components/bean/EmptyState";
import { CardsSkeleton } from "@/components/bean/Spinner";
import { api } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { useProfessionOptions } from "@/lib/use-professions";
import { useSession } from "@/lib/session";
import type { DiscoverItem } from "@/lib/types";

type Category = string | null; // null = All

const PAGE_SIZE = 12;

export default function DiscoverView() {
  const { user } = useSession();

  const [category, setCategory] = useState<Category>(null);
  const [items, setItems] = useState<DiscoverItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Live taxonomy (Profession table) — canonical categories for the chips.
  const professionOptions = useProfessionOptions();

  // Request id guards against stale responses when the category changes quickly.
  const reqRef = useRef(0);

  const loadInitial = useCallback((cat: Category) => {
    const id = ++reqRef.current;
    setPhase("loading");
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cat) params.set("category", cat);
    api<{ items: DiscoverItem[]; nextCursor: string | null }>(`/api/discover?${params.toString()}`)
      .then((r) => {
        if (reqRef.current !== id) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setPhase("ready");
      })
      .catch((err) => {
        if (reqRef.current !== id) return;
        setError(err instanceof Error ? err.message : "Could not load the feed.");
        setPhase("error");
      });
  }, []);

  useEffect(() => {
    loadInitial(category);
  }, [category, loadInitial]);

  async function loadMore() {
    if (!cursor || loadingMore || phase !== "ready") return;
    setLoadingMore(true);
    const id = reqRef.current;
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (category) params.set("category", category);
      params.set("cursor", cursor);
      const r = await api<{ items: DiscoverItem[]; nextCursor: string | null }>(`/api/discover?${params.toString()}`);
      if (reqRef.current !== id) return;
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load more projects.");
    } finally {
      setLoadingMore(false);
    }
  }

  const categoryOptions = ["All", ...professionOptions.map((p) => p.label)];
  const activeLabel = category ? professionOptions.find((p) => p.slug === category)?.label ?? category : "All";
  const isEmptyFeed = phase === "ready" && items.length === 0;
  const startCta = (
    <Button onClick={() => navigate(user ? "/studio" : "/auth")} className="h-11">
      Start your portfolio
    </Button>
  );

  return (
    <>
      {/* ---------------------------------------------------------- hero */}
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

      {/* ---------------------------------------------------------- feed */}
      <section aria-label="Discover feed" className="py-8 md:py-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <h2 className="font-display text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            {category ? `${activeLabel} on BEAN Folio` : "Fresh from the community"}
          </h2>

          {/* category filter chips — single accessible horizontal row */}
          <div className="mt-4">
            <CategoryScroller
              options={categoryOptions}
              activeLabel={activeLabel}
              onSelect={(label) => setCategory(label === "All" ? null : categoryFromLabel(label, professionOptions))}
            />
          </div>

          <div className="mt-6">
            {phase === "loading" ? (
              <CardsSkeleton count={8} />
            ) : phase === "error" ? (
              <EmptyState
                icon={CloudOff}
                title="The feed could not load"
                description={error ?? "Something went wrong on our side."}
                action={
                  <Button variant="outline" onClick={() => loadInitial(category)}>
                    Try again
                  </Button>
                }
              />
            ) : isEmptyFeed ? (
              category ? (
                <EmptyState
                  icon={Inbox}
                  title={`Nothing in ${activeLabel} yet`}
                  description="Try another category — or be the first to publish work here."
                  action={startCta}
                />
              ) : (
                <EmptyState
                  icon={Inbox}
                  title="No projects yet — be the first to publish."
                  description="Your first case study could be live in minutes. The community is waiting."
                  action={startCta}
                />
              )
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
                  Showing {items.length} {items.length === 1 ? "project" : "projects"}
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {items.map((item) => (
                    <ProjectCard key={item.project.id} project={item.project} reason={item.reason} />
                  ))}
                </div>
                {cursor && (
                  <div className="mt-8 flex justify-center">
                    <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore} className="h-11 min-w-44">
                      {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                      {loadingMore ? "Loading…" : "Load more projects"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
