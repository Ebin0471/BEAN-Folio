"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { BadgeCheck, Check, ChevronLeft, Loader2, MailCheck, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { EmptyState } from "@/components/bean/EmptyState";
import { Spinner } from "@/components/bean/Spinner";
import { TagInput } from "@/components/bean/TagInput";
import { api, ApiError } from "@/lib/client";
import { navigate, takeReturnTo } from "@/lib/hash-router";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { IDENTITY_META, BeanIdentity } from "@/lib/identity";
import type { ProfessionDTO, SkillDTO } from "@/lib/types";

/** Matches the server rule: 3–24 chars, lowercase letters/digits/hyphens, starts alphanumeric. */
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,23}$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
}

const MAX_PROFESSIONS = 5;
const MAX_SKILLS = 12;
const MAX_BIO = 2000;

// ---------------------------------------------------------------- M31 role-aware onboarding
// Role-specific answers for the user's registered identity. Free-form arrays
// are trimmed/limited client-side and STRICTLY re-validated server-side.
type RoleDraft = {
  employmentStatus?: string;
  industries?: string[];
  experienceLevel?: string;
  preferredWorkTypes?: string[];
  preferredLocations?: string;
  workModes?: string[];
  careerInterests?: string;
  portfolioVisibility?: "PRIVATE" | "PUBLIC";
  services?: string[];
  specializations?: string[];
  projectTypes?: string[];
  portfolioUrl?: string;
  availability?: string;
  orgType?: string;
  industry?: string;
  companySize?: string;
  country?: string;
  website?: string;
  representativeRole?: string;
  authorityAttested?: boolean;
  teamSetupNote?: string;
  partnerType?: string;
  rolesSourced?: string[];
  sourcingFor?: string;
  organizationAffiliation?: string;
  clientAuthorizationNote?: string;
  candidateDataRulesAcknowledged?: boolean;
};

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "EMPLOYED", label: "Employed" },
  { value: "SEEKING", label: "Seeking work" },
  { value: "OPEN", label: "Open to opportunities" },
  { value: "STUDENT_GRADUATE", label: "Student / graduate" },
  { value: "CAREER_BREAK", label: "Career break" },
];
const WORK_MODE_OPTIONS = [
  { value: "ONSITE", label: "On-site" },
  { value: "HYBRID", label: "Hybrid" },
  { value: "REMOTE", label: "Remote" },
];
const WORK_TYPE_OPTIONS = ["Full-time", "Part-time", "Contract", "Internship", "Apprenticeship"];
const ORG_TYPE_OPTIONS = [
  { value: "COMPANY", label: "Company" },
  { value: "STARTUP", label: "Startup" },
  { value: "STUDIO", label: "Studio" },
  { value: "AGENCY", label: "Agency" },
  { value: "NONPROFIT", label: "Nonprofit" },
  { value: "INSTITUTION", label: "Institution" },
];
const ORG_SIZE_OPTIONS = [
  { value: "STARTUP_1_10", label: "1–10" },
  { value: "SMB_11_50", label: "11–50" },
  { value: "MID_51_200", label: "51–200" },
  { value: "LARGE_201_1000", label: "201–1000" },
  { value: "ENTERPRISE_1000_PLUS", label: "1000+" },
];
const PARTNER_TYPE_OPTIONS = [
  { value: "IN_HOUSE", label: "In-house recruiter" },
  { value: "STAFFING_AGENCY", label: "Staffing agency" },
  { value: "INDEPENDENT_RECRUITER", label: "Independent recruiter" },
  { value: "TALENT_OR_PROJECT_SCOUT", label: "Talent / project scout" },
];

type TrustState = {
  email: { verified: boolean; verifiedAt: string | null; required: boolean; gateApplies: boolean };
};

function chipToggle(list: string[], value: string, max: number): string[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (list.length >= max) return list;
  return [...list, value];
}

type ChipOption = { value: string; label: string };
function toChipOptions(options: readonly (string | ChipOption)[]): ChipOption[] {
  return options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

function Chips({
  options,
  selected,
  onToggle,
  max,
  label,
}: {
  options: readonly (string | ChipOption)[];
  selected: string[];
  onToggle: (v: string) => void;
  max: number;
  label: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {toChipOptions(options).map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(opt.value)}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                active
                  ? "border-primary/60 bg-gold-soft font-medium text-primary"
                  : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
              )}
            >
              {active && <Check className="mr-1 size-3.5" aria-hidden />}
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Select up to {max}.</p>
    </fieldset>
  );
}

/** M31: honest email-verification banner — shows real delivery state. */
function VerificationBanner() {
  const [trust, setTrust] = useState<TrustState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api<TrustState>("/api/me/trust")
      .then(setTrust)
      .catch(() => setTrust(null));
  }, []);

  async function resend() {
    setBusy(true);
    setNote(null);
    try {
      const res = await api<{ issued: boolean; sent: boolean; reason?: string; devToken?: string }>(
        "/api/auth/verify-email/request",
        { method: "POST" }
      );
      if (res.devToken) {
        // Development/QA-only path (EMAIL_DEV_TEST_MODE): complete the
        // verification directly with the exposed token.
        await api("/api/auth/verify-email/confirm", { method: "POST", json: { token: res.devToken } });
        toast.success("Email verified (development test path)");
        const t = await api<TrustState>("/api/me/trust");
        setTrust(t);
      } else if (res.sent) {
        setNote("A verification email is on its way — it can take a moment to arrive.");
      } else if (res.reason === "cooldown" || res.reason === "daily-cap") {
        setNote(
          res.reason === "cooldown"
            ? "Please wait a minute before requesting another email."
            : "Daily resend limit reached — try again tomorrow or use a different verification channel later."
        );
      } else {
        // Honest state: no email provider is configured on this deployment.
        setNote(
          "No email provider is configured on this deployment, so no email was sent — this is shown honestly, not silently. Verification email delivery requires an owner-configured provider."
        );
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not send the verification email.");
    } finally {
      setBusy(false);
    }
  }

  if (!trust?.email.gateApplies || trust.email.verified) return null;
  return (
    <div role="status" className="mb-6 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-start gap-3">
        <MailCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Verify your email to unlock outreach and invitations</p>
          <p className="mt-1 text-xs text-muted-foreground">
            You can finish setting up your profile now. Sending inquiries, invitations and candidate contact unlock once your
            email is verified.
          </p>
          {note && <p className="mt-2 text-xs text-foreground/90">{note}</p>}
          <div className="mt-3">
            <Button size="sm" variant="outline" onClick={() => void resend()} disabled={busy} className="h-9">
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Resend verification email
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingView() {
  const { user, loading, refresh } = useSession();

  // ------------------------------------------------------------- guards
  // After a successful submit we navigate to /folio ourselves; the ref stops
  // this "already onboarded" redirect from racing that navigation.
  const submittedRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!user) navigate("/auth", true);
    else if (user.onboarded && !submittedRef.current) navigate(takeReturnTo("/"), true);
  }, [loading, user]);

  // ------------------------------------------------------------- taxonomy
  const [professions, setProfessions] = useState<ProfessionDTO[]>([]);
  const [skillSuggestions, setSkillSuggestions] = useState<SkillDTO[]>([]);
  const [taxLoading, setTaxLoading] = useState(true);
  const [taxError, setTaxError] = useState<string | null>(null);

  async function loadTaxonomy() {
    setTaxLoading(true);
    setTaxError(null);
    try {
      const [p, s] = await Promise.all([
        api<{ professions: ProfessionDTO[] }>("/api/professions"),
        api<{ skills: SkillDTO[] }>("/api/skills"),
      ]);
      setProfessions(p.professions);
      setSkillSuggestions(s.skills);
    } catch (err) {
      setTaxError(err instanceof Error ? err.message : "Could not load professions and skills.");
    } finally {
      setTaxLoading(false);
    }
  }

  useEffect(() => {
    void loadTaxonomy();
  }, []);

  // ------------------------------------------------------------- form state
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [headline, setHeadline] = useState("");
  const [selectedProfessions, setSelectedProfessions] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [location, setLocation] = useState("");

  const [nameError, setNameError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // M31: identity-aware onboarding. New accounts register with an identity;
  // legacy accounts (null) keep the exact historical two-step flow.
  const identity = (user?.primaryIdentity ?? null) as BeanIdentity | null;
  const totalSteps = identity ? 3 : 2;
  const [role, setRole] = useState<RoleDraft>({});
  const setRoleField = <K extends keyof RoleDraft>(key: K, value: RoleDraft[K]) =>
    setRole((prev) => ({ ...prev, [key]: value }));

  function buildIdentityPayload(): { type: BeanIdentity; data: Record<string, unknown> } | undefined {
    if (!identity) return undefined;
    if (identity === "CAREER_PROFESSIONAL") {
      return {
        type: identity,
        data: {
          ...(role.employmentStatus ? { employmentStatus: role.employmentStatus } : {}),
          ...(role.industries?.length ? { industries: role.industries } : {}),
          ...(role.experienceLevel?.trim() ? { experienceLevel: role.experienceLevel.trim() } : {}),
          ...(role.preferredWorkTypes?.length ? { preferredWorkTypes: role.preferredWorkTypes } : {}),
          ...(role.preferredLocations?.trim() ? { preferredLocations: [role.preferredLocations.trim()] } : {}),
          ...(role.workModes?.length ? { workModes: role.workModes } : {}),
          ...(role.careerInterests?.trim() ? { careerInterests: role.careerInterests.trim() } : {}),
          portfolioVisibility: role.portfolioVisibility ?? "PRIVATE",
        },
      };
    }
    if (identity === "INDEPENDENT_PROFESSIONAL") {
      return {
        type: identity,
        data: {
          ...(role.services?.length ? { services: role.services } : {}),
          ...(role.specializations?.length ? { specializations: role.specializations } : {}),
          ...(role.projectTypes?.length ? { projectTypes: role.projectTypes } : {}),
          ...(role.portfolioUrl?.trim() ? { portfolioUrl: role.portfolioUrl.trim() } : {}),
          ...(role.availability?.trim() ? { availability: role.availability.trim() } : {}),
          ...(role.workModes?.length ? { workModes: role.workModes } : {}),
        },
      };
    }
    if (identity === "ORGANIZATION") {
      return {
        type: identity,
        data: {
          ...(role.orgType ? { orgType: role.orgType } : {}),
          ...(role.industry?.trim() ? { industry: role.industry.trim() } : {}),
          ...(role.companySize ? { companySize: role.companySize } : {}),
          ...(role.country?.trim() ? { country: role.country.trim() } : {}),
          ...(role.website?.trim() ? { website: role.website.trim() } : {}),
          ...(role.representativeRole?.trim() ? { representativeRole: role.representativeRole.trim() } : {}),
          ...(role.authorityAttested ? { authorityAttested: true } : {}),
          ...(role.teamSetupNote?.trim() ? { teamSetupNote: role.teamSetupNote.trim() } : {}),
        },
      };
    }
    return {
      type: identity,
      data: {
        ...(role.partnerType ? { partnerType: role.partnerType } : {}),
        ...(role.industries?.length ? { industries: role.industries } : {}),
        ...(role.rolesSourced?.length ? { rolesSourced: role.rolesSourced } : {}),
        ...(role.sourcingFor ? { sourcingFor: role.sourcingFor } : {}),
        ...(role.organizationAffiliation?.trim() ? { organizationAffiliation: role.organizationAffiliation.trim() } : {}),
        ...(role.clientAuthorizationNote?.trim() ? { clientAuthorizationNote: role.clientAuthorizationNote.trim() } : {}),
        ...(role.candidateDataRulesAcknowledged ? { candidateDataRulesAcknowledged: true } : {}),
      },
    };
  }

  function continueToStep3() {
    // Identity-specific pre-submit attestations are enforced here so the
    // failure is a friendly message, not a raw 400.
    if (identity === "ORGANIZATION" && !role.authorityAttested) {
      setFormError("Please confirm you have authority to create and manage this organization workspace.");
      return;
    }
    if (identity === "TALENT_PARTNER" && !role.candidateDataRulesAcknowledged) {
      setFormError("Please acknowledge the candidate data access rules to continue.");
      return;
    }
    setFormError(null);
    void submit();
  }

  // Auto-slugify the username from the display name until the user edits it.
  function onDisplayNameChange(v: string) {
    setDisplayName(v);
    if (!usernameTouched) setUsername(slugify(v));
  }

  const groupedProfessions = useMemo(() => {
    const groups: { group: string; items: ProfessionDTO[] }[] = [];
    for (const p of professions) {
      const g = groups.find((x) => x.group === p.group);
      if (g) g.items.push(p);
      else groups.push({ group: p.group, items: [p] });
    }
    return groups;
  }, [professions]);

  const suggestedSkills = useMemo(
    () => skillSuggestions.filter((s) => !skills.some((v) => v.toLowerCase() === s.label.toLowerCase())).slice(0, 12),
    [skillSuggestions, skills]
  );

  function toggleProfession(slug: string) {
    setSelectedProfessions((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      if (prev.length >= MAX_PROFESSIONS) return prev;
      return [...prev, slug];
    });
  }

  function goStep1() {
    setFormError(null);
    setStep(1);
  }

  function continueToStep2() {
    const nextName = !displayName.trim() ? "Your name appears on your public folio." : null;
    const nextUsername = !USERNAME_RE.test(username)
      ? "Usernames are 3–24 characters: lowercase letters, numbers and hyphens, starting with a letter or number."
      : null;
    setNameError(nextName);
    setUsernameError(nextUsername);
    if (nextName || nextUsername) return;
    setFormError(null);
    setStep(2);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    setUsernameError(null);
    try {
      await api("/api/me/onboarding", {
        method: "POST",
        json: {
          username,
          displayName: displayName.trim(),
          professions: selectedProfessions,
          skills,
          ...(headline.trim() ? { headline: headline.trim() } : {}),
          ...(bio.trim() ? { bio: bio.trim() } : {}),
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(identity ? { identity: buildIdentityPayload() } : {}),
        },
      });
      // Pick up the new session before routing so the shell gates correctly.
      submittedRef.current = true;
      await refresh();
      toast.success("Your Folio is ready");
      // Return to the protected route that led into setup (default: My Folio).
      navigate(takeReturnTo("/folio"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setUsernameError("That username is taken — try another one.");
        setFormError(null);
        setStep(1);
      } else {
        setFormError(err instanceof Error ? err.message : "Something went wrong — please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------- render
  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <Spinner label="Checking your session…" />
      </div>
    );
  }
  if (!user || user.onboarded) return null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8 text-center">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">Welcome to BEAN Folio</p>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-foreground">
          Set up your folio
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {identity ? "A few quick steps — including details tailored to your primary purpose." : "Two quick steps. Everything here can be changed later in your settings."}
        </p>
        {identity && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-gold-soft/50 px-3 py-1 text-xs text-primary">
            <BadgeCheck className="size-3.5" aria-hidden />
            {IDENTITY_META[identity].label} setup
          </p>
        )}
      </header>

      {identity && <VerificationBanner />}

      {/* progress indicator */}
      <div className="mb-6" aria-hidden>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Step {step} of {totalSteps}
          </span>
          <span>{step === 1 ? "Who you are" : step === 2 ? "Your craft" : identity ? IDENTITY_META[identity].label : ""}</span>
        </div>
        <div className="mt-2 flex gap-2">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className={cn("h-1 flex-1 rounded-full transition-colors", step >= i + 1 ? "bg-primary" : "bg-muted")} />
          ))}
        </div>
      </div>

      <motion.div
        key={step}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="rounded-xl border border-border/60 bg-card p-4 sm:p-6"
        aria-busy={busy}
      >
        {formError && (
          <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        )}

        {step === 1 ? (
          // ------------------------------------------------ step 1: identity
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="ob-name">Display name</Label>
              <Input
                id="ob-name"
                value={displayName}
                onChange={(e) => onDisplayNameChange(e.target.value)}
                placeholder="Ada Okafor"
                maxLength={60}
                autoComplete="name"
                aria-invalid={Boolean(nameError)}
                className="h-11"
              />
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ob-username">Username</Label>
              <div className="flex items-center rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30 aria-invalid:border-destructive">
                <span className="pl-3 text-sm text-muted-foreground" aria-hidden>
                  @
                </span>
                <Input
                  id="ob-username"
                  value={username}
                  onChange={(e) => {
                    setUsernameTouched(true);
                    setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    setUsernameError(null);
                  }}
                  placeholder="ada-okafor"
                  maxLength={24}
                  autoComplete="off"
                  aria-invalid={Boolean(usernameError)}
                  className="h-11 rounded-l-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                />
              </div>
              {usernameError ? (
                <p className="text-xs text-destructive">{usernameError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Your public page lives at folio.dev/u/{username || "your-name"} — lowercase letters, numbers and hyphens.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ob-headline">
                Headline <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="ob-headline"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="Documentary editor, 6 years"
                maxLength={120}
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">One line about what you do — it shows next to your name everywhere.</p>
            </div>

            <div className="flex justify-end pt-1">
              <Button onClick={continueToStep2} disabled={busy} className="h-11 min-w-32">
                Continue
              </Button>
            </div>
          </div>
        ) : step === 2 ? (
          // ------------------------------------------------ step 2: craft
          <div className="space-y-6">
            {taxLoading ? (
              <div className="space-y-3" aria-busy="true">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="h-9 w-24 animate-pulse rounded-full bg-muted" />
                  ))}
                </div>
              </div>
            ) : taxError ? (
              <EmptyState
                icon={RefreshCw}
                title="Could not load professions"
                description={taxError}
                action={
                  <Button variant="outline" onClick={() => void loadTaxonomy()}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">
                    Professions{" "}
                    <span className={cn("ml-1 text-xs", selectedProfessions.length >= MAX_PROFESSIONS ? "text-primary" : "text-muted-foreground")}>
                      {selectedProfessions.length} / {MAX_PROFESSIONS} selected
                    </span>
                  </legend>
                  <p className="mt-1 text-xs text-muted-foreground">Pick up to five — they shape your feed and who finds you.</p>
                  <div className="mt-3 max-h-80 space-y-4 overflow-y-auto pr-1">
                    {groupedProfessions.map((g) => (
                      <div key={g.group}>
                        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.group}</p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {g.items.map((p) => {
                            const active = selectedProfessions.includes(p.slug);
                            const blocked = !active && selectedProfessions.length >= MAX_PROFESSIONS;
                            return (
                              <button
                                key={p.slug}
                                type="button"
                                aria-pressed={active}
                                disabled={blocked}
                                onClick={() => toggleProfession(p.slug)}
                                className={cn(
                                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors",
                                  active
                                    ? "border-primary/60 bg-gold-soft font-medium text-primary"
                                    : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground",
                                  blocked && "cursor-not-allowed opacity-40"
                                )}
                              >
                                {active && <Check className="size-3.5" aria-hidden />}
                                {p.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>

                <div className="space-y-1.5">
                  <Label htmlFor="ob-skills">Skills</Label>
                  <TagInput
                    value={skills}
                    onChange={setSkills}
                    max={MAX_SKILLS}
                    placeholder="Type a skill and press Enter"
                    ariaLabel="Add a skill"
                  />
                  {suggestedSkills.length > 0 && (
                    <div className="pt-1">
                      <p className="text-xs text-muted-foreground">Popular on BEAN Folio — tap to add:</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {suggestedSkills.map((s) => (
                          <button
                            key={s.slug}
                            type="button"
                            onClick={() => setSkills((prev) => (prev.length >= MAX_SKILLS ? prev : [...prev, s.label]))}
                            className="inline-flex min-h-9 items-center rounded-full border border-dashed border-border/80 px-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                          >
                            + {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="ob-bio">
                      Bio <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                      id="ob-bio"
                      value={bio}
                      onChange={(e) => setBio(e.target.value.slice(0, MAX_BIO))}
                      placeholder="What you make, what you care about, what you are looking for."
                      rows={4}
                      maxLength={MAX_BIO}
                    />
                    <p className="text-right text-xs text-muted-foreground">
                      {bio.length}/{MAX_BIO}
                    </p>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="ob-location">
                      Location <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="ob-location"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Lagos, Nigeria"
                      maxLength={80}
                      className="h-11"
                    />
                  </div>
                </div>
              </>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" onClick={goStep1} disabled={busy} className="h-11 gap-1.5">
                <ChevronLeft className="size-4" aria-hidden /> Back
              </Button>
              {identity ? (
                <Button onClick={() => setStep(3)} disabled={busy || taxLoading} className="h-11 min-w-40">
                  Continue
                </Button>
              ) : (
                <Button onClick={() => void submit()} disabled={busy || taxLoading} className="h-11 min-w-40">
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
                  {busy ? "Setting up…" : "Finish — open my Folio"}
                </Button>
              )}
            </div>
          </div>
        ) : (
          // --------------------------------------- step 3: role-specific details
          <div className="space-y-6">
            <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs text-muted-foreground">
              {identity === "CAREER_PROFESSIONAL" &&
                "Tell us about your work situation and preferences. Everything here shapes opportunity matching — nothing sensitive is required."}
              {identity === "INDEPENDENT_PROFESSIONAL" &&
                "Describe your services and availability. You can attach portfolio work samples later from your folio."}
              {identity === "ORGANIZATION" &&
                "Workspace context for your organization. The workspace itself is created next from Settings — with team roles and verification."}
              {identity === "TALENT_PARTNER" &&
                "Sourcing context for talent work. Candidate access is NOT granted by this profile — it requires verified organization membership or an approved authorization."}
            </div>

            {identity === "CAREER_PROFESSIONAL" && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">Employment status</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {EMPLOYMENT_STATUS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={role.employmentStatus === opt.value}
                        onClick={() => setRoleField("employmentStatus", role.employmentStatus === opt.value ? undefined : opt.value)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                          role.employmentStatus === opt.value
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-exp">Experience level</Label>
                    <Input
                      id="ob-exp"
                      value={role.experienceLevel ?? ""}
                      onChange={(e) => setRoleField("experienceLevel", e.target.value)}
                      placeholder="Early career / Mid-career / Senior"
                      maxLength={60}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-loc">Preferred location</Label>
                    <Input
                      id="ob-loc"
                      value={role.preferredLocations ?? ""}
                      onChange={(e) => setRoleField("preferredLocations", e.target.value)}
                      placeholder="Lagos, Nigeria"
                      maxLength={80}
                      className="h-11"
                    />
                  </div>
                </div>
                <Chips
                  label="Preferred work type"
                  options={WORK_TYPE_OPTIONS}
                  selected={role.preferredWorkTypes ?? []}
                  onToggle={(v) => setRoleField("preferredWorkTypes", chipToggle(role.preferredWorkTypes ?? [], v, 5))}
                  max={5}
                />
                <Chips
                  label="Work mode"
                  options={WORK_MODE_OPTIONS}
                  selected={role.workModes ?? []}
                  onToggle={(v) => setRoleField("workModes", chipToggle(role.workModes ?? [], v, 3))}
                  max={3}
                />
                <div className="space-y-1.5">
                  <Label>Industries</Label>
                  <TagInput
                    value={role.industries ?? []}
                    onChange={(v) => setRoleField("industries", v)}
                    max={12}
                    placeholder="Type an industry and press Enter"
                    ariaLabel="Add an industry"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ob-interests">
                    Career interests <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="ob-interests"
                    value={role.careerInterests ?? ""}
                    onChange={(e) => setRoleField("careerInterests", e.target.value.slice(0, 500))}
                    placeholder="Where you would like your career to go."
                    rows={3}
                    maxLength={500}
                  />
                </div>
                <fieldset>
                  <legend className="text-sm font-medium">Profile visibility</legend>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your profile starts PRIVATE — only you can see it. You can choose to appear in public discovery.
                  </p>
                  <div className="mt-2 flex gap-2">
                    {(["PRIVATE", "PUBLIC"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={(role.portfolioVisibility ?? "PRIVATE") === v}
                        onClick={() => setRoleField("portfolioVisibility", v)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-4 text-sm transition-colors",
                          (role.portfolioVisibility ?? "PRIVATE") === v
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {v === "PRIVATE" ? "Private (recommended)" : "Public"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}

            {identity === "INDEPENDENT_PROFESSIONAL" && (
              <>
                <div className="space-y-1.5">
                  <Label>Services</Label>
                  <TagInput
                    value={role.services ?? []}
                    onChange={(v) => setRoleField("services", v)}
                    max={12}
                    placeholder="Type a service and press Enter"
                    ariaLabel="Add a service"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Specializations</Label>
                  <TagInput
                    value={role.specializations ?? []}
                    onChange={(v) => setRoleField("specializations", v)}
                    max={12}
                    placeholder="Type a specialization and press Enter"
                    ariaLabel="Add a specialization"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Project types</Label>
                  <TagInput
                    value={role.projectTypes ?? []}
                    onChange={(v) => setRoleField("projectTypes", v)}
                    max={12}
                    placeholder="Type a project type and press Enter"
                    ariaLabel="Add a project type"
                  />
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-avail">Availability</Label>
                    <Input
                      id="ob-avail"
                      value={role.availability ?? ""}
                      onChange={(e) => setRoleField("availability", e.target.value)}
                      placeholder="Available from March, 20h/week"
                      maxLength={120}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-portfolio">Portfolio URL</Label>
                    <Input
                      id="ob-portfolio"
                      value={role.portfolioUrl ?? ""}
                      onChange={(e) => setRoleField("portfolioUrl", e.target.value)}
                      placeholder="https://your-work.example"
                      maxLength={300}
                      className="h-11"
                    />
                  </div>
                </div>
                <Chips
                  label="Preferred work mode"
                  options={WORK_MODE_OPTIONS}
                  selected={role.workModes ?? []}
                  onToggle={(v) => setRoleField("workModes", chipToggle(role.workModes ?? [], v, 3))}
                  max={3}
                />
              </>
            )}

            {identity === "ORGANIZATION" && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">Organization type</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ORG_TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={role.orgType === opt.value}
                        onClick={() => setRoleField("orgType", role.orgType === opt.value ? undefined : opt.value)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                          role.orgType === opt.value
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium">Team size</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ORG_SIZE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={role.companySize === opt.value}
                        onClick={() => setRoleField("companySize", role.companySize === opt.value ? undefined : opt.value)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                          role.companySize === opt.value
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-ind">Industry</Label>
                    <Input
                      id="ob-ind"
                      value={role.industry ?? ""}
                      onChange={(e) => setRoleField("industry", e.target.value)}
                      placeholder="Design & advertising"
                      maxLength={80}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-country">Country</Label>
                    <Input
                      id="ob-country"
                      value={role.country ?? ""}
                      onChange={(e) => setRoleField("country", e.target.value)}
                      placeholder="Nigeria"
                      maxLength={80}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-web">Website / domain</Label>
                    <Input
                      id="ob-web"
                      value={role.website ?? ""}
                      onChange={(e) => setRoleField("website", e.target.value)}
                      placeholder="https://your-org.example"
                      maxLength={300}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ob-rep">Your role at the organization</Label>
                    <Input
                      id="ob-rep"
                      value={role.representativeRole ?? ""}
                      onChange={(e) => setRoleField("representativeRole", e.target.value)}
                      placeholder="Founder / People lead"
                      maxLength={80}
                      className="h-11"
                    />
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id="ob-authority"
                      checked={role.authorityAttested === true}
                      onCheckedChange={(v) => setRoleField("authorityAttested", v === true)}
                    />
                    <Label htmlFor="ob-authority" className="text-xs font-normal leading-relaxed text-muted-foreground">
                      I confirm I have the authority to create and manage a workspace for this organization. Organization
                      verification is a separate reviewed process — creating a workspace does not mark it verified.
                    </Label>
                  </div>
                </div>
              </>
            )}

            {identity === "TALENT_PARTNER" && (
              <>
                <fieldset>
                  <legend className="text-sm font-medium">Sourcing setup</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {PARTNER_TYPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={role.partnerType === opt.value}
                        onClick={() => setRoleField("partnerType", role.partnerType === opt.value ? undefined : opt.value)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                          role.partnerType === opt.value
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium">Who do you source for?</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[{ value: "OWN_ORGANIZATION", label: "My own organization" }, { value: "CLIENT", label: "A client" }].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        aria-pressed={role.sourcingFor === opt.value}
                        onClick={() => setRoleField("sourcingFor", role.sourcingFor === opt.value ? undefined : opt.value)}
                        className={cn(
                          "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm transition-colors",
                          role.sourcingFor === opt.value
                            ? "border-primary/60 bg-gold-soft font-medium text-primary"
                            : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-1.5">
                  <Label>Industries you source in</Label>
                  <TagInput
                    value={role.industries ?? []}
                    onChange={(v) => setRoleField("industries", v)}
                    max={12}
                    placeholder="Type an industry and press Enter"
                    ariaLabel="Add an industry"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Roles you source</Label>
                  <TagInput
                    value={role.rolesSourced ?? []}
                    onChange={(v) => setRoleField("rolesSourced", v)}
                    max={12}
                    placeholder="Type a role and press Enter"
                    ariaLabel="Add a role"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ob-affil">
                    Organization affiliation <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="ob-affil"
                    value={role.organizationAffiliation ?? ""}
                    onChange={(e) => setRoleField("organizationAffiliation", e.target.value)}
                    placeholder="Agency or employer you work with"
                    maxLength={120}
                    className="h-11"
                  />
                </div>
                <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    Candidate profiles stay hidden unless each candidate explicitly consents to discovery. Protected candidate
                    information is only accessible with verified organization membership or an approved partner authorization —
                    never because of a self-selected category. Evidence (client authorization, agency affiliation) is reviewed
                    progressively when the relevant capability is used.
                  </p>
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id="ob-cdr"
                      checked={role.candidateDataRulesAcknowledged === true}
                      onCheckedChange={(v) => setRoleField("candidateDataRulesAcknowledged", v === true)}
                    />
                    <Label htmlFor="ob-cdr" className="text-xs font-normal leading-relaxed text-muted-foreground">
                      I understand and accept these candidate data access rules.
                    </Label>
                  </div>
                </div>
              </>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={busy} className="h-11 gap-1.5">
                <ChevronLeft className="size-4" aria-hidden /> Back
              </Button>
              <Button onClick={continueToStep3} disabled={busy || taxLoading} className="h-11 min-w-40">
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
                {busy ? "Setting up…" : "Finish — open my Folio"}
              </Button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
