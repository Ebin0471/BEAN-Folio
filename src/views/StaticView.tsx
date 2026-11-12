"use client";

import { ShieldCheck, ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

import { navigate } from "@/lib/hash-router";

// ------------------------------------------------------------------ shared layout

function DocShell({
  title,
  intro,
  icon: Icon,
  children,
}: {
  title: string;
  intro: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Badge variant="secondary" className="mb-5 rounded-full text-xs font-normal text-muted-foreground">
        Beta draft — review before production launch
      </Badge>

      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-gold-soft text-primary ring-1 ring-primary/30">
          <Icon className="size-5" aria-hidden />
        </div>
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{intro}</p>
        </div>
      </div>

      <Separator className="my-8" />

      <div className="space-y-10">{children}</div>

      <div className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-6 text-xs text-muted-foreground">
        <span>BEAN Folio · Show your work. Find your people.</span>
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          Back to Discover
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ privacy page

function PrivacyDoc() {
  return (
    <DocShell
      title="Privacy Policy"
      intro="A plain-language account of what BEAN Folio collects, what stays private, and the controls you hold. Written for this beta — it will be reviewed and finalized before a production launch."
      icon={ShieldCheck}
    >
      <Section title="What we collect">
        <p>BEAN Folio is a portfolio platform, so the data is mostly what you choose to publish:</p>
        <Bullets
          items={[
            <>
              <span className="text-foreground">Account basics</span> — your email address, display name and a salted
              password hash. We never store your password in readable form, and sign-in sessions are validated
              server-side via an httpOnly cookie.
            </>,
            <>
              <span className="text-foreground">Profile content</span> — headline, bio, location, availability,
              website links, and the avatar and cover images you upload.
            </>,
            <>
              <span className="text-foreground">Projects and media</span> — titles, text fields, tags and every file
              you attach (images, video, audio, documents).
            </>,
            <>
              <span className="text-foreground">Engagement records</span> — when someone views a project or profile we
              record that a view happened, deduplicated per viewer per day. These counts are honest estimates, not
              inflated figures, and the Insights page labels them as such.
            </>,
            <>
              <span className="text-foreground">Social activity</span> — follows, saves, collections, inquiries and
              notifications, since these features can&apos;t work without them.
            </>,
            <>
              <span className="text-foreground">AI usage records</span> — when you use BEAN Intelligence: each AI request
              is counted toward your daily limit, and your conversations are stored so you can revisit them.
            </>,
            <>
              <span className="text-foreground">Audit events</span> — a log of privacy-sensitive actions on your own
              account (visibility changes, data exports, sign-ins, account deletion). You can read this log in
              Settings → Activity log.
            </>,
          ]}
        />
      </Section>

      <Section title="What's private by default">
        <Bullets
          items={[
            <>
              <span className="text-foreground">Drafts</span> are visible to you alone until you press publish.
            </>,
            <>
              <span className="text-foreground">Private projects</span> are readable only by you — even someone holding
              the direct link gets a not-found page. <span className="text-foreground">Unlisted</span> projects are
              readable by direct link but never appear in discovery or search.
            </>,
            <>
              <span className="text-foreground">Inquiries</span> are visible only to the two people involved — never
              publicly.
            </>,
            <>
              <span className="text-foreground">Data exports and the audit log</span> are available only to the signed-in
              account owner.
            </>,
            <>
              <span className="text-foreground">Private profile</span> — with visibility set to Private, your profile is
              hidden from search and discovery, and a direct link shows not found.
            </>,
          ]}
        />
      </Section>

      <Section title="Third-party processing">
        <Bullets
          items={[
            <>
              <span className="text-foreground">AI provider</span> — BEAN Intelligence calls a server-side AI provider
              when you use its features. Only <em>your own</em> profile and projects (never other people&apos;s private
              data) are included as context, and only for requests you send. Nothing the assistant produces is saved
              to your portfolio automatically.
            </>,
            <>
              <span className="text-foreground">Media storage</span> — uploaded files are stored on the platform&apos;s
              own storage and served through the platform&apos;s media endpoints. They are not handed to a third-party
              CDN or hosted-media service in this beta.
            </>,
            <>
              <span className="text-foreground">No ad networks or tracking scripts</span> — this beta carries no
              advertising, no cross-site trackers and no analytics beacons beyond the first-party view records
              described above.
            </>,
          ]}
        />
      </Section>

      <Section title="Your rights and controls">
        <Bullets
          items={[
            <>
              <span className="text-foreground">Visibility controls</span> — flip your profile between Public and
              Private at any time; the change takes effect immediately and is audit-logged.
            </>,
            <>
              <span className="text-foreground">AI controls</span> — BEAN Intelligence only runs when you send a
              request; there is no background processing. Daily usage limits apply and are visible in RIISHE.
            </>,
            <>
              <span className="text-foreground">JSON data export</span> — Settings → Danger zone → Download my data
              produces a complete, human-readable JSON export of your account, projects, collections and activity.
            </>,
            <>
              <span className="text-foreground">Account deletion</span> — deleting your account hides your profile
              immediately, revokes every session, anonymizes your personal data right away, releases your username, and
              schedules the remaining data for deletion.
            </>,
            <>
              <span className="text-foreground">Audit log</span> — you can always see the privacy-relevant actions
              taken on your account in Settings → Activity log.
            </>,
          ]}
        />
      </Section>

      <Section title="Contact">
        <p>
          Questions or requests about this policy can go to{" "}
          <span className="font-mono text-foreground/90">privacy@beanfolio.example</span>.
        </p>
        <p className="rounded-lg border border-dashed border-border/70 bg-card/40 p-3 text-xs">
          Note: that address is a <span className="text-foreground">placeholder</span> for this beta build — replace it
          with a monitored mailbox before production launch.
        </p>
      </Section>
    </DocShell>
  );
}

// ------------------------------------------------------------------ terms page

function TermsDoc() {
  return (
    <DocShell
      title="Terms of Service"
      intro="An honest, plain-language draft of the rules for using BEAN Folio during its beta. Short on legalese, long on clarity — reviewed before any production launch."
      icon={ScrollText}
    >
      <Section title="The service, as it is">
        <p>
          BEAN Folio is in beta. Features change, occasionally break, and improve. We provide it as-is during this
          period: there is no guarantee of uninterrupted availability, and insights counts are labelled estimates
          because view data is deduplicated rather than inflated. We&apos;ll always tell you honestly what a number
          means — we expect you to do the same.
        </p>
      </Section>

      <Section title="Your content">
        <Bullets
          items={[
            <>
              <span className="text-foreground">You own your work.</span> Uploading a project to BEAN Folio does not
              transfer ownership of anything to us.
            </>,
            <>
              <span className="text-foreground">You grant us display rights</span> — the limited license needed to
              actually run the platform: storing your files, rendering your pages, generating thumbnails, and showing
              your published projects in discovery and search. That license ends when you delete the content or your
              account.
            </>,
            <>
              <span className="text-foreground">You are responsible</span> for what you publish — make sure you have
              the rights to every file and every claim you make.
            </>,
          ]}
        />
      </Section>

      <Section title="Prohibited conduct">
        <Bullets
          items={[
            <span key="h">Harassment, hate speech, threats or targeted abuse of other members.</span>,
            <span key="i">Impersonation — accounts, names or avatars meant to pose as another person or brand.</span>,
            <span key="ip">
              Posting work you don&apos;t have rights to, or presenting someone else&apos;s project as your own. Credit
              collaborators and sources.
            </span>,
            <span key="f">Fabricating engagement — buying, trading or scripting views, saves or followers.</span>,
            <span key="s">Scraping, automated bulk access, or abusing the AI usage limits.</span>,
          ]}
        />
      </Section>

      <Section title="Reporting and blocking">
        <p>
          Every project and profile has a Report action, and you can block any account — blocked users can&apos;t
          follow you, send you inquiries, or surface in your discovery feed. Reports are reviewed by moderators; we may
          remove content or suspend accounts that break these terms.
        </p>
      </Section>

      <Section title="AI-generated suggestions">
        <p>
          BEAN Intelligence can suggest rewrites, summaries and metadata. These are <strong>assistive drafts</strong>,
          not verdicts: they can be wrong, bland or miss the point of your work. Review every suggestion before you use
          it — nothing is ever applied to your portfolio automatically, and what you ultimately publish remains your
          responsibility.
        </p>
      </Section>

      <Section title="No fabricated metrics">
        <p>
          BEAN Folio exists to show real work to real people. Views, saves and follower counts on this platform come
          from actual activity, deduplicated per viewer per day, and labelled as estimates. Presenting purchased or
          scripted engagement as genuine popularity violates these terms.
        </p>
      </Section>

      <Section title="Termination">
        <p>
          You can delete your account at any time from Settings — the effect is described in the Privacy Policy. We may
          suspend or terminate accounts for serious or repeated violations of these terms, with notice where
          practical. Content that endangers other members can be removed without notice.
        </p>
      </Section>
    </DocShell>
  );
}

// ------------------------------------------------------------------ view

export default function StaticView({ page }: { page: "privacy" | "terms" }) {
  return page === "privacy" ? <PrivacyDoc /> : <TermsDoc />;
}
