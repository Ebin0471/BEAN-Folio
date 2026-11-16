"use client";

/**
 * Opportunity Exchange — the landing/dashboard for the dedicated
 * #/opportunities destination (O1).
 *
 * O1 scope: the employer-identity workspace (organizations, verification,
 * teams). Candidate-facing capabilities (opportunity profiles, discovery,
 * invitations, hiring rooms) are subsequent milestones — the landing shows
 * an honest, disabled-by-design preview instead of dead links.
 */

import { Briefcase, Hourglass, ShieldCheck } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/bean/SectionHeader";

import OxEmployerSetupView from "./OxEmployerSetupView";

export default function OpportunityExchangeView() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">Opportunity Exchange</p>
        <h1 className="mt-1 flex items-center gap-3 font-display text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          <span className="grid size-10 place-items-center rounded-full bg-gold-soft text-primary">
            <Briefcase className="size-5" aria-hidden />
          </span>
          Where work finds people
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          A professional exchange on BEAN Folio — employer organizations build verified teams, and candidates stay in
          control of their discoverability through explicit consent. Salary transparency and consent-first hiring are
          the foundation of every milestone.
        </p>
      </header>

      <SectionHeader
        title="Employer workspace"
        description="Set up your organization, manage your team, and complete verification."
        as="h2"
      />
      <div className="mt-4">
        <OxEmployerSetupView />
      </div>

      <section aria-labelledby="ox-candidate-heading" className="mt-10">
        <SectionHeader
          title="For professionals"
          description="Your opportunity passport, preferences and consent controls arrive in the next milestone."
          as="h2"
        />
        <h2 id="ox-candidate-heading" className="sr-only">
          For professionals
        </h2>
        <Card className="mt-4 border-dashed">
          <CardContent className="flex flex-col gap-3 p-6">
            <div className="flex items-center gap-3 text-sm">
              <span className="grid size-9 place-items-center rounded-full bg-accent text-muted-foreground">
                <Hourglass className="size-4" aria-hidden />
              </span>
              <div>
                <p className="font-medium">Candidate workspaces — coming in O2</p>
                <p className="text-muted-foreground">
                  Opportunity profiles, career preferences, salary privacy and purpose-scoped visibility consent.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="grid size-9 place-items-center rounded-full bg-accent text-muted-foreground">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <div>
                <p className="font-medium">Consent-first by design</p>
                <p className="text-muted-foreground">
                  Nothing about you becomes discoverable until you explicitly opt in — and revoking is instant.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
