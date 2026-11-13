/**
 * GIFTZ custom domains (contract §7.3) — hostname validation and REAL DNS
 * verification.
 *
 * A domain is VERIFIED only on positive proof observed in public DNS:
 *   - a TXT record exactly `bean-giftz-verification=<token>`, OR
 *   - the hostname resolving (CNAME / A) to the currently-serving host, which
 *     comes exclusively from VERIFIED deployment configuration
 *     (lib/site-url resolveShareOrigin — NEXT_PUBLIC_APP_URL / VERCEL_URL).
 * Verification is never fabricated: NXDOMAIN and DNS lookup failures keep the
 * domain PENDING with the real error in lastError ("not found yet" is not a
 * verification failure), while records that exist but do not match are an
 * honest FAILED. Verification is also explicitly NOT routing — the response
 * carries the honest routingNote.
 */

import { randomBytes } from "crypto";
import { promises as dns } from "node:dns";
import type { GiftzDomain } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveShareOrigin } from "@/lib/site-url";
import { log } from "@/lib/logger";
import { recordGiftzActivity } from "./project-activity";

/** Shown verbatim in the domains UI and returned by the verify route. */
export const DOMAIN_ROUTING_NOTE =
  "DNS verified \u2260 traffic routed; external proxy/DNS configuration is required and is not available in this environment.";

export const HOSTNAME_MAX_LENGTH = 253;

/** Bare DNS name: lowercase letters/digits/hyphens, ≥2 dot-separated labels, no scheme/port/path. */
export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** JSON shape of a GiftzDomain row as returned by the domains routes. */
export interface SerializedDomain {
  id: string;
  hostname: string;
  status: string;
  verificationToken: string;
  verifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export function serializeDomain(row: GiftzDomain): SerializedDomain {
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    verificationToken: row.verificationToken,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export type HostnameValidation =
  | { ok: true; hostname: string }
  | { ok: false; message: string };

/** Normalize + validate one hostname exactly per contract §4/§7.3. */
export function validateHostname(raw: unknown): HostnameValidation {
  if (typeof raw !== "string") {
    return { ok: false, message: "Enter a hostname to connect." };
  }
  const hostname = raw.trim().toLowerCase();
  if (!hostname) {
    return { ok: false, message: "Enter a hostname to connect." };
  }
  if (hostname.length > HOSTNAME_MAX_LENGTH) {
    return { ok: false, message: `Hostnames are limited to ${HOSTNAME_MAX_LENGTH} characters.` };
  }
  if (!HOSTNAME_RE.test(hostname)) {
    return {
      ok: false,
      message:
        "Enter a bare hostname like www.example.com — lowercase letters, digits and hyphens only, no scheme, port, path, underscore or trailing dot.",
    };
  }
  // DNS labels are limited to 63 octets — the regex alone does not enforce it.
  const tooLongLabel = hostname.split(".").find((label) => label.length > 63);
  if (tooLongLabel) {
    return { ok: false, message: `Each dot-separated label must be 63 characters or fewer ("${tooLongLabel}" is too long).` };
  }
  return { ok: true, hostname };
}

/** One-time verification token (hex) — the TXT record is `bean-giftz-verification=<token>`. */
export function newVerificationToken(): string {
  return randomBytes(16).toString("hex");
}

// ------------------------------------------------------------------ DNS check

const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });

type LookupOutcome = "match" | "no-match" | "nxdomain" | "error";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Classify a node:dns rejection: NXDOMAIN ("not found yet"), ENODATA (no such records → no-match) or a real failure. */
function dnsOutcome(e: unknown): { outcome: LookupOutcome; detail: string } {
  const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
    ? (e as { code: string }).code
    : null;
  if (code === "ENOTFOUND") return { outcome: "nxdomain", detail: "NXDOMAIN (hostname does not exist in DNS)" };
  if (code === "ENODATA") return { outcome: "no-match", detail: "no records of the queried type" };
  return { outcome: "error", detail: code ?? (e instanceof Error ? e.message : String(e)) };
}

export type DomainVerifyResult =
  | { ok: true; domain: GiftzDomain; method: "txt" | "address" | null }
  | { ok: false; status: number; message: string };

/**
 * Run the real DNS verification for one domain row and persist the honest
 * outcome. The serving host for the A/CNAME comparison comes ONLY from
 * resolveShareOrigin() (verified deployment configuration) — request headers
 * are never trusted for this.
 */
export async function verifyGiftzDomain(domain: GiftzDomain, userId: string): Promise<DomainVerifyResult> {
  const hostname = normalizeHost(domain.hostname);
  const wanted = `bean-giftz-verification=${domain.verificationToken}`;

  const share = resolveShareOrigin();
  const servingHost = share.ok ? normalizeHost(new URL(share.origin).hostname) : null;

  // --- TXT proof (always checked)
  let txtOutcome: LookupOutcome = "no-match";
  let txtDetail: string | null = null;
  try {
    const records = await resolver.resolveTxt(hostname);
    txtOutcome = records.some((chunks) => chunks.join("") === wanted) ? "match" : "no-match";
    if (txtOutcome === "no-match") txtDetail = `no "bean-giftz-verification=…" TXT record found`;
  } catch (e) {
    const r = dnsOutcome(e);
    txtOutcome = r.outcome;
    txtDetail = `TXT lookup failed: ${r.detail}`;
  }

  // --- A/CNAME proof (only when a VERIFIED serving host exists to compare against)
  let addrOutcome: LookupOutcome | null = null;
  let addrDetail: string | null = null;
  if (servingHost) {
    let cname: LookupOutcome = "no-match";
    let cnameDetail: string | null = null;
    try {
      const names = await resolver.resolveCname(hostname);
      cname = names.some((n) => normalizeHost(n) === servingHost) ? "match" : "no-match";
    } catch (e) {
      const r = dnsOutcome(e);
      cname = r.outcome;
      cnameDetail = `CNAME lookup failed: ${r.detail}`;
    }
    let a: LookupOutcome = "no-match";
    let aDetail: string | null = null;
    try {
      const [ips, serveIps] = await Promise.all([
        resolver.resolve4(hostname),
        resolver.resolve4(servingHost),
      ]);
      a = ips.some((ip) => serveIps.includes(ip)) ? "match" : "no-match";
    } catch (e) {
      const r = dnsOutcome(e);
      a = r.outcome;
      aDetail = `A lookup failed: ${r.detail}`;
    }
    if (cname === "match" || a === "match") {
      addrOutcome = "match";
    } else if (cname === "error" || a === "error") {
      addrOutcome = "error";
      addrDetail = [cnameDetail, aDetail].filter(Boolean).join("; ") || "address lookup failed";
    } else if (cname === "nxdomain" && a === "nxdomain") {
      addrOutcome = "nxdomain";
      addrDetail = "NXDOMAIN (hostname does not exist in DNS)";
    } else {
      addrOutcome = "no-match";
      addrDetail = [cnameDetail, aDetail].filter(Boolean).join("; ") || null;
    }
  }

  // --- decision (never auto-VERIFIED; honest failure vs "not found yet")
  let status: "VERIFIED" | "PENDING" | "FAILED";
  let method: "txt" | "address" | null = null;
  let lastError: string | null = null;

  if (txtOutcome === "match" || addrOutcome === "match") {
    status = "VERIFIED";
    method = txtOutcome === "match" ? "txt" : "address";
  } else {
    const attempted: { outcome: LookupOutcome; detail: string | null }[] = [
      { outcome: txtOutcome, detail: txtDetail },
      ...(addrOutcome !== null ? [{ outcome: addrOutcome, detail: addrDetail }] : []),
    ];
    if (attempted.every((a) => a.outcome === "nxdomain")) {
      // "Not found yet" — the records do not exist; that is honest PENDING.
      status = "PENDING";
      lastError = `DNS lookup returned NXDOMAIN — ${hostname} does not exist yet. Create the records at your DNS provider (TXT "${wanted}" or A/CNAME to the serving host) and verify again.`;
    } else if (attempted.some((a) => a.outcome === "error")) {
      status = "PENDING";
      lastError = `The DNS check could not complete: ${attempted
        .filter((a) => a.outcome === "error")
        .map((a) => a.detail)
        .filter(Boolean)
        .join("; ")}. Try again shortly.`;
    } else if (addrOutcome === null) {
      status = "PENDING";
      lastError = `No "${wanted}" TXT record found on ${hostname}, and A/CNAME comparison is unavailable because no production origin is configured in this environment. Add the TXT record and verify again.`;
    } else {
      status = "FAILED";
      lastError = `${hostname} has DNS records but none match: no "${wanted}" TXT record, and it does not resolve (A/CNAME) to the serving host ${servingHost}.`;
    }
  }

  const updated = await db.giftzDomain.update({
    where: { id: domain.id },
    data: {
      status,
      lastError,
      ...(status === "VERIFIED" ? { verifiedAt: new Date() } : { verifiedAt: null }),
      updatedAt: new Date(),
    },
  });

  await recordGiftzActivity(domain.siteId, userId, "domain.verify", {
    domainId: domain.id,
    hostname: domain.hostname,
    ok: status === "VERIFIED",
    status,
    method,
    error: lastError,
  });
  if (status === "FAILED") {
    log.warn("giftz.domain.verify_failed", { siteId: domain.siteId, hostname: domain.hostname, error: lastError });
  }

  return { ok: true, domain: updated, method };
}
