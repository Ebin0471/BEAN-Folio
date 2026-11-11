"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ImageOff, Mail, Send } from "lucide-react";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/client";
import { navigate } from "@/lib/hash-router";
import { setStandaloneSite } from "@/lib/standalone-site";
import { useSeo } from "@/lib/seo";
import { useSession } from "@/lib/session";
import { publicSitePath, seoOrigin } from "@/lib/site-url";
import type { PublicProfileResponse } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/bean/EmptyState";
import { SiteRenderer } from "@/components/bean/site/SiteRenderer";
import { BANNER_ASPECT_CLASS } from "@/lib/banner";
import { cn } from "@/lib/utils";

const INQUIRY_TYPES = [
  { value: "INQUIRY", label: "General inquiry" },
  { value: "COLLABORATION", label: "Collaboration proposal" },
  { value: "INVITE", label: "Invitation / opportunity" },
] as const;

function SiteSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading website" className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
      <Skeleton className={cn("w-full rounded-xl", BANNER_ASPECT_CLASS)} />
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * PublishedSiteView — the standalone custom WEBSITE route (`/site/<username>`).
 *
 * This route is the published website's own address and renders ONLY the
 * creator's website (the published snapshot from SiteDesign) with the
 * platform chrome suppressed — never the BEAN Folio profile. The profile
 * remains an independent page at `/u/<username>` (PublicProfileView); the two
 * never render each other's content (see lib/site-url).
 *
 * Data comes from the same public profile endpoint (GET /api/profiles/:username)
 * so the existing server-side visibility ladder applies unchanged: PRIVATE or
 * deleted profiles resolve to not-found for visitors, and only the PUBLISHED
 * snapshot (never the draft) is exposed. When no published website exists the
 * route shows an honest not-available state and restores the platform shell
 * (standalone → "no") so the visitor is never stranded.
 */
export default function PublishedSiteView({ username }: { username: string }) {
  const { user } = useSession();

  const [data, setData] = useState<PublicProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // contact dialog (signed-in visitors — anonymous visitors get mailto)
  const [contactOpen, setContactOpen] = useState(false);
  const [inqType, setInqType] = useState<string>("INQUIRY");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await api<PublicProfileResponse>(`/api/profiles/${encodeURIComponent(username)}`);
      setData(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : "Could not load this website");
    } finally {
      setLoading(false);
    }
  }, [username]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------- standalone website shell
  // While this website route resolves, platform chrome is hidden ("pending").
  // It stays hidden only while a published website is actually rendered;
  // not-found, unpublished and error states restore the normal BEAN Folio
  // shell. Unmounting this view always restores the shell.
  useEffect(() => {
    setStandaloneSite("pending");
    return () => setStandaloneSite("no");
  }, [username]);

  const sitePublished = Boolean(data?.site.status === "PUBLISHED" && data?.site.config);

  useEffect(() => {
    if (loading) return; // "pending" stays until the website resolves
    setStandaloneSite(sitePublished ? "yes" : "no");
  }, [loading, sitePublished]);

  // ------------------------------------------------------------- SEO
  // The website's own metadata: the site's display name + creator, with no
  // platform suffix, canonicalized to the website's OWN address
  // (/site/<username> — never the profile address). Structured data describes
  // a WebSite authored by the creator — not a ProfilePage.
  const seoInput = useMemo(() => {
    if (loading) return null; // shell default stays in place while loading
    if (notFound) {
      return {
        title: "Website not found — BEAN Folio",
        description: "This website doesn't exist or isn't published.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    if (error || !data) {
      return {
        title: "Website unavailable — BEAN Folio",
        description: "The website could not be loaded.",
        noindex: true,
        jsonLd: null,
      } as const;
    }
    const { profile } = data;
    const config = data.site.config;
    const siteName = config?.name ?? `${profile.name}'s website`;
    // Honest description from the website's own hero subtitle when present,
    // otherwise the creator's profile text — never invented content.
    const hero = config?.pages?.[0]?.sections?.find((s) => s.type === "hero");
    const heroSubtitle = hero && hero.type === "hero" ? hero.subtitle.trim() : "";
    const description =
      heroSubtitle || profile.bio?.trim() || profile.headline || `A website by ${profile.name}.`;
    const origin = seoOrigin();
    const sitePath = publicSitePath(username) ?? `/site/${username}`;
    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: siteName,
      ...(origin ? { url: `${origin}${sitePath}` } : {}),
      author: {
        "@type": "Person",
        name: profile.name,
        ...(profile.username ? { alternateName: `@${profile.username}` } : {}),
        ...(profile.headline ? { jobTitle: profile.headline } : {}),
        ...(profile.bio ? { description: profile.bio } : {}),
        ...(origin && profile.avatarUrl ? { image: `${origin}${profile.avatarUrl}` } : {}),
        ...(origin ? { url: `${origin}/u/${profile.username ?? username}` } : {}),
      },
    };
    return {
      title: `${siteName} — ${profile.name}`,
      description: description.slice(0, 300),
      path: sitePath,
      type: "website" as const,
      image: profile.avatarUrl,
      jsonLd,
    };
  }, [data, loading, notFound, error, username]);
  useSeo(seoInput);

  function openContact() {
    if (!user) {
      toast.error("Sign in to send an inquiry", {
        action: { label: "Sign in", onClick: () => navigate("/auth") },
      });
      return;
    }
    setSubject("");
    setMessage("");
    setInqType("INQUIRY");
    setContactOpen(true);
  }

  async function sendInquiry() {
    if (!subject.trim() || !message.trim()) {
      toast.error("Add a subject and a message first.");
      return;
    }
    setSending(true);
    try {
      await api("/api/inquiries", {
        method: "POST",
        json: {
          recipientUsername: username,
          type: inqType,
          subject: subject.trim(),
          message: message.trim(),
        },
      });
      toast.success("Inquiry sent — it will appear in their Connect inbox.");
      setContactOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast.error("Sign in to send an inquiry", {
          action: { label: "Sign in", onClick: () => navigate("/auth") },
        });
      } else {
        toast.error(e instanceof Error ? e.message : "Could not send inquiry");
      }
    } finally {
      setSending(false);
    }
  }

  // ------------------------------------------------------------ render guards

  if (loading) {
    // Standalone shell already hides chrome ("pending") — render the site's
    // own loading skeleton, never the platform feed.
    return <SiteSkeleton />;
  }

  if (notFound || error || !data || !sitePublished) {
    // Honest not-available state. Standalone is "no" here, so the platform
    // shell (header/footer) is back and the visitor can navigate away.
    return (
      <div className="mx-auto max-w-xl px-4 py-20 sm:px-6">
        <EmptyState
          icon={ImageOff}
          title={notFound ? "This website doesn't exist." : "This website isn't published right now."}
          description={
            notFound
              ? "The address may be mistyped, or the creator's profile is private."
              : error ?? "The creator has unpublished this website. Check back later."
          }
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
              <Button onClick={() => navigate("/")}>Explore BEAN Folio</Button>
            </div>
          }
        />
      </div>
    );
  }

  const { profile, projects, collections, site } = data;
  const config = site.config!;
  const siteProfile = {
    name: profile.name,
    username: profile.username,
    headline: profile.headline,
    location: profile.location,
    bio: profile.bio,
    availability: profile.availability ?? null,
    avatarUrl: profile.avatarUrl,
    coverUrl: profile.coverUrl,
    coverPositionY: profile.coverPositionY,
    professions: profile.professions,
    skills: profile.skills,
    websiteUrl: profile.websiteUrl,
    contactEmail: profile.contactEmail,
    stats: {
      followers: profile.stats.followers,
      following: profile.stats.following,
      projects: profile.stats.projects,
    },
  };
  const contactDialog = (
    <Dialog open={contactOpen} onOpenChange={setContactOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Contact {profile.name}</DialogTitle>
          <DialogDescription>Your message goes to their Connect inbox. Be specific and kind.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="site-inq-type">Type</Label>
            <Select value={inqType} onValueChange={setInqType}>
              <SelectTrigger id="site-inq-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INQUIRY_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-inq-subject">Subject</Label>
            <Input
              id="site-inq-subject"
              value={subject}
              maxLength={140}
              placeholder="e.g. Exhibition opportunity this autumn"
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-inq-message">Message</Label>
            <Textarea
              id="site-inq-message"
              value={message}
              maxLength={2000}
              placeholder="Introduce yourself and what you have in mind…"
              className={cn("min-h-28")}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p className="text-right text-xs text-muted-foreground">{message.length}/2000</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setContactOpen(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void sendInquiry()} disabled={sending || !subject.trim() || !message.trim()}>
            <Send className="size-4" aria-hidden /> {sending ? "Sending…" : "Send inquiry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <>
      <SiteRenderer
        config={config}
        profile={siteProfile}
        projects={projects}
        collections={collections}
        watermark={site.watermark}
        onContact={user ? openContact : undefined}
        contactHref={!user && profile.contactEmail ? `mailto:${profile.contactEmail}` : null}
      />
      {contactDialog}
    </>
  );
}
