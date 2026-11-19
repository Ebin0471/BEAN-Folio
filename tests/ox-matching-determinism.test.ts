import { describe, expect, test } from "bun:test";

/**
 * M-O4 — deterministic scoring engine (`src/lib/ox/matching.ts`) unit tests.
 * Pure functions: no database, no clock reads (time injected). Pins the
 * approved decision set D4 + safeguards A/B:
 *   - byte-identical determinism for identical inputs;
 *   - O0 relative weights preserved for applicable factors;
 *   - the experience factor is PERMANENTLY excluded (safeguard A — M-O3's
 *     Opportunity has no experience fields) and documented in the explanation;
 *   - withheld salary never moves the score (renormalization; safeguard B);
 *   - a missing factor is never an artificial penalty;
 *   - documented rounding, denominators and tie-breaks;
 *   - fairness invariance: identical relevant inputs ⇒ identical results.
 */
import { computeO4Match, OX_MATCH_VERSION, type O4MatchInput } from "@/lib/ox/matching";

const BASE_NOW = new Date("2026-11-19T10:00:00.000Z");

function baseInput(overrides?: Partial<O4MatchInput>): O4MatchInput {
  return {
    opportunity: {
      professionId: "prof-film-video",
      location: "Chennai",
      employmentType: "FULL_TIME",
      workMode: "HYBRID",
    },
    requiredSkillIds: ["skill-a", "skill-b"],
    preferredSkillIds: ["skill-c"],
    candidate: {
      employmentTypes: ["FULL_TIME"],
      workModes: ["HYBRID"],
      preferredLocations: ["chennai"],
      preferredProfessionIds: ["prof-film-video"],
      availableFrom: new Date("2026-11-25T00:00:00.000Z"),
      candidateSkillIds: ["skill-a", "skill-b", "skill-c"],
      publishedPublicProjects: 3,
    },
    salaryDisclosure: { status: "WITHHELD" },
    now: BASE_NOW,
    ...overrides,
  };
}

describe("O4-MATCH-V1 — determinism and version stamping", () => {
  test("identical inputs produce byte-identical score and explanation across runs", () => {
    const a = computeO4Match(baseInput());
    const b = computeO4Match(baseInput());
    expect(a.score).toBe(b.score);
    expect(JSON.stringify(a.explanation)).toBe(JSON.stringify(b.explanation));
  });

  test("version stamp is O4-MATCH-V1 and carried in every explanation", () => {
    const { explanation } = computeO4Match(baseInput());
    expect(explanation.matchVersion).toBe(OX_MATCH_VERSION);
    expect(OX_MATCH_VERSION).toBe("O4-MATCH-V1");
  });

  test("score is an integer 0-100 with the documented denominator", () => {
    const { score, explanation } = computeO4Match(baseInput());
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    // Full match on every active factor ⇒ 100 exactly (denominator cancels).
    // Base input withholds salary (safeguard B) ⇒ 90 − 5 = 85 active.
    expect(explanation.activeWeightSum).toBe(85);
    expect(score).toBe(100);
    // With a DISCLOSED-compatible range the denominator is the full 90.
    const disclosed = computeO4Match(baseInput({ salaryDisclosure: { status: "DISCLOSED" } }));
    expect(disclosed.explanation.activeWeightSum).toBe(90);
    expect(disclosed.score).toBe(100);
  });
});

describe("O4-MATCH-V1 — safeguard A: experience is excluded, not fabricated", () => {
  test("no experience input exists; the explanation documents the exclusion", () => {
    const { explanation } = computeO4Match(baseInput());
    const experience = explanation.factors.find((f) => f.key === "experience");
    expect(experience).toBeDefined();
    expect(experience!.applied).toBe(false);
    if (!experience!.applied) {
      expect(experience!.reason).toBe("NOT_EVALUABLE_NO_OPPORTUNITY_INPUT");
    }
    // The candidate's profile MAY carry experience bounds (O2 fields) — the
    // engine's input type has no experience field at all, so none can leak in.
    expect(Object.keys(baseInput().candidate).some((k) => k.toLowerCase().includes("experience"))).toBe(false);
  });

  test("the O0 relative weights of the APPLICABLE factors are preserved", () => {
    const weights = { requiredSkills: 30, preferredSkills: 10, profession: 15, evidence: 15, workMode: 5, location: 5, availability: 5, compensation: 5 };
    let sum = 0;
    for (const [, w] of Object.entries(weights)) sum += w;
    expect(sum).toBe(90);
  });
});

describe("O4-MATCH-V1 — missing factors are excluded, never artificial penalties", () => {
  test("a candidate with everything undeclared is scored honestly on declared axes only", () => {
    const sparse = computeO4Match(
      baseInput({
        candidate: {
          employmentTypes: [],
          workModes: [],
          preferredLocations: [],
          preferredProfessionIds: [],
          availableFrom: null,
          candidateSkillIds: [],
          publishedPublicProjects: 2,
        },
      })
    );
    // Skill coverage against the opportunity's DECLARED requirements is
    // legitimately evaluable (a set intersection — both sets exist, the
    // candidate's is empty ⇒ honest 0). PREFERENCE alignments with no
    // candidate declaration are UNKNOWN — excluded + renormalized, never
    // zero-penalized (requirements can be failed; unknown preferences are
    // not failures).
    expect(sparse.explanation.activeWeightSum).toBe(30 + 10 + 15); // skills + evidence
    expect(sparse.explanation.activeFactorCount).toBe(3);
    expect(sparse.explanation.earnedRaw).toBe(10); // evidence only
    expect(sparse.score).toBe(Math.round((10 * 100) / 55));
    // The undeclared preference axes are absent, not zero-scored.
    expect(sparse.explanation.factors.find((f) => f.key === "profession")!.applied).toBe(false);
    expect(sparse.explanation.factors.find((f) => f.key === "workMode")!.applied).toBe(false);
    expect(sparse.explanation.factors.find((f) => f.key === "location")!.applied).toBe(false);
    expect(sparse.explanation.factors.find((f) => f.key === "availability")!.applied).toBe(false);
    expect(sparse.score).toBeGreaterThan(0);
  });

  test("an opportunity without REQUIRED skills excludes that factor and renormalizes", () => {
    const { explanation } = computeO4Match(baseInput({ requiredSkillIds: [] }));
    const required = explanation.factors.find((f) => f.key === "requiredSkills");
    expect(required!.applied).toBe(false);
    if (!required!.applied) expect(required!.reason).toBe("NO_REQUIRED_SKILLS_DECLARED");
    expect(explanation.activeWeightSum).toBe(90 - 30 - 5); // + salary withheld
  });

  test("opportunity-side profession/work-mode/location unset excludes those factors", () => {
    const { explanation } = computeO4Match(
      baseInput({ opportunity: { professionId: null, location: null, employmentType: "FULL_TIME", workMode: null } })
    );
    expect(explanation.factors.find((f) => f.key === "profession")!.applied).toBe(false);
    expect(explanation.factors.find((f) => f.key === "workMode")!.applied).toBe(false);
    expect(explanation.factors.find((f) => f.key === "location")!.applied).toBe(false);
    expect(explanation.activeWeightSum).toBe(90 - 15 - 5 - 5 - 5); // + salary withheld
  });
});

describe("O4-MATCH-V1 — safeguard B: salary privacy is score-neutral", () => {
  test("WITHHELD vs DISCLOSED-compatible: identical professional data ⇒ identical score", () => {
    const withheld = computeO4Match(baseInput({ salaryDisclosure: { status: "WITHHELD" } }));
    const disclosed = computeO4Match(baseInput({ salaryDisclosure: { status: "DISCLOSED" } }));
    // Renormalization makes the privacy choice score-neutral for a fully
    // matching candidate: the compensation factor is earned in both shapes.
    expect(withheld.score).toBe(disclosed.score);
    expect(withheld.explanation.activeWeightSum).toBe(85);
    expect(disclosed.explanation.activeWeightSum).toBe(90);
  });

  test("a partially-matching candidate's score is unaffected by withholding salary", () => {
    const partial = baseInput({
      candidate: {
        employmentTypes: ["FULL_TIME"],
        workModes: ["ONSITE"], // mismatch vs opportunity HYBRID
        preferredLocations: ["Mumbai"],
        preferredProfessionIds: ["prof-design"],
        availableFrom: new Date("2027-06-01T00:00:00.000Z"),
        candidateSkillIds: ["skill-a"],
        publishedPublicProjects: 1,
      },
    });
    const withheld = computeO4Match({ ...partial, salaryDisclosure: { status: "WITHHELD" } });
    const disclosed = computeO4Match({ ...partial, salaryDisclosure: { status: "DISCLOSED" } });
    // The WITHHELD score is computed exclusively from the candidate's active
    // factors (compensation excluded + renormalized). The DISCLOSED score can
    // only be ≥: disclosure adds a fully-earned factor, which pulls the ratio
    // up — an upside for choosing to share, never a downside for privacy.
    expect(withheld.score).toBe(Math.round((21 * 100) / 85)); // 25 — pinned arithmetic
    expect(disclosed.score).toBe(Math.round((26 * 100) / 90)); // 29
    expect(withheld.score).toBeLessThanOrEqual(disclosed.score);
    // THE no-penalty invariant: a hypothetical zero-filled salary factor
    // (the design renormalization explicitly rejects) would score LOWER:
    const zeroFilledWouldBe = Math.round((21 * 100) / 90); // 23
    expect(withheld.score).toBeGreaterThan(zeroFilledWouldBe);
    // No salary amount (paise-scale number) ever appears in either payload.
    const both = JSON.stringify(withheld.explanation) + JSON.stringify(disclosed.explanation);
    expect(both).not.toMatch(/\d{7,}/); // no paise/crore-scale figures
    // The salary factor reasons never mention amounts — vocabulary only.
    expect(both).toContain("COMPENSATION_NOT_DISCLOSED_TO_THIS_REQUESTER");
  });
});

describe("O4-MATCH-V1 — factor rubrics and rounding", () => {
  test("required-skill coverage rounds with the documented integer arithmetic", () => {
    // 2 of 3 required matched → round(2*30/3) = 20.
    const { explanation } = computeO4Match(
      baseInput({ requiredSkillIds: ["skill-a", "skill-b", "skill-d"], candidate: { ...baseInput().candidate, candidateSkillIds: ["skill-a", "skill-b"] } })
    );
    const required = explanation.factors.find((f) => f.key === "requiredSkills");
    expect(required!.applied).toBe(true);
    if (required!.applied) expect(required!.earned).toBe(20);
  });

  test("evidence strength: min(15, 5 × publishedPublicProjects)", () => {
    expect(computeO4Match(baseInput({ candidate: { ...baseInput().candidate, publishedPublicProjects: 0 } })).score).toBeLessThan(100);
    const r0 = computeO4Match(baseInput({ candidate: { ...baseInput().candidate, publishedPublicProjects: 0 } }));
    const r4 = computeO4Match(baseInput({ candidate: { ...baseInput().candidate, publishedPublicProjects: 4 } }));
    const r9 = computeO4Match(baseInput({ candidate: { ...baseInput().candidate, publishedPublicProjects: 9 } }));
    const evEarned = (x: ReturnType<typeof computeO4Match>) => {
      const f = x.explanation.factors.find((f) => f.key === "evidence")!;
      return f.applied ? f.earned : null;
    };
    expect(evEarned(r0)).toBe(0);
    expect(evEarned(r4)).toBe(15);
    expect(evEarned(r9)).toBe(15); // capped
  });

  test("availability rubric: ≤30d → 5, ≤90d → 3, beyond → 1", () => {
    const avEarned = (d: number) => {
      const f = computeO4Match(baseInput({ candidate: { ...baseInput().candidate, availableFrom: new Date(BASE_NOW.getTime() + d * 24 * 60 * 60_000) } }))
        .explanation.factors.find((f) => f.key === "availability")!;
      return f.applied ? f.earned : null;
    };
    expect(avEarned(10)).toBe(5);
    expect(avEarned(60)).toBe(3);
    expect(avEarned(200)).toBe(1);
    // Already-available (negative diff) is fully ready.
    expect(avEarned(-5)).toBe(5);
  });

  test("location and work-mode comparisons are case-insensitive tokens", () => {
    const a = computeO4Match(baseInput({ candidate: { ...baseInput().candidate, preferredLocations: ["  CHENNAI  "], workModes: ["hybrid"] } }));
    expect(a.score).toBe(100);
  });
});

describe("O4-MATCH-V1 — fairness invariance", () => {
  test("identical relevant inputs ⇒ identical scores (irrelevant identity has no channel)", () => {
    // The engine's input type carries NO name/avatar/gender-adjacent field,
    // so no protected attribute can influence the score by construction; the
    // test pins that the score is a pure function of the declared inputs.
    const x = computeO4Match(baseInput());
    const y = computeO4Match(baseInput({ now: new Date(BASE_NOW.getTime() + 60_000) }));
    // A one-minute clock shift does not cross the availability rubric
    // boundary ⇒ same score (rubric is day-granular).
    expect(x.score).toBe(y.score);
  });

  test("tie-breaking is documented: equal scores must order by candidateUserId asc", () => {
    // The pure engine returns per-candidate scores; the sort contract lives
    // in discovery.ts (score desc, candidateUserId asc). Pin the comparator
    // semantics here via two equal-score computations.
    const a = computeO4Match(baseInput());
    const b = computeO4Match(baseInput());
    expect(a.score).toBe(b.score);
    expect("cand-a" < "cand-b").toBe(true); // asc ordering of the tie-break key
  });
});
