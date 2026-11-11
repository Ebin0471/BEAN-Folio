"use client";

import { useEffect, useState } from "react";

import { CATEGORY_LABELS } from "@/lib/categories";
import { api } from "@/lib/client";

export interface ProfessionOption {
  slug: string;
  label: string;
}

/**
 * Live category taxonomy from the Profession table (the single source of
 * truth). Falls back to the static map while loading or offline — the fallback
 * mirrors the same canonical slugs, so options never disagree with the server.
 * The fallback covers the full Universal Profession Taxonomy: the 18 legacy
 * entries first (original order), then the new professions by family.
 */
export function useProfessionOptions(): ProfessionOption[] {
  const [options, setOptions] = useState<ProfessionOption[]>(() =>
    Object.entries(CATEGORY_LABELS).map(([slug, label]) => ({ slug, label }))
  );

  useEffect(() => {
    let alive = true;
    api<{ professions: ProfessionOption[] }>("/api/professions")
      .then((r) => {
        if (alive && r.professions.length > 0) setOptions(r.professions);
      })
      .catch(() => undefined); // offline fallback is already correct
    return () => {
      alive = false;
    };
  }, []);

  return options;
}
