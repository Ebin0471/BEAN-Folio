"use client";

/**
 * Opportunity Exchange (M-O6) — shared compensation renderer (O0 Part L).
 *
 * Every invitation surface (cards, composer preview, negotiation thread rows
 * and the accepted-terms block) renders compensation prominently through
 * THIS component so the three immutable snapshot classes are always
 * readable: the original offer, each proposal, and the accepted terms.
 *
 * Formatting (plan §10): INR yearly ranges above one lakh rupees render in
 * the `₹12.5 LPA` style; MONTH/HOUR get `₹/mo` / `₹/hr` suffixes; non-INR
 * ISO codes render with the raw currency code. Integer paise only — never
 * floating point; conversion happens at the display edge on values that
 * already crossed the checked O2.1 boundary.
 */

import { cn } from "@/lib/utils";

export interface SalaryRangeProps {
  minPaise: number | null;
  maxPaise: number | null;
  currency: string | null;
  period: string | null;
  className?: string;
}

function groupIndian(digits: string): string {
  // Indian grouping: last 3, then pairs (1,00,000). Non-INR uses plain grouping.
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const parts: string[] = [];
  let i = rest.length;
  while (i > 2) {
    parts.unshift(rest.slice(i - 2, i));
    i -= 2;
  }
  if (i > 0) parts.unshift(rest.slice(0, i));
  return `${parts.join(",")},${last3}`;
}

function formatAmount(paise: number, currency: string, period: string): string {
  const rupees = paise / 100;
  if (currency === "INR" && period === "YEAR" && rupees >= 100_000) {
    const lpa = rupees / 100_000;
    const text = lpa >= 100 ? Math.round(lpa).toString() : (Math.round(lpa * 10) / 10).toString();
    return `₹${text} LPA`;
  }
  const whole = Math.round(rupees);
  const grouped = currency === "INR" ? groupIndian(String(whole)) : whole.toLocaleString("en-US");
  const suffix = period === "MONTH" ? "/mo" : period === "HOUR" ? "/hr" : "/yr";
  return `${currency === "INR" ? "₹" : `${currency} `}${grouped}${suffix}`;
}

export function SalaryRange({ minPaise, maxPaise, currency, period, className }: SalaryRangeProps) {
  if (
    minPaise === null ||
    maxPaise === null ||
    !currency ||
    !period ||
    !Number.isSafeInteger(minPaise) ||
    !Number.isSafeInteger(maxPaise) ||
    minPaise < 0 ||
    maxPaise < minPaise
  ) {
    return <span className={cn("text-sm text-muted-foreground", className)}>Compensation not published</span>;
  }
  if (minPaise === maxPaise) {
    return (
      <span className={cn("font-display text-sm font-semibold text-primary", className)}>
        {formatAmount(minPaise, currency, period)}
      </span>
    );
  }
  return (
    <span className={cn("font-display text-sm font-semibold text-primary", className)}>
      {formatAmount(minPaise, currency, period)} – {formatAmount(maxPaise, currency, period)}
    </span>
  );
}

export default SalaryRange;
