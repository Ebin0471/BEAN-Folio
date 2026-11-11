/**
 * Platform-default SEO metadata — SERVER-SAFE (no "use client").
 *
 * Lives in its own module so both the server document metadata
 * (src/app/page.tsx generateMetadata) and the client SEO manager (lib/seo)
 * read the exact same constants without crossing the client-component
 * boundary.
 */
export const SEO_DEFAULTS = {
  title: "BEAN Folio — Show your work. Find your people.",
  description:
    "The professional portfolio platform for every profession. Showcase your work, experience, skills and achievements — and connect with the people behind it.",
  siteName: "BEAN Folio",
};
