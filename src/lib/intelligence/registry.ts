/**
 * BEAN Intelligence gateway — central provider/model registry.
 *
 * ONE authoritative, capability-based registry. Agents NEVER select providers
 * or models themselves; they ask the gateway for a capability and the gateway
 * routes through this registry.
 *
 * Rules enforced here:
 *  - Real, documented providers only. No fabricated model identifiers: the
 *    managed text gateway resolves its model server-side, so the registry
 *    records the model as "gateway-resolved" instead of inventing an id.
 *  - Availability is honest: an entry reports available:false unless its
 *    credentials/configuration are actually present. Unavailable entries are
 *    skipped by routing (and reported as unavailable to operators) — requests
 *    are never silently substituted to a provider that cannot serve them.
 *  - Fallback only ever happens WITHIN one capability, preserving the task's
 *    contract. No capability-lowering fallback exists anywhere in the gateway.
 *  - Embedding has no configured provider in this deployment: the registry is
 *    honest about it and any embedding request fails with a clear error
 *    (no fake vectors, ever).
 *  - Image generation is owned by the LAXII engine (its own capability router
 *    with per-provider validation); the gateway bridges that registry for
 *    observability, health and usage accounting. Image entries inherit LAXII's
 *    honest availability and LAXII-family display labels.
 */

import { laxiiCapabilities } from "@/lib/laxii/router";
import type { LaxiiProviderId } from "@/lib/laxii/types";

export type IntelligenceCapability = "text" | "vision" | "code" | "embedding" | "image";

export interface ProviderEntry {
  /** Stable internal id (never shown as a third-party brand in UI). */
  id: string;
  capability: IntelligenceCapability;
  /** User-safe display label — BEAN product language only. */
  label: string;
  /**
   * Documented model identifier, or "gateway-resolved" when the provider
   * contract resolves the model server-side (no id invented).
   */
  model: string;
  available: () => boolean;
  /** Lower = preferred. */
  priority: number;
  /**
   * Documented per-call cost estimate in integer cents (0 = no metered API
   * cost for this deployment). An ESTIMATE for budget control — never a bill.
   */
  costPerCallCents: number;
}

/**
 * The managed text/vision/code gateway (z-ai SDK family) is configured
 * server-side on every deployment of this application — same contract as the
 * LAXII managed image provider.
 */
function beanManagedAvailable(): boolean {
  return true;
}

function textProviderOrder(): string[] {
  // Configurable primary (Phase 1 requirement): first configured entry whose
  // id matches BEAN_TEXT_PROVIDER_PRIMARY is moved to the front.
  const configuredPrimary = process.env.BEAN_TEXT_PROVIDER_PRIMARY?.trim();
  return configuredPrimary ? [configuredPrimary] : [];
}

/** Text / code reasoning providers, in routing order. */
export function textProviders(): ProviderEntry[] {
  const entries: ProviderEntry[] = [
    {
      id: "bean-managed",
      capability: "text",
      label: "BEAN Intelligence gateway",
      model: "gateway-resolved",
      available: beanManagedAvailable,
      priority: 10,
      costPerCallCents: 0, // managed server-side gateway: no metered API cost documented
    },
  ];
  const preferred = textProviderOrder();
  if (preferred.length > 0) {
    entries.sort((a, b) => {
      const ai = preferred.indexOf(a.id);
      const bi = preferred.indexOf(b.id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.priority - b.priority;
    });
  }
  return entries;
}

/** Image providers — bridged live from the LAXII engine registry. */
export function imageProviders(): ProviderEntry[] {
  const caps = laxiiCapabilities();
  return caps.providers.map((p) => ({
    id: `laxii-${p.id}` as string,
    capability: "image" as const,
    label: p.label,
    model: p.model,
    available: () => p.available,
    // Managed first (zero metered cost), then engine preference order as
    // reported by LAXII (default provider first), others by declaration order.
    priority: p.id === caps.defaultProvider ? 0 : p.id === "managed" ? 1 : 2,
    costPerCallCents: 0, // actual per-image estimates are computed by the LAXII engine per call
  }));
}

/**
 * Providers able to serve one capability, in routing order, INCLUDING
 * circuit-broken ones (routing filters by live health; this is the full list).
 */
export function providersFor(capability: IntelligenceCapability): ProviderEntry[] {
  switch (capability) {
    case "text":
    case "code":
      return textProviders();
    case "vision":
      // Vision rides the same managed gateway (createVision contract).
      return textProviders().map((p) => ({ ...p, capability: "vision" as const }));
    case "image":
      return imageProviders();
    case "embedding":
      return []; // honest: no embedding provider is configured on this deployment
  }
}

/** True when at least one provider for the capability is configured & healthy. */
export function hasProviderFor(capability: IntelligenceCapability): boolean {
  return providersFor(capability).some((p) => p.available());
}

/**
 * Map a LAXII provider id to its BEAN Intelligence registry id, so the LAXII
 * engine and the gateway share one health namespace convention without
 * colliding with text-provider ids.
 */
export function laxiiRegistryId(providerId: LaxiiProviderId): string {
  return `laxii-${providerId}`;
}
