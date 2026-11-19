"use client";

/**
 * Opportunity Exchange — the landing/dashboard for the dedicated
 * #/opportunities destination (O1+O2).
 *
 * O1 scope: the employer-identity workspace (organizations, verification,
 * teams). O2 adds the candidate opportunity-profile workspace below it:
 * career preferences, salary disclosure policy, visibility states and the
 * three independent purpose-scoped consent controls. Discovery, matching,
 * invitations and hiring rooms remain future milestones — nothing here
 * implements them.
 */

import { Briefcase } from "lucide-react";

import { SectionHeader } from "@/components/bean/SectionHeader";

import OxCandidateInvitationsPanel from "./OxCandidateInvitationsPanel";
import OxCandidateProfileView from "./OxCandidateProfileView";
import OxCandidateTransparencyPanel from "./OxCandidateTransparencyPanel";
import OxEmployerDiscoveryPanel from "./OxEmployerDiscoveryPanel";
import OxEmployerInvitationsPanel from "./OxEmployerInvitationsPanel";
import OxEmployerOpportunitiesPanel from "./OxEmployerOpportunitiesPanel";
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

      <section aria-labelledby="ox-employer-opportunities-heading" className="mt-10">
        <h2 id="ox-employer-opportunities-heading" className="sr-only">
          Opportunity listings
        </h2>
        <OxEmployerOpportunitiesPanel />
      </section>

      <section aria-labelledby="ox-employer-discovery-heading" className="mt-10">
        <h2 id="ox-employer-discovery-heading" className="sr-only">
          Discover talent and shortlists
        </h2>
        <OxEmployerDiscoveryPanel />
      </section>

      <section aria-labelledby="ox-employer-invitations-heading" className="mt-10">
        <h2 id="ox-employer-invitations-heading" className="sr-only">
          Invitations sent
        </h2>
        <OxEmployerInvitationsPanel />
      </section>

      <section aria-labelledby="ox-candidate-workspace-heading" className="mt-10">
        <SectionHeader
          title="For professionals"
          description="Your opportunity passport: preferences, salary privacy and purpose-scoped consent — all in your control."
          as="h2"
        />
        <h2 id="ox-candidate-workspace-heading" className="sr-only">
          For professionals
        </h2>
        <div className="mt-4">
          <OxCandidateProfileView />
        </div>
        <div className="mt-6">
          <OxCandidateTransparencyPanel />
        </div>
        <div className="mt-6">
          <OxCandidateInvitationsPanel />
        </div>
      </section>
    </div>
  );
}
