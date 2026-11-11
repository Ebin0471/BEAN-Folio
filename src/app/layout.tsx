import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { configuredHttpsOrigin } from "@/lib/seo-origin";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["SOFT", "WONK"],
});

/**
 * Root metadata. metadataBase prefers a verified production origin
 * (NEXT_PUBLIC_APP_URL when it is a valid HTTPS public URL — see
 * lib/seo-origin) and falls back to the current request-header derivation so
 * metadata resolves on every serving host (sandbox/preview included).
 * Per-route metadata (titles, canonicals, robots, JSON-LD) is applied
 * client-side by src/lib/seo.ts because the whole SPA is hash-routed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return {
    metadataBase: new URL(configuredHttpsOrigin() ?? `${proto}://${host}`),
    title: "BEAN Folio — Show your work. Find your people.",
    description:
      "The professional portfolio platform for every profession. Showcase your work, experience, skills and achievements — and connect with the people behind it.",
    keywords: [
      "portfolio",
      "creative network",
      "projects",
      "discovery",
      "professionals",
      "BEAN Folio",
    ],
    authors: [{ name: "BEAN Folio" }],
    robots: { index: true, follow: true },
    alternates: { canonical: "/" },
    icons: {
      icon: "/brand/bean-folio-logo.png",
    },
    openGraph: {
      title: "BEAN Folio",
      description: "Show your work. Find your people.",
      siteName: "BEAN Folio",
      type: "website",
      images: [{ url: "/brand/bean-folio-logo.png", width: 1536, height: 1024, alt: "BEAN Folio" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "BEAN Folio",
      description: "Show your work. Find your people.",
      images: ["/brand/bean-folio-logo.png"],
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#090A0C",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased bg-background text-foreground`}
      >
        {/* Dark mode is the only appearance. The theme toggle was removed, so
            this script only guarantees `dark` on <html> (and clears any stale
            persisted light preference) — it never enables a light theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{localStorage.removeItem('bean-theme')}catch(e){}document.documentElement.classList.add('dark');document.documentElement.classList.remove('light')`,
          }}
        />
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
