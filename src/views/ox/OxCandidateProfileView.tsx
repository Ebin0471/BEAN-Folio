"use client";

/**
 * Opportunity Exchange (O2) — the candidate opportunity-profile workspace.
 *
 * One surface for: career preferences (employment types, work modes,
 * locations, professions, experience, availability), salary preference and
 * disclosure policy, the four visibility states with an explicit
 * confirmation before activating discoverability, and the three INDEPENDENT
 * purpose-scoped consent controls (DISCOVERY / PROFILE_ANALYTICS /
 * AI_PROCESSING) with a truthful ledger history.
 *
 * The UI only MIRRORS what the server enforces (O1 precedent): all consent
 * semantics, visibility gating, salary integrity and the disclosure matrix
 * live in `src/lib/ox/*` behind the six Phase C APIs — this view never
 * re-decides policy, never sends a userId/consentVersion/source, and renders
 * the server's own state statements (NO_ROW / REVOKED / EXPIRED / 409 codes)
 * verbatim instead of guessing. Contact details are structurally absent from
 * every DTO the owner serializer returns, so nothing private can leak here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Eye,
  EyeOff,
  IndianRupee,
  Loader2,
  PauseCircle,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import { EmptyState } from "@/components/bean/EmptyState";
import { SectionHeader } from "@/components/bean/SectionHeader";
import { TagInput } from "@/components/bean/TagInput";

import { api, ApiError, formatDate } from "@/lib/client";
import { cn } from "@/lib/utils";

import {
  COMPENSATION_PERIOD_OPTIONS,
  COMPENSATION_VISIBILITY_OPTIONS,
  CONSENT_PURPOSE_COPY,
  CONSENT_SCOPE_ORDER,
  CURRENCY_OPTIONS,
  EMPLOYMENT_TYPE_OPTIONS,
  VISIBILITY_STATUS_OPTIONS,
  WORK_MODE_OPTIONS,
  buildProfilePatch,
  consentStateCopy,
  formatRupees,
  formFromProfile,
  requiresActivationConfirmation,
  rupeesToPaise,
  salaryBlockInputComplete,
  visibilityStatusCopy,
  type CandidateProfileDTO,
  type CandidateProfileFormState,
  type ConsentCurrentStateDTO,
  type ConsentLedgerRowDTO,
  type ConsentScope,
} from "./candidate-profile-state";

// ---------------------------------------------------------------- types

interface ProfessionOption {
  id: string;
  slug: string;
  label: string;
  group: string;
}

interface ProfessionTreeResponse {
  families: {
    slug: string;
    label: string;
    professions: { id: string; slug: string; label: string; group?: string }[];
  }[];
}

type CurrentConsentMap = Record<string, ConsentCurrentStateDTO>;

interface ConsentsResponse {
  current: CurrentConsentMap;
  history: ConsentLedgerRowDTO[];
}

function errText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

function statusPill(status: string) {
  const map: Record<string, string> = {
    HIDDEN: "border-border text-muted-foreground",
    ACTIVE: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    PAUSED: "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
    INVITE_ONLY: "border-primary/40 bg-gold-soft text-primary",
  };
  return (
    <Badge variant="outline" className={cn("gap-1 text-[11px]", map[status] ?? "border-border text-muted-foreground")}>
      {status === "ACTIVE" && <BadgeCheck className="size-3" aria-hidden />}
      {visibilityStatusCopy(status).label}
    </Badge>
  );
}

/** Multi-select chip group (aria-pressed toggles; house styling). */
function ChipToggleGroup({
  options,
  selected,
  onToggle,
  ariaLabel,
  disabled,
}: {
  options: readonly { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const isOn = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={isOn}
            disabled={disabled}
            onClick={() => onToggle(o.value)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              isOn
                ? "border-primary/50 bg-gold-soft font-medium text-primary"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- view

export default function OxCandidateProfileView() {
  // ----- loaded data
  const [profile, setProfile] = useState<CandidateProfileDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentConsents, setCurrentConsents] = useState<CurrentConsentMap | null>(null);
  const [consentHistory, setConsentHistory] = useState<ConsentLedgerRowDTO[]>([]);
  const [professions, setProfessions] = useState<ProfessionOption[] | null>(null);

  // ----- editor
  const [form, setForm] = useState<CandidateProfileFormState>(formFromProfile(null));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ----- visibility
  const [busyVisibility, setBusyVisibility] = useState(false);
  const [activateOpen, setActivateOpen] = useState(false);
  const [grantingDiscovery, setGrantingDiscovery] = useState(false);

  // ----- consent actions
  const [consentBusy, setConsentBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ConsentScope | null>(null);

  // ----- profession picker
  const [professionPickerOpen, setProfessionPickerOpen] = useState(false);

  const baselineForm = useMemo(() => formFromProfile(profile), [profile]);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(baselineForm),
    [form, baselineForm]
  );
  const salaryComplete = salaryBlockInputComplete(form);

  // ------------------------------------------------------------ loaders

  const loadProfile = useCallback(async () => {
    const res = await api<{ profile: CandidateProfileDTO | null }>("/api/opportunities/me/profile");
    setProfile(res.profile);
    setForm(formFromProfile(res.profile));
  }, []);

  const loadConsents = useCallback(async () => {
    const res = await api<ConsentsResponse>("/api/opportunities/me/consents");
    setCurrentConsents(res.current);
    setConsentHistory(res.history);
  }, []);

  const loadProfessions = useCallback(async () => {
    // Tree mode: the only shape that exposes the stable Profession.id the
    // profile stores (preferredProfessionIds holds Profession.id values).
    const res = await api<ProfessionTreeResponse>("/api/professions?tree=1");
    setProfessions(
      res.families.flatMap((family) =>
        family.professions.map((p) => ({
          id: p.id,
          slug: p.slug,
          label: p.label,
          group: family.label,
        }))
      )
    );
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    setLoaded(false);
    try {
      // The three reads are independent — load them together.
      await Promise.all([loadProfile(), loadConsents(), loadProfessions()]);
    } catch (err) {
      setLoadError(errText(err));
    } finally {
      setLoaded(true);
    }
  }, [loadProfile, loadConsents, loadProfessions]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------------------ profile save

  async function saveProfile() {
    const patch = buildProfilePatch(form, profile);
    if (patch === null) {
      toast.info("No changes to save");
      return;
    }
    if (!salaryComplete) {
      setFormError("A salary range needs a currency and a period — or clear the range.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await api<{ profile: CandidateProfileDTO }>("/api/opportunities/me/profile", {
        method: "PUT",
        json: patch,
      });
      setProfile(res.profile);
      setForm(formFromProfile(res.profile));
      toast.success("Opportunity profile saved");
    } catch (err) {
      const message = errText(err);
      setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  // ------------------------------------------------------------ visibility

  async function changeVisibility(next: string) {
    setBusyVisibility(true);
    try {
      const res = await api<{ profile: CandidateProfileDTO; changed: boolean }>(
        "/api/opportunities/me/visibility",
        { method: "POST", json: { status: next } }
      );
      setProfile(res.profile);
      setForm(formFromProfile(res.profile));
      toast.success(
        res.changed
          ? next === "ACTIVE"
            ? "Your profile is discoverable"
            : `Visibility set to ${visibilityStatusCopy(next).label.toLowerCase()}`
          : "Visibility was already set"
      );
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusyVisibility(false);
      setActivateOpen(false);
    }
  }

  async function onVisibilityAction(next: string) {
    if (requiresActivationConfirmation(next)) {
      setActivateOpen(true); // explicit confirmation before discoverability
      return;
    }
    await changeVisibility(next);
  }

  // ------------------------------------------------------------ consents

  async function grantConsent(scope: ConsentScope) {
    setConsentBusy(scope);
    try {
      const res = await api<{ consent: ConsentLedgerRowDTO; alreadyCurrent: boolean }>(
        "/api/opportunities/me/consents",
        { method: "POST", json: { scope } }
      );
      await loadConsents();
      if (res.alreadyCurrent) toast.info(`${CONSENT_PURPOSE_COPY[scope].title} is already granted`);
      else toast.success(`${CONSENT_PURPOSE_COPY[scope].title} consent granted`);
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setConsentBusy(null);
    }
  }

  async function revokeConsent(scope: ConsentScope) {
    setConsentBusy(scope);
    try {
      const res = await api<{ revoked: boolean; hidProfile: boolean; consent: ConsentLedgerRowDTO }>(
        `/api/opportunities/me/consents/${scope}/revoke`,
        { method: "POST" }
      );
      await Promise.all([loadConsents(), loadProfile()]);
      if (res.hidProfile) {
        toast.success(`${CONSENT_PURPOSE_COPY[scope].title} revoked — your profile is hidden again`);
      } else {
        toast.success(`${CONSENT_PURPOSE_COPY[scope].title} revoked`);
      }
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setConsentBusy(null);
      setRevokeTarget(null);
    }
  }

  // ------------------------------------------------------------ derived

  const discoveryGranted = currentConsents?.DISCOVERY?.hasCurrentConsent === true;
  const selectedProfessionLabels = form.preferredProfessionIds.map((id) => {
    // Stored values are Profession ids; the picker resolves labels from the
    // same taxonomy it offered. An id the picker never offered (e.g. saved
    // through the API directly) renders as its own id — honest, never faked.
    const match = professions?.find((p) => p.id === id);
    return match?.label ?? id;
  });
  const dirtyCount = useMemo(() => {
    const patch = buildProfilePatch(form, profile);
    return patch ? Object.keys(patch).length : 0;
  }, [form, profile]);

  // ------------------------------------------------------------ states

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your opportunity profile">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={Sparkles}
        title="We couldn't load your opportunity profile"
        description={loadError}
        action={
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }

  // ------------------------------------------------------------ render

  const visibilityCopy = profile ? visibilityStatusCopy(profile.visibilityStatus) : null;

  return (
    <div className="flex flex-col gap-8">
      {/* -------- visibility & discoverability (needs a saved profile) -------- */}
      {profile ? (
        <section aria-labelledby="ox-candidate-visibility-heading">
          <SectionHeader
            title="Visibility &amp; discoverability"
            description="You decide when — and whether — your profile can be found."
            as="h2"
          />
          <h2 id="ox-candidate-visibility-heading" className="sr-only">
            Visibility and discoverability
          </h2>
          <Card className="mt-4">
            <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-gold-soft text-primary">
                    {profile.visibilityStatus === "HIDDEN" ? (
                      <EyeOff className="size-5" aria-hidden />
                    ) : (
                      <Eye className="size-5" aria-hidden />
                    )}
                  </span>
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      {visibilityCopy?.label} {statusPill(profile.visibilityStatus)}
                    </p>
                    <p className="text-sm text-muted-foreground">{visibilityCopy?.description}</p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {profile.visibilityStatus !== "ACTIVE" && (
                  <Button onClick={() => void onVisibilityAction("ACTIVE")} disabled={busyVisibility}>
                    {busyVisibility ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Eye className="size-4" aria-hidden />
                    )}
                    Go discoverable
                  </Button>
                )}
                {profile.visibilityStatus === "ACTIVE" && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => void onVisibilityAction("PAUSED")}
                      disabled={busyVisibility}
                    >
                      <PauseCircle className="size-4" aria-hidden />
                      Pause discovery
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void onVisibilityAction("HIDDEN")}
                      disabled={busyVisibility}
                    >
                      <EyeOff className="size-4" aria-hidden />
                      Hide now
                    </Button>
                  </>
                )}
                {profile.visibilityStatus !== "INVITE_ONLY" && (
                  <Button
                    variant="ghost"
                    onClick={() => void onVisibilityAction("INVITE_ONLY")}
                    disabled={busyVisibility}
                  >
                    <ShieldCheck className="size-4" aria-hidden />
                    Invite-only
                  </Button>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Nothing here is ever public. Discovery is employer-side, consent-gated on every read, and
                revoking the Discovery consent below hides your profile instantly.
              </p>
            </CardContent>
          </Card>
        </section>
      ) : (
        <EmptyState
          icon={Sparkles}
          title="Set up your opportunity profile"
          description="Save your career preferences below to create your private opportunity passport. Creating it never makes you discoverable — visibility stays hidden until you explicitly activate it."
        />
      )}

      {/* -------- career preferences + compensation editor -------- */}
      <section aria-labelledby="ox-candidate-editor-heading">
        <SectionHeader
          title="Your preferences"
          description={profile ? "Changes are saved to your own profile only." : "Your first save creates the profile."}
          as="h2"
        />
        <h2 id="ox-candidate-editor-heading" className="sr-only">
          Career preferences and compensation
        </h2>
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-6 p-4 sm:p-6">
            {/* --- career preferences --- */}
            <div className="flex flex-col gap-4">
              <h3 className="font-display text-base font-semibold">Career preferences</h3>

              <div className="flex flex-col gap-2">
                <Label>Employment types <span className="text-muted-foreground">(up to 5)</span></Label>
                <ChipToggleGroup
                  options={EMPLOYMENT_TYPE_OPTIONS}
                  selected={form.employmentTypes}
                  onToggle={(v) =>
                    setForm((f) => ({
                      ...f,
                      employmentTypes: f.employmentTypes.includes(v)
                        ? f.employmentTypes.filter((x) => x !== v)
                        : f.employmentTypes.length >= 5
                          ? f.employmentTypes
                          : [...f.employmentTypes, v],
                    }))
                  }
                  ariaLabel="Employment types"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label>Work modes <span className="text-muted-foreground">(up to 3)</span></Label>
                <ChipToggleGroup
                  options={WORK_MODE_OPTIONS}
                  selected={form.workModes}
                  onToggle={(v) =>
                    setForm((f) => ({
                      ...f,
                      workModes: f.workModes.includes(v)
                        ? f.workModes.filter((x) => x !== v)
                        : f.workModes.length >= 3
                          ? f.workModes
                          : [...f.workModes, v],
                    }))
                  }
                  ariaLabel="Work modes"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="ox-locations">Preferred locations <span className="text-muted-foreground">(up to 10)</span></Label>
                <TagInput
                  value={form.preferredLocations}
                  onChange={(locations) => setForm((f) => ({ ...f, preferredLocations: locations }))}
                  placeholder="Add a city or “Remote”"
                  max={10}
                  ariaLabel="Add preferred location"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label>Professions <span className="text-muted-foreground">(up to 20)</span></Label>
                <Popover open={professionPickerOpen} onOpenChange={setProfessionPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-between sm:w-80" disabled={!professions}>
                      {form.preferredProfessionIds.length > 0
                        ? `${form.preferredProfessionIds.length} selected`
                        : "Choose professions"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search professions…" />
                      <CommandList>
                        <CommandEmpty>No profession matches.</CommandEmpty>
                        <CommandGroup>
                          {(professions ?? []).map((p) => {
                            const isOn = form.preferredProfessionIds.includes(p.id);
                            return (
                              <CommandItem
                                key={p.id}
                                value={`${p.label} ${p.group}`}
                                onSelect={() =>
                                  setForm((f) => ({
                                    ...f,
                                    preferredProfessionIds: isOn
                                      ? f.preferredProfessionIds.filter((x) => x !== p.id)
                                      : f.preferredProfessionIds.length >= 20
                                        ? f.preferredProfessionIds
                                        : [...f.preferredProfessionIds, p.id],
                                  }))
                                }
                              >
                                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                  <span className="truncate">{p.label}</span>
                                  {isOn && <BadgeCheck className="size-4 shrink-0 text-primary" aria-hidden />}
                                </div>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {selectedProfessionLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedProfessionLabels.map((label) => (
                      <Badge key={label} variant="secondary" className="rounded-full font-normal">
                        {label}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-exp-min">Experience from (years)</Label>
                  <Input
                    id="ox-exp-min"
                    type="number"
                    min={0}
                    max={50}
                    inputMode="numeric"
                    value={form.experienceMinYears}
                    onChange={(e) => setForm((f) => ({ ...f, experienceMinYears: e.target.value }))}
                    placeholder="e.g. 2"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-exp-max">Experience to (years)</Label>
                  <Input
                    id="ox-exp-max"
                    type="number"
                    min={0}
                    max={50}
                    inputMode="numeric"
                    value={form.experienceMaxYears}
                    onChange={(e) => setForm((f) => ({ ...f, experienceMaxYears: e.target.value }))}
                    placeholder="e.g. 8"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-available-from">Available from</Label>
                  <Input
                    id="ox-available-from"
                    type="date"
                    value={form.availableFrom}
                    onChange={(e) => setForm((f) => ({ ...f, availableFrom: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-notice">Notice period (days)</Label>
                  <Input
                    id="ox-notice"
                    type="number"
                    min={0}
                    max={365}
                    inputMode="numeric"
                    value={form.noticePeriodDays}
                    onChange={(e) => setForm((f) => ({ ...f, noticePeriodDays: e.target.value }))}
                    placeholder="e.g. 30"
                  />
                </div>
              </div>
            </div>

            <Separator />

            {/* --- compensation & disclosure --- */}
            <div className="flex flex-col gap-4">
              <h3 className="font-display text-base font-semibold">Compensation &amp; disclosure</h3>

              <div className="flex flex-col gap-2">
                <Label htmlFor="ox-comp-visibility">Who can see your salary range</Label>
                <Select
                  value={form.compensationVisibility}
                  onValueChange={(v) => setForm((f) => ({ ...f, compensationVisibility: v }))}
                >
                  <SelectTrigger id="ox-comp-visibility" className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPENSATION_VISIBILITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {
                    COMPENSATION_VISIBILITY_OPTIONS.find((o) => o.value === form.compensationVisibility)
                      ?.description
                  }
                </p>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-salary-min">Salary range from</Label>
                  <Input
                    id="ox-salary-min"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={form.salaryMinRupees}
                    onChange={(e) => setForm((f) => ({ ...f, salaryMinRupees: e.target.value }))}
                    placeholder={form.salaryCurrency === "INR" ? "in rupees" : "in major units"}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-salary-max">Salary range to</Label>
                  <Input
                    id="ox-salary-max"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={form.salaryMaxRupees}
                    onChange={(e) => setForm((f) => ({ ...f, salaryMaxRupees: e.target.value }))}
                    placeholder={form.salaryCurrency === "INR" ? "in rupees" : "in major units"}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-salary-currency">Currency</Label>
                  <Select
                    value={form.salaryCurrency}
                    onValueChange={(v) => setForm((f) => ({ ...f, salaryCurrency: v }))}
                  >
                    <SelectTrigger id="ox-salary-currency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_OPTIONS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="ox-salary-period">Period</Label>
                  <Select
                    value={form.compensationPeriod}
                    onValueChange={(v) => setForm((f) => ({ ...f, compensationPeriod: v }))}
                  >
                    <SelectTrigger id="ox-salary-period" className="w-full">
                      <SelectValue placeholder="Choose a period" />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPENSATION_PERIOD_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {!salaryComplete && (
                <p role="status" className="text-xs text-yellow-300">
                  A salary range needs both a currency and a period. To remove the range entirely, clear
                  the from/to fields, currency and period.
                </p>
              )}
              {(form.salaryMinRupees || form.salaryMaxRupees) && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <IndianRupee className="size-3.5" aria-hidden />
                  Current range: {formatRupees(rupeesToPaise(form.salaryMinRupees), form.salaryCurrency)} —{" "}
                  {formatRupees(rupeesToPaise(form.salaryMaxRupees), form.salaryCurrency)}{" "}
                  {COMPENSATION_PERIOD_OPTIONS.find((o) => o.value === form.compensationPeriod)?.label ?? ""}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Stored exactly as entered, in minor units. While disclosure is Hidden, no employer sees any
                of it — and your contact details are never part of this profile.
              </p>
            </div>

            {/* --- save --- */}
            {formError && (
              <p role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {formError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p aria-live="polite" className="text-xs text-muted-foreground">
                {saving
                  ? "Saving…"
                  : dirty
                    ? `${dirtyCount} change${dirtyCount === 1 ? "" : "s"} unsaved`
                    : profile
                      ? "All changes saved"
                      : "Nothing saved yet"}
              </p>
              <Button onClick={() => void saveProfile()} disabled={saving || (!dirty && !!profile)}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {profile ? "Save changes" : "Create profile"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* -------- consent purposes (three independent controls) -------- */}
      <section aria-labelledby="ox-candidate-consent-heading">
        <SectionHeader
          title="Consent purposes"
          description="Each purpose is an independent record. Granting one never grants another, and every change is kept in your history."
          as="h2"
        />
        <h2 id="ox-candidate-consent-heading" className="sr-only">
          Consent purposes
        </h2>
        <div className="mt-4 flex flex-col gap-4">
          {CONSENT_SCOPE_ORDER.map((scope) => {
            const copy = CONSENT_PURPOSE_COPY[scope];
            const state = currentConsents?.[scope] ?? { hasCurrentConsent: false, reason: "NO_ROW" };
            const stateCopy = consentStateCopy(state);
            const busy = consentBusy === scope;
            return (
              <Card key={scope}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:p-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{copy.title}</p>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[11px]",
                          state.hasCurrentConsent
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : "border-border text-muted-foreground"
                        )}
                      >
                        {stateCopy.label}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
                    {stateCopy.detail && (
                      <p className="mt-1 text-xs text-muted-foreground">{stateCopy.detail}</p>
                    )}
                    {state.hasCurrentConsent && (() => {
                      const row = consentHistory.find((h) => h.scope === scope && h.status === "GRANTED");
                      return row ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Granted {formatDate(row.grantedAt)} · version {row.consentVersion}
                        </p>
                      ) : null;
                    })()}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {state.hasCurrentConsent ? (
                      <Button
                        variant="outline"
                        onClick={() => setRevokeTarget(scope)}
                        disabled={busy}
                        aria-label={`Revoke ${copy.title} consent`}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => void grantConsent(scope)}
                        disabled={busy}
                        aria-label={`Grant ${copy.title} consent`}
                      >
                        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        Grant
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* ledger history */}
          <Card>
            <CardContent className="p-4 sm:p-6">
              <h3 className="font-display text-base font-semibold">Consent history</h3>
              {consentHistory.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No consent decisions recorded yet. Grants and revocations appear here permanently —
                  history is never overwritten.
                </p>
              ) : (
                <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
                  {consentHistory.map((h) => (
                    <li
                      key={h.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
                    >
                      <span className="font-medium">{CONSENT_PURPOSE_COPY[h.scope as ConsentScope]?.title ?? h.scope}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            h.status === "GRANTED"
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                              : "border-border text-muted-foreground"
                          )}
                        >
                          {h.status === "GRANTED" ? "Granted" : "Revoked"}
                        </Badge>
                        {formatDate(h.grantedAt)}
                        {h.revokedAt ? ` → revoked ${formatDate(h.revokedAt)}` : ""}
                        {h.expiresAt ? ` · expires ${formatDate(h.expiresAt)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      {/* -------- activate-discovery confirmation (explicit, always) -------- */}
      <Dialog open={activateOpen} onOpenChange={setActivateOpen}>
        <DialogContent aria-describedby="ox-activate-description">
          <DialogHeader>
            <DialogTitle>Activate discoverability?</DialogTitle>
            <DialogDescription id="ox-activate-description">
              Verified employers will be able to find your opportunity profile in future discovery
              milestones — your preferences, experience and availability, plus your salary range only as
              your disclosure policy above allows.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            <li>• Requires a current Discovery consent — revoking it hides your profile instantly.</li>
            <li>• Your email, phone and private projects are never part of this profile.</li>
            <li>• You can pause or hide again at any time, one click away.</li>
          </ul>
          {!discoveryGranted && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm">
              <p className="font-medium">Discovery consent is not currently granted.</p>
              <p className="mt-1 text-muted-foreground">
                {consentStateCopy(currentConsents?.DISCOVERY ?? { hasCurrentConsent: false, reason: "NO_ROW" }).detail}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={grantingDiscovery || consentBusy === "DISCOVERY"}
                onClick={async () => {
                  setGrantingDiscovery(true);
                  try {
                    await grantConsent("DISCOVERY");
                  } finally {
                    setGrantingDiscovery(false);
                  }
                }}
              >
                {grantingDiscovery ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Grant Discovery consent
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setActivateOpen(false)}>
              Not now
            </Button>
            <Button onClick={() => void changeVisibility("ACTIVE")} disabled={!discoveryGranted || busyVisibility}>
              {busyVisibility ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Activate discoverability
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* -------- revoke confirmation (truthful impact per purpose) -------- */}
      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent aria-describedby="ox-revoke-description">
          <DialogHeader>
            <DialogTitle>
              Revoke {revokeTarget ? CONSENT_PURPOSE_COPY[revokeTarget].title : ""} consent?
            </DialogTitle>
            <DialogDescription id="ox-revoke-description">
              {revokeTarget ? CONSENT_PURPOSE_COPY[revokeTarget].revokeImpact : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This decision is recorded in your consent history immediately.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
              Keep consent
            </Button>
            <Button
              variant="destructive"
              disabled={consentBusy === revokeTarget}
              onClick={() => revokeTarget && void revokeConsent(revokeTarget)}
            >
              {consentBusy === revokeTarget ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Revoke consent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
