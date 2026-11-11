"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronLeft, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  const [step, setStep] = useState<1 | 2>(1);
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
          Two quick steps. Everything here can be changed later in your settings.
        </p>
      </header>

      {/* progress indicator */}
      <div className="mb-6" aria-hidden>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Step {step} of 2</span>
          <span>{step === 1 ? "Who you are" : "Your craft"}</span>
        </div>
        <div className="mt-2 flex gap-2">
          <div className={cn("h-1 flex-1 rounded-full transition-colors", step >= 1 ? "bg-primary" : "bg-muted")} />
          <div className={cn("h-1 flex-1 rounded-full transition-colors", step >= 2 ? "bg-primary" : "bg-muted")} />
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
        ) : (
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
              <Button onClick={() => void submit()} disabled={busy || taxLoading} className="h-11 min-w-40">
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
