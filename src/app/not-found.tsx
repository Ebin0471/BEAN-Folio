/**
 * App-level 404 surface (M22 Phase 2 — HP-2).
 *
 * The SPA shell (SiteShell) already renders an in-app NotFound view for
 * unknown hash routes; this boundary covers direct document requests that
 * miss both the SPA and the proxy rewrites (/u/, /p/, /site/, /post/).
 * noindex by default (Next serves it with a 404 status; explicit robots
 * meta keeps crawlers honest).
 */

import Link from "next/link";

export default function NotFound() {
  return (
    <div
      role="main"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The page you requested does not exist or may have been moved.
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex h-11 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Go home
      </Link>
    </div>
  );
}
