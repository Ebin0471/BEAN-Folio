/**
 * LAXII — daily cost guardrail helpers (Phase 3).
 *
 * Extracted from the generate route so the banner pipeline can honor the SAME
 * budget before each refinement attempt (spec §5: respect cost and time limits;
 * spec §8: enforce the existing cost ledger and daily budget). The numbers are
 * documented ESTIMATES recorded per generation — never billed amounts.
 */

import { db } from "@/lib/db";

export function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function dailyCostLimitCents(): number {
  const raw = Number(process.env.INTELLIGENCE_DAILY_COST_LIMIT_USD);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : 500; // default $5.00/day
}

/** Sum of today's documented cost ESTIMATES for one user's LAXII usage. */
export async function laxiiSpentTodayCents(userId: string): Promise<number> {
  const agg = await db.laxiiUsage.aggregate({
    where: { userId, createdAt: { gte: startOfUtcDay() } },
    _sum: { costEstimateCents: true },
  });
  return agg._sum.costEstimateCents ?? 0;
}

/**
 * Whether one more engine call still fits inside the daily estimate budget.
 * Unmetered engines (cost 0) never exhaust the budget.
 */
export async function budgetAllowsAnotherCall(userId: string, nextCallEstimateUsd: number): Promise<boolean> {
  const next = Math.max(0, Math.round(nextCallEstimateUsd * 100));
  if (next === 0) return true;
  const spent = await laxiiSpentTodayCents(userId);
  return spent + next <= dailyCostLimitCents();
}
