"use client";

import { useEffect, useMemo, useState } from "react";
import { ThemeProvider } from "next-themes";
import {
  BarChart3,
  Bell,
  Bookmark,
  Bot,
  Compass,
  FolderHeart,
  LayoutGrid,
  Lock,
  LogOut,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  TerminalSquare,
  UserRound,
  Users,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";

import { Wordmark } from "@/components/bean/Wordmark";
import { EmptyState } from "@/components/bean/EmptyState";
import { useHashRoute, navigate, isPublicRoute, storeReturnTo, BootRouteProvider } from "@/lib/hash-router";
import { setStandaloneSite, useStandaloneSite } from "@/lib/standalone-site";
import { SessionProvider, useSession } from "@/lib/session";
import { api, formatCompact } from "@/lib/client";
import { applySeo, SEO_DEFAULTS } from "@/lib/seo";
import type { NotificationDTO } from "@/lib/types";
import { cn } from "@/lib/utils";

import AuthView from "@/views/AuthView";
import OnboardingView from "@/views/OnboardingView";
import DiscoverView from "@/views/DiscoverView";
import MessagesView from "@/views/MessagesView";
import { SearchView, HashtagView } from "@/views/SearchView";
import ExploreView from "@/views/ExploreView";
import StudioView from "@/views/StudioView";
import ProjectEditorView from "@/views/ProjectEditorView";
import ProjectDetailView from "@/views/ProjectDetailView";
import PostDetailView from "@/views/PostDetailView";
import FolioView from "@/views/FolioView";
import PublicProfileView from "@/views/PublicProfileView";
import PublishedSiteView from "@/views/PublishedSiteView";
import SiteGiftzSiteView from "@/views/SiteGiftzSiteView";
import SiteProjectDetailView from "@/views/SiteProjectDetailView";
import IntelligenceView from "@/views/IntelligenceView";
import ConnectView from "@/views/ConnectView";
import InsightsView from "@/views/InsightsView";
import SettingsView from "@/views/SettingsView";
import CollectionsView from "@/views/CollectionsView";
import StaticView from "@/views/StaticView";
import ModerationView from "@/views/ModerationView";
import WebsiteBuilderView from "@/views/WebsiteBuilderView";
import LaxiiView from "@/views/LaxiiView";

// ---------------------------------------------------------------- nav config

const NAV = [
  { href: "/", label: "Discover", icon: Compass },
  { href: "/explore", label: "Explore", icon: Search },
  { href: "/studio", label: "Studio", icon: SquarePen },
  { href: "/intelligence", label: "RIISHE", icon: Bot },
  { href: "/laxii", label: "LAXII", icon: Sparkles },
  { href: "/giftz", label: "GIFTZ", icon: TerminalSquare },
  { href: "/connect", label: "Connect", icon: Users },
] as const;

const MOBILE_NAV: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; primary?: boolean }[] = [
  { href: "/", label: "Discover", icon: Compass },
  { href: "/explore", label: "Explore", icon: Search },
  { href: "/studio", label: "Studio", icon: SquarePen },
  { href: "/intelligence", label: "RIISHE", icon: Bot },
  { href: "/laxii", label: "LAXII", icon: Sparkles, primary: true },
  { href: "/giftz", label: "GIFTZ", icon: TerminalSquare },
  { href: "/connect", label: "Connect", icon: Users },
];

// ---------------------------------------------------------------- helpers

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  onClick,
  className,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <a
      href={`#${href}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors lg:px-3",
        active ? "bg-gold-soft font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        className
      )}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </a>
  );
}

function NotificationsBell() {
  const { user } = useSession();
  const { segments } = useHashRouteSafe();
  const routeKey = segments.join("/");
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    // Re-fetch on session change, on route change (e.g. returning from
    // Connect after marking read), and when views broadcast a read event.
    api<{ unreadCount: number }>("/api/me/notifications")
      .then((r) => alive && setUnread(r.unreadCount))
      .catch(() => undefined);
    const onUnreadChanged = () => {
      api<{ unreadCount: number }>("/api/me/notifications")
        .then((r) => alive && setUnread(r.unreadCount))
        .catch(() => undefined);
    };
    window.addEventListener("bean:unread-changed", onUnreadChanged);
    return () => {
      alive = false;
      window.removeEventListener("bean:unread-changed", onUnreadChanged);
    };
  }, [user, routeKey]);

  if (!user) return null;
  return (
    <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} onClick={() => navigate("/connect")}>
      <Bell className="size-4" aria-hidden />
      {unread !== null && unread > 0 && (
        <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Button>
  );
}

function UserMenu() {
  const { user, logout } = useSession();
  if (!user) {
    // Single authentication CTA — "Sign in" led to the same /auth page.
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => navigate("/auth")}>
          Join BEAN Folio
        </Button>
      </div>
    );
  }
  const initials = user.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Account menu">
        <Avatar className="size-8 ring-1 ring-border transition hover:ring-primary/50">
          <AvatarImage src={user.avatarUrl ?? undefined} alt={`${user.name}'s avatar`} />
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">
            {user.username ? `@${user.username}` : user.email}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user.username && (
          <DropdownMenuItem onClick={() => navigate(`/u/${user.username}`)}>
            <UserRound className="size-4" aria-hidden /> View public profile
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => navigate("/folio")}>
          <LayoutGrid className="size-4" aria-hidden /> My Folio
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/studio")}>
          <SquarePen className="size-4" aria-hidden /> Create Studio
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/collections")}>
          <FolderHeart className="size-4" aria-hidden /> Saves & collections
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/insights")}>
          <BarChart3 className="size-4" aria-hidden /> Insights
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings className="size-4" aria-hidden /> Trust & settings
        </DropdownMenuItem>
        {user.role === "ADMIN" && (
          <DropdownMenuItem onClick={() => navigate("/moderation")}>
            <ShieldCheck className="size-4" aria-hidden /> Moderation review
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={async () => {
            try {
              await logout(); // server must confirm revocation before we navigate
              toast.success("Signed out");
              navigate("/");
            } catch {
              // Session stays intact — do not fake a signed-out state.
              toast.error("Could not sign out. Check your connection and try again.");
            }
          }}
        >
          <LogOut className="size-4" aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Header() {
  const { segments } = useHashRouteSafe();
  const active = (href: string) => {
    const target = href === "/" ? [] : href.slice(1).split("/");
    const cur = segments;
    if (href === "/") return cur.length === 0;
    return cur.length > 0 && cur[0] === target[0];
  };
  return (
    <header className="glass-surface sticky top-0 z-40 border-b border-border/70">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-4 lg:gap-6">
          <Wordmark />
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <NavItem key={item.href} {...item} active={active(item.href)} />
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1.5">
          <NotificationsBell />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function MobileNav() {
  const { segments } = useHashRouteSafe();
  const active = (href: string) => {
    const target = href === "/" ? [] : href.slice(1).split("/");
    return href === "/" ? segments.length === 0 : segments[0] === target[0];
  };
  return (
    <nav
      aria-label="Primary mobile"
      className="glass-surface fixed inset-x-0 bottom-0 z-40 border-t border-border/70 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-7">
        {MOBILE_NAV.map((item) => (
          <a
            key={item.href}
            href={`#${item.href}`}
            aria-current={active(item.href) ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 py-2.5 text-[10px] transition-colors",
              active(item.href) ? "text-primary" : "text-muted-foreground"
            )}
          >
            <span className={cn("grid size-9 place-items-center rounded-full", item.primary && "bg-primary text-primary-foreground")}>
              <item.icon className={cn("size-4", item.primary && "text-primary-foreground")} aria-hidden />
            </span>
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="mt-auto border-t border-border/70 pb-20 pt-8 md:pb-8" style={{ marginBottom: 0 }}>
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 text-sm text-muted-foreground sm:flex-row sm:px-6">
        <div className="flex items-center gap-3">
          <Wordmark compact />
          <span className="text-xs">Show your work. Find your people.</span>
        </div>
        <nav aria-label="Footer" className="flex items-center gap-4 text-xs">
          <a href="#/explore" className="transition-colors hover:text-foreground">Explore</a>
          <a href="#/privacy" className="transition-colors hover:text-foreground">Privacy</a>
          <a href="#/terms" className="transition-colors hover:text-foreground">Terms</a>
          <span className="text-muted-foreground/60">© {new Date().getFullYear()} BEAN Folio</span>
        </nav>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------- routing

function useHashRouteSafe() {
  const { segments } = useHashRoute();
  return { segments };
}

/**
 * Route-level document metadata (titles, canonicals, robots directives).
 * Private workspace routes are marked noindex at the shell level so they can
 * never be indexed; public routes get indexable defaults which data-driven
 * views (profile, project) refine once their real content has loaded.
 * JSON-LD structured data is applied per-view where the content qualifies.
 */
const PRIVATE_ROUTE_LABELS: Record<string, string> = {
  auth: "Sign in or join",
  onboarding: "Set up your folio",
  folio: "My Folio",
  studio: "Studio",
  intelligence: "RIISHE",
  laxii: "LAXII", // M20 audit fix: was missing — tab showed "Page not found"
  giftz: "GIFTZ",
  website: "GIFTZ", // legacy #/website — redirects to #/giftz
  connect: "Connect",
  messages: "Messages", // M20 audit fix: was missing — tab showed "Page not found"
  insights: "Insights",
  settings: "Trust & settings",
  collections: "Saves & collections",
  moderation: "Moderation review",
};

function RouteSeo() {
  const { segments } = useHashRouteSafe();
  const segKey = segments.join("/");

  useEffect(() => {
    const root = segments[0] ?? "";
    if (segments.length === 0) {
      applySeo({ title: SEO_DEFAULTS.title, description: SEO_DEFAULTS.description, path: "/", jsonLd: null });
      return;
    }
    if (root in PRIVATE_ROUTE_LABELS) {
      applySeo({
        title: `${PRIVATE_ROUTE_LABELS[root]} — BEAN Folio`,
        description: "Your private BEAN Folio workspace — this page is not indexed.",
        noindex: true,
        jsonLd: null,
      });
      return;
    }
    if (root === "explore") {
      applySeo({
        title: "Explore work — BEAN Folio",
        description: "Search published projects across every craft on BEAN Folio.",
        path: "/explore",
        jsonLd: null,
      });
      return;
    }
    if (root === "search") {
      // M20 audit fix: search is a PUBLIC route over public data — it fell
      // into the unknown-route branch ("Page not found" + noindex) before.
      applySeo({
        title: "Search — BEAN Folio",
        description: "Search people, projects and posts across BEAN Folio.",
        path: "/search",
        jsonLd: null,
      });
      return;
    }
    if (root === "hashtags") {
      // Public hashtag page — the view refines the title with the real tag
      // once its content loads, same pattern as profile/project routes.
      applySeo({
        title: "Hashtag — BEAN Folio",
        description: "Posts tagged with this hashtag on BEAN Folio.",
        jsonLd: null,
      });
      return;
    }
    if (root === "p" || root === "u" || root === "site") {
      // Refined by ProjectDetailView / PublicProfileView / PublishedSiteView
      // once real data loads.
      applySeo({
        title: root === "p" ? "Project — BEAN Folio" : root === "site" ? "Website — BEAN Folio" : "Profile — BEAN Folio",
        description: SEO_DEFAULTS.description,
        jsonLd: null,
      });
      return;
    }
    if (root === "privacy" || root === "terms") {
      applySeo({
        title: root === "privacy" ? "Privacy — BEAN Folio" : "Terms — BEAN Folio",
        description:
          root === "privacy"
            ? "How BEAN Folio handles your data, visibility and rights."
            : "The terms that govern using BEAN Folio.",
        path: `/${root}`,
        jsonLd: null,
      });
      return;
    }
    // Unknown route — honest not-found behavior, never indexed.
    applySeo({
      title: "Page not found — BEAN Folio",
      description: "That address doesn't match anything on BEAN Folio.",
      noindex: true,
      jsonLd: null,
    });
  }, [segKey]);

  return null;
}

function RequireAuth({ children, label }: { children: React.ReactNode; label: string }) {
  const { user, loading, error, refresh } = useSession();
  const { segments } = useHashRouteSafe();
  if (loading) {
    return (
      <div className="grid min-h-[50vh] place-items-center">
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }
  if (!user) {
    // A failed session check is NOT proof of being signed out — offer a retry
    // instead of the sign-in gate so a transient error can't fake a logout.
    if (error) {
      return (
        <div className="mx-auto max-w-xl px-4 py-16">
          <EmptyState
            icon={Lock}
            title="We couldn't verify your session"
            description="A connection problem interrupted the session check. Retry before signing in again."
            action={
              <Button variant="outline" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <EmptyState
          icon={Lock}
          title="Sign in to continue"
          description={`${label} is part of your private workspace. Create a free account or sign in to access it.`}
          action={
            <Button
              onClick={() => {
                // Preserve the intended destination across the auth round-trip.
                storeReturnTo("/" + segments.join("/"));
                navigate("/auth");
              }}
            >
              Sign in or join
            </Button>
          }
        />
      </div>
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="That address doesn't match anything on BEAN Folio."
        action={<Button onClick={() => navigate("/")}>Back to Discover</Button>}
      />
    </div>
  );
}

/**
 * Guides not-yet-onboarded accounts into profile setup WITHOUT hijacking
 * public pages: Discover, Explore, project and profile pages stay freely
 * browsable; only protected workspace routes lead into onboarding, and the
 * intended destination is preserved for after setup.
 */
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const { segments } = useHashRouteSafe();
  const route = "/" + segments.join("/");
  const publicRoute = isPublicRoute(segments);

  useEffect(() => {
    if (!loading && user && !user.onboarded && !publicRoute && route !== "/onboarding") {
      storeReturnTo(route);
      navigate("/onboarding", true);
    }
  }, [loading, user, route, publicRoute]);

  return <>{children}</>;
}

/**
 * Legacy URLs (#/website, #/giftz/website) — CODE GIFTZ is ONE workspace now:
 * the website-building chat is its primary (and only) interface at #/giftz.
 * Render an honest redirect rather than a broken route; a replace() keeps
 * history clean.
 */
function LegacyRouteRedirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, true);
  }, [to]);
  return null;
}

function Router() {
  const { segments } = useHashRouteSafe();
  const [a, b, c, d] = segments;
  const segKey = segments.join("/");

  const view = useMemo(() => {
    if (segments.length === 0) return <DiscoverView />;
    switch (a) {
      case "explore":
        return <ExploreView />;
      case "auth":
        return <AuthView />;
      case "onboarding":
        return <OnboardingView />;
      case "folio":
        return (
          <RequireAuth label="My Folio">
            <FolioView />
          </RequireAuth>
        );
      case "studio":
        if (!b) return <RequireAuth label="Create Studio"><StudioView /></RequireAuth>;
        if (b === "new") return <RequireAuth label="Create Studio"><ProjectEditorView /></RequireAuth>;
        if (c === "edit") return <RequireAuth label="Create Studio"><ProjectEditorView projectId={b} /></RequireAuth>;
        return <NotFound />;
      case "p":
        return b ? <ProjectDetailView projectId={b} /> : <NotFound />;
      case "post":
        // Public creator social-feed post (Discover) — same path-form deep
        // link mechanism as /u/ and /p/ (see src/proxy.ts).
        return b ? <PostDetailView postId={b} /> : <NotFound />;
      case "u":
        // The BEAN Folio public PROFILE — always the platform profile
        // experience, for every account, published website or not.
        return b ? <PublicProfileView username={decodeURIComponent(b)} /> : <NotFound />;
      case "site":
        // The standalone published WEBSITE — the creator's own custom site at
        // its own address. Fully independent of the profile above: the two
        // routes never render each other's experience (see lib/site-url).
        //
        // /site/<username>                  → the website homepage
        // /site/<username>/projects/<id>    → the WEBSITE-NATIVE project detail
        //   page: same site design system, platform chrome suppressed, NEVER a
        //   redirect into the platform's /p/<id> experience. Only this exact
        //   deep shape is a website route; anything else under /site/<user>/
        //   is honestly not-found.
        // /site/<username>/g/<siteId>       → a PUBLISHED GIFTZ generated site
        //   (GiftzSite) — an independent prompt-built website artifact, fully
        //   separate from the portfolio website above.
        if (!b) return <NotFound />;
        if (c === "projects") {
          return d ? (
            <SiteProjectDetailView username={decodeURIComponent(b)} projectId={decodeURIComponent(d)} />
          ) : (
            <NotFound />
          );
        }
        if (c === "g") {
          return d ? (
            <SiteGiftzSiteView username={decodeURIComponent(b)} siteId={decodeURIComponent(d)} />
          ) : (
            <NotFound />
          );
        }
        if (c) return <NotFound />;
        return <PublishedSiteView username={decodeURIComponent(b)} />;
      case "intelligence":
        return <RequireAuth label="RIISHE"><IntelligenceView /></RequireAuth>;
      case "laxii":
        return <RequireAuth label="LAXII"><LaxiiView /></RequireAuth>;
      case "giftz":
        // CODE GIFTZ — one workspace. The website-building chat is the
        // primary interface; the old Engineering dashboard was removed and
        // every legacy giftz URL folds into #/giftz.
        if (b === "website") {
          return <LegacyRouteRedirect to="/giftz" />;
        }
        return <RequireAuth label="GIFTZ"><WebsiteBuilderView /></RequireAuth>;
      case "website":
        // Legacy standalone URL — kept as an honest redirect so no old link
        // breaks; the capability now lives inside the CODE GIFTZ workspace.
        return <LegacyRouteRedirect to="/giftz" />;
      case "connect":
        return <RequireAuth label="Connect"><ConnectView /></RequireAuth>;
      case "messages":
        // Direct messages (Phase 3 social) — one-to-one threads with
        // message requests; authorization enforced server-side per read.
        if (!b) return <RequireAuth label="Messages"><MessagesView /></RequireAuth>;
        return <RequireAuth label="Messages"><MessagesView /></RequireAuth>;
      case "search":
        // Unified search (people / posts / hashtags) over public data only.
        return <SearchView initialQuery={b ? decodeURIComponent(b) : ""} />;
      case "hashtags":
        // Real hashtag pages — public posts carrying the tag.
        return b ? <HashtagView tag={decodeURIComponent(b)} /> : <NotFound />;
      case "insights":
        return <RequireAuth label="Insights"><InsightsView /></RequireAuth>;
      case "settings":
        return <RequireAuth label="Trust & settings"><SettingsView /></RequireAuth>;
      case "collections":
        return <RequireAuth label="Saves & collections"><CollectionsView /></RequireAuth>;
      case "privacy":
        return <StaticView page="privacy" />;
      case "terms":
        return <StaticView page="terms" />;
      case "moderation":
        return <ModerationView />;
      default:
        return <NotFound />;
    }
  }, [a, b, c, d, segKey]);

  return view;
}

// ---------------------------------------------------------------- root

/**
 * SiteShell — the client application shell, mounted by src/app/page.tsx.
 *
 * A PUBLISHED custom website lives at its OWN route (/site/<username>) and
 * renders as the creator's independent website: the BEAN Folio platform
 * chrome — header nav, account buttons, footer, mobile tab bar — is removed
 * so the visitor sees ONLY the creator's site. The public profile route
 * (/u/<username>) ALWAYS keeps the normal application shell — it is the BEAN
 * Folio profile experience and never turns into the website.
 *
 * Whether the /site/<username> route currently shows a published website is
 * decided by PublishedSiteView (it owns that data) via lib/standalone-site:
 *   pending → chrome hidden while the website resolves,
 *   yes     → chrome stays hidden for the standalone site,
 *   no      → normal shell (unpublished / not-found). Leaving the site route
 * always restores the shell.
 *
 * `bootRoute` carries the route the SERVER seeded for this document (from the
 * proxy's x-bean-boot-route header — a direct visit to /u/<username> or
 * /site/<username>). It is provided to the router so the SSR HTML and the
 * hydration snapshot both render the seeded route — a published website never
 * paints the Discover feed, not even briefly.
 */
export default function SiteShell({ bootRoute }: { bootRoute: string | null }) {
  return (
    <BootRouteProvider value={bootRoute}>
      <Shell />
    </BootRouteProvider>
  );
}

function Shell() {
  const { segments } = useHashRouteSafe();
  const segKey = segments.join("/");
  const standalone = useStandaloneSite();

  // Leaving the standalone website route always restores the platform shell.
  // The site view (re)asserts pending/yes itself when it mounts or resolves —
  // child effects run before this parent effect, so its signal always wins on
  // a live site route. The profile route (/u/<username>) is a normal shelled
  // page: chrome is never suppressed there.
  useEffect(() => {
    if (!(segments[0] === "site" && Boolean(segments[1]))) setStandaloneSite("no");
  }, [segKey]);

  // Only /site/<username> routes can ever be standalone websites; the
  // standalone store decides whether the website there is published.
  const standaloneSite = segments[0] === "site" && Boolean(segments[1]) && standalone !== "no";

  return (
    <ThemeProvider defaultTheme="dark" enableSystem={false} attribute="class" disableTransitionOnChange>
      <SessionProvider>
        <OnboardingGate>
          <div className="flex min-h-screen flex-col">
            <RouteSeo />
            {standaloneSite ? null : <Header />}
            <main className={standaloneSite ? "flex flex-1 flex-col" : "flex-1"}>
              <Router />
            </main>
            {standaloneSite ? null : (
              <>
                <Footer />
                <MobileNav />
              </>
            )}
          </div>
        </OnboardingGate>
      </SessionProvider>
    </ThemeProvider>
  );
}
