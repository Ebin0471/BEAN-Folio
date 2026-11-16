"use client";

/**
 * App-level error boundary (M22 Phase 2 — HP-2).
 *
 * Catches uncaught render/data errors in the SPA shell and replaces the
 * default Next.js error screen with a branded, recoverable surface. The
 * error DETAILS are never rendered (they can carry internals) — they are
 * logged to the console as a single structured line so server-side log
 * shipping can pick them up alongside api.error events.
 */

import { useEffect } from "react";

export default function ErrorBoundaryPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Metadata-only console capture; the digest lets an operator correlate
    // this client report with the server-side log entry.
    console.error(
      JSON.stringify({
        event: "ui.render_error",
        digest: error.digest ?? null,
        message: error.message,
      })
    );
  }, [error]);

  return (
    <div
      role="alert"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error occurred while rendering this page. Your data is
        safe — retrying usually resolves transient issues.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-2 inline-flex h-11 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}
