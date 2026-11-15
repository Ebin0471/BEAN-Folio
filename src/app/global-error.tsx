"use client";

/**
 * Global error boundary (M22 Phase 2 — HP-2).
 *
 * Last-resort surface for errors thrown OUTSIDE the root layout (layout and
 * root-render failures). Must render its own <html>/<body>. Same policy as
 * error.tsx: never render internals; single structured console line for
 * log shipping.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        event: "ui.global_render_error",
        digest: error.digest ?? null,
        message: error.message,
      })
    );
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#fafafa",
          color: "#171717",
          textAlign: "center",
          padding: "1.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Something went wrong</h1>
        <p style={{ margin: 0, fontSize: "0.875rem", opacity: 0.7 }}>
          The application failed to start rendering. Please retry.
        </p>
        {error.digest ? (
          <p style={{ margin: 0, fontFamily: "monospace", fontSize: "0.75rem", opacity: 0.6 }}>
            ref: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: "0.5rem",
            padding: "0.6rem 1.5rem",
            minHeight: "44px",
            borderRadius: "6px",
            border: "none",
            background: "#171717",
            color: "#fff",
            fontSize: "0.875rem",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
