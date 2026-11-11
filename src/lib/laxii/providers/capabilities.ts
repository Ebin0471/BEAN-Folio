import type { LaxiiRequest, ProviderCapabilities } from "../types";
import { LaxiiError } from "../types";
import { managedProvider } from "./managed";
import { diffusersProvider } from "./diffusers";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";

/**
 * LAXII provider router (§Phase 2D of the creative-studio spec).
 *
 * The frontend NEVER talks to a provider directly — it talks to LAXII API
 * routes, which route through here. Changing providers is a server-side
 * configuration concern (env vars + LAXII_DEFAULT_PROVIDER); the UI adapts
 * via the capability registry below so it only offers operations the
 * selected provider genuinely supports.
 */

export const PROVIDERS: Record<string, import("../types").ImageProvider> = {
  managed: managedProvider,
  diffusers: diffusersProvider,
  gemini: geminiProvider,
  openai: openaiProvider,
};

export type ProviderKind = "managed-api" | "local-gpu" | "external-paid";

export interface ProviderDescriptor {
  id: keyof typeof PROVIDERS;
  label: string;
  kind: ProviderKind;
  available: boolean;
  reason?: string;
  capabilities: ProviderCapabilities;
  /** True when this provider is the deployment default (LAXII_DEFAULT_PROVIDER). */
  isDefault: boolean;
}

export const DEFAULT_PROVIDER_ENV = () => {
  const v = process.env.LAXII_DEFAULT_PROVIDER?.trim().toLowerCase();
  return v && v in PROVIDERS ? v : "auto";
};

/**
 * Resolve the provider to actually run, honoring the request preference.
 * "auto" order: local GPU stack (when truly present) → configured default
 * (LAXII_DEFAULT_PROVIDER) → managed → first available external provider.
 */
export async function resolveProvider(pref: LaxiiRequest["provider"]): Promise<import("../types").ImageProvider> {
  const wanted = pref ?? "auto";

  if (wanted !== "auto") {
    const p = PROVIDERS[wanted];
    if (!p) throw new LaxiiError(`Unknown provider "${wanted}"`);
    const av = await p.available();
    if (!av.ok) throw new LaxiiError(`${p.label} is not available: ${av.reason ?? "unavailable"}`);
    return p;
  }

  const localAv = await diffusersProvider.available();
  if (localAv.ok) return diffusersProvider;

  const configured = DEFAULT_PROVIDER_ENV();
  if (configured !== "auto" && PROVIDERS[configured]) {
    const av = await PROVIDERS[configured].available();
    if (av.ok) return PROVIDERS[configured];
  }

  const managedAv = await managedProvider.available();
  if (managedAv.ok) return managedProvider;

  for (const id of ["gemini", "openai"]) {
    const av = await PROVIDERS[id].available();
    if (av.ok) return PROVIDERS[id];
  }

  throw new LaxiiError(
    `No image provider is available (local GPU: ${localAv.reason ?? "unavailable"}; managed: ${managedAv.reason ?? "unavailable"}; gemini: ${await reasonOf("gemini")}; openai: ${await reasonOf("openai")})`
  );
}

async function reasonOf(id: string): Promise<string> {
  const av = await PROVIDERS[id]?.available();
  return av?.ok ? "available" : (av?.reason ?? "unavailable");
}

/** Full registry for the UI (availability probed at request time, server-side). */
export async function providerRegistry(): Promise<ProviderDescriptor[]> {
  const def = DEFAULT_PROVIDER_ENV();
  const out: ProviderDescriptor[] = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const av = await p.available();
    out.push({
      id: id as ProviderDescriptor["id"],
      label: p.label,
      kind: id === "managed" ? "managed-api" : id === "diffusers" ? "local-gpu" : "external-paid",
      available: av.ok,
      reason: av.ok ? undefined : av.reason,
      capabilities: p.getCapabilities(),
      isDefault: id === def || (def === "auto" && id === "managed"),
    });
  }
  return out;
}
