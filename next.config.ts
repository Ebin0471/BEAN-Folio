import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the Turbopack/workspace root to this project directory. Next 16
  // infers the root from lockfiles and a stray /home/z/package-lock.json
  // (a prisma stub outside this repo) makes it resolve 'tailwindcss' from
  // /home/z — breaking the dev Tailwind CSS pipeline ("Can't resolve
  // 'tailwindcss' in '/home/z'" in dev.log) and potentially the CSS step of
  // the standalone production build.
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
  // pdf-parse (resume upload text extraction) must stay a runtime require:
  // bundling it breaks pdfjs-dist's dynamic pdf.worker.mjs resolution
  // ("Setting up fake worker failed" under Turbopack).
  serverExternalPackages: ["pdf-parse"],

  // BUILD type-check scope: `next build` type-checks via tsconfig.build.json
  // (src only — tests are excluded). Rationale (GZ-SCALE, measured): including
  // tests/** in the build worker pushed the type-check past 4 GB on modest
  // hosts and the worker was SIGKILLed (reproducible 3/3 here). The full
  // repository INCLUDING tests is still type-checked by `bunx tsc --noEmit`
  // (tsconfig.json) as an independent gate — CI runs it on every push, and
  // TypeScript errors still fail this build for ALL application code.
  typescript: { tsconfigPath: "./tsconfig.build.json" },
  // TypeScript errors still fail the production build. Keep `bunx tsc
  // --noEmit` (full tsconfig.json, tests included) clean whenever application
  // code changes.
  reactStrictMode: false,
  // Don't advertise the framework/runtime version (X-Powered-By header).
  poweredByHeader: false,
  async headers() {
    // Phase 6 hardening. Deliberately NO X-Frame-Options / CSP
    // frame-ancestors: the Website Studio renders live site previews in a
    // SAME-ORIGIN iframe (#/website), and frame-blocking headers would break
    // that existing UI (rationale + residual risk in docs/SECURITY_NOTES.md).
    // A full CSP is deferred (Tier C follow-up): the app relies on inline
    // styles (studio canvas, Next.js style injection) and an SPA surface;
    // a rushed policy risks breaking the product without meaningfully
    // improving the posture.
    const securityHeaders: { key: string; value: string }[] = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // Disable powerful features the product never uses.
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
      // Popup opener isolation (auth popups / OAuth windows stay compatible;
      // strict same-origin would break window.opener flows).
      { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    ];
    // HSTS only for production builds — dev runs plain HTTP and must not be
    // pinned. No `preload` on purpose: rolling it back is slow and this
    // deployment may run on non-apex/self-hosted domains.
    if (process.env.NODE_ENV === "production") {
      securityHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=15552000; includeSubDomains",
      });
    }
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      // P3 — the edge-cache policy for the public-shell document (/u/*, /p/*)
      // lives in src/proxy.ts: a force-dynamic document sets its own
      // `no-store` Cache-Control, and proxy response headers are the only
      // layer applied AFTER the route's. See proxy.ts for the safety rationale.
    ];
  },
};

export default nextConfig;
