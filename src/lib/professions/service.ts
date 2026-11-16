/**
 * Profession taxonomy service — DB sync + queries for the Universal Profession
 * Taxonomy. The single source of truth for the DATA is ./taxonomy.ts; this
 * module is the single source of truth for DB sync, querying, and caching.
 *
 * Caching contract (src/lib/cache.ts — synchronous in-memory cache):
 * - Key prefix "professions:" (via cacheKey), TTL 5 minutes.
 * - Every professions cache entry is tagged "professions.changed"; mutation
 *   paths (syncTaxonomyToDb) invalidate via cacheInvalidateEvent.
 * - cacheGet stamps object values with a `_cachedAt` debug field — this module
 *   keeps it out of API payloads (arrays are never stamped; the one cached
 *   object shape, ProfessionDetail, is stripped on the way out).
 *
 * Backward compatibility:
 * - listFlat() returns exactly the legacy API item shape { slug, label, group }.
 * - Flat ordering preserves the pre-expansion response: the 18 legacy rows
 *   first in their historical order 1..18, then new professions by family
 *   order then row order (legacy rows also lead their family block in the
 *   tree view, where they hold lower order values).
 * - Legacy rows are never deleted or renamed; only additive updates happen.
 */

import { db } from "@/lib/db";
import {
  cacheGetShared,
  cacheSetShared,
  cacheDeleteShared,
  cacheInvalidateEventShared,
  cacheKey,
} from "@/lib/cache";
import { PROFESSION_FAMILIES, LEGACY_PROFESSIONS } from "./taxonomy";

const PROFESSIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const PROFESSIONS_CHANGED_EVENT = "professions.changed";

/** New professions start below this order value so legacy rows (1..18) lead. */
const NEW_PROFESSION_ORDER_BASE = 20;

const LEGACY_BY_SLUG = new Map(LEGACY_PROFESSIONS.map((l) => [l.slug, l]));

// ---------- Shapes ----------

/** Byte-compatible with the legacy GET /api/professions item shape. */
export interface FlatProfession {
  slug: string;
  label: string;
  group: string;
}

export interface ProfessionSpecialism {
  slug: string;
  label: string;
  order: number;
}

export interface ProfessionDetail {
  slug: string;
  label: string;
  group: string;
  description: string | null;
  aliases: string[];
  order: number;
  active: boolean;
  family: { slug: string; label: string } | null;
  specialisms: ProfessionSpecialism[];
}

export interface TreeProfession {
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  order: number;
  specialisms: { slug: string; label: string }[];
}

export interface TreeFamily {
  slug: string;
  label: string;
  description: string | null;
  order: number;
  professions: TreeProfession[];
}

export interface SyncResult {
  families: number;
  professions: number;
  specialisms: number;
}

// ---------- Helpers ----------

/** Normalize user-supplied slug input: trim, lowercase, whitespace → hyphen. */
export function normalizeProfessionSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Normalize + dedupe a list of profession slugs, dropping empties. */
export function normalizeProfessionSlugs(slugs: string[]): string[] {
  return Array.from(new Set(slugs.map(normalizeProfessionSlug).filter(Boolean)));
}

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Remove the cache module's `_cachedAt` debug field from a cached object. */
function withoutCacheDebug<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "_cachedAt" in (value as object)) {
    const copy = { ...(value as Record<string, unknown>) };
    delete copy._cachedAt;
    return copy as T;
  }
  return value;
}

// ---------- Sync ----------

/**
 * Idempotent upsert of families → professions → specialisms from taxonomy.ts.
 * - Matches by slug (upsert), so existing row IDs are preserved.
 * - NEVER deletes rows (legacy rows survive even if removed from the seed).
 * - Sets active=true for every seeded row; assigns familySlug.
 * - Legacy rows keep their historical group + order (1..18); new professions
 *   get the family label as flat group and orders from 20.
 * Safe to run repeatedly (seed script, first-request bootstrap).
 */
export async function syncTaxonomyToDb(): Promise<SyncResult> {
  let professionCount = 0;
  let specialismCount = 0;

  await db.$transaction(
    async (tx) => {
      for (const family of PROFESSION_FAMILIES) {
        await tx.professionFamily.upsert({
          where: { slug: family.slug },
          create: {
            slug: family.slug,
            label: family.label,
            description: family.description,
            order: family.order,
          },
          update: {
            label: family.label,
            description: family.description,
            order: family.order,
          },
        });

        let newOrder = 0;
        for (const seed of family.professions) {
          const legacy = LEGACY_BY_SLUG.get(seed.slug);
          const order = legacy ? legacy.order : NEW_PROFESSION_ORDER_BASE + newOrder++;
          const group = legacy?.group ?? family.label;
          const aliases = seed.aliases ? JSON.stringify(seed.aliases) : null;

          await tx.profession.upsert({
            where: { slug: seed.slug },
            create: {
              slug: seed.slug,
              label: seed.label,
              group,
              order,
              familySlug: family.slug,
              description: seed.description,
              aliases,
              active: true,
            },
            update: {
              label: seed.label,
              group,
              order,
              familySlug: family.slug,
              description: seed.description,
              aliases,
              active: true,
            },
          });
          professionCount += 1;

          const specialisms = seed.specialisms ?? [];
          for (let i = 0; i < specialisms.length; i++) {
            const spec = specialisms[i];
            await tx.specialism.upsert({
              where: { slug: spec.slug },
              create: {
                slug: spec.slug,
                professionSlug: seed.slug,
                label: spec.label,
                order: i + 1,
              },
              update: {
                professionSlug: seed.slug,
                label: spec.label,
                order: i + 1,
              },
            });
            specialismCount += 1;
          }
        }
      }
    },
    { timeout: 30_000, maxWait: 10_000 }
  );

  await cacheInvalidateEventShared(PROFESSIONS_CHANGED_EVENT);

  return {
    families: PROFESSION_FAMILIES.length,
    professions: professionCount,
    specialisms: specialismCount,
  };
}

// ---------- Queries ----------

/**
 * Active professions in flat-list order: the 18 LEGACY rows FIRST in their
 * historical order 1..18 (byte-compatible with the pre-expansion route's
 * `orderBy: { order: "asc" }` — existing UI dropdowns keep their exact
 * sequence), then every new profession grouped by family order, then row
 * order, then slug for determinism.
 */
async function loadActiveProfessionsSorted() {
  const [rows, families] = await Promise.all([
    db.profession.findMany({ where: { active: true } }),
    db.professionFamily.findMany({ select: { slug: true, order: true } }),
  ]);
  const familyOrder = new Map(families.map((f) => [f.slug, f.order]));
  return rows.sort((a, b) => {
    const aLegacy = LEGACY_BY_SLUG.has(a.slug);
    const bLegacy = LEGACY_BY_SLUG.has(b.slug);
    if (aLegacy !== bLegacy) return aLegacy ? -1 : 1; // legacy block leads
    if (aLegacy && bLegacy) return a.order - b.order; // historical 1..18
    return (
      (familyOrder.get(a.familySlug ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (familyOrder.get(b.familySlug ?? "") ?? Number.MAX_SAFE_INTEGER) ||
      a.order - b.order ||
      a.slug.localeCompare(b.slug)
    );
  });
}

/**
 * Flat list in the legacy API shape ({ slug, label, group }), active only.
 * Cached under "professions:flat". If the table is completely empty (fresh
 * deploy), seeds the taxonomy first — preserving the legacy seed-on-read
 * behavior of GET /api/professions.
 */
export async function listFlat(): Promise<FlatProfession[]> {
  const key = cacheKey("professions", "flat");
  const cached = await cacheGetShared<FlatProfession[]>(key);
  if (cached) return cached;

  let rows = await loadActiveProfessionsSorted();
  if (rows.length === 0) {
    await syncTaxonomyToDb().catch(() => undefined);
    rows = await loadActiveProfessionsSorted();
  }

  const flat: FlatProfession[] = rows.map((r) => ({ slug: r.slug, label: r.label, group: r.group }));
  await cacheSetShared(key, flat, PROFESSIONS_CACHE_TTL_MS, [PROFESSIONS_CHANGED_EVENT]);
  return flat;
}

/** Hierarchical tree: families with nested professions (+ specialisms, aliases). */
export async function listTree(): Promise<{ families: TreeFamily[] }> {
  const key = cacheKey("professions", "tree");
  // Cached as an ARRAY (shared cacheGet never stamps arrays with _cachedAt).
  const cached = await cacheGetShared<TreeFamily[]>(key);
  if (cached) return { families: cached };

  const [families, professions, specialisms] = await Promise.all([
    db.professionFamily.findMany({ orderBy: { order: "asc" } }),
    db.profession.findMany({ where: { active: true }, orderBy: { order: "asc" } }),
    db.specialism.findMany({ orderBy: { order: "asc" } }),
  ]);

  const specialismsByProfession = new Map<string, { slug: string; label: string }[]>();
  for (const spec of specialisms) {
    const list = specialismsByProfession.get(spec.professionSlug) ?? [];
    list.push({ slug: spec.slug, label: spec.label });
    specialismsByProfession.set(spec.professionSlug, list);
  }

  const tree: TreeFamily[] = families.map((family) => ({
    slug: family.slug,
    label: family.label,
    description: family.description,
    order: family.order,
    professions: professions
      .filter((p) => p.familySlug === family.slug)
      .map((p) => ({
        slug: p.slug,
        label: p.label,
        // Additive (O2): the stable row id. The legacy flat list stays
        // byte-compatible; the tree view may grow fields. Consumers that
        // reference professions by id (e.g. the O2 candidate profile's
        // preferredProfessionIds, which stores Profession.id) read it here.
        id: p.id,
        description: p.description,
        aliases: parseAliases(p.aliases),
        order: p.order,
        specialisms: specialismsByProfession.get(p.slug) ?? [],
      })),
  }));

  await cacheSetShared(key, tree, PROFESSIONS_CACHE_TTL_MS, [PROFESSIONS_CHANGED_EVENT]);
  return { families: tree };
}

/**
 * Single profession detail (active only — retired rows read as unknown).
 * familySlug is a loose reference (no Prisma relation), so the family is
 * fetched separately. Returns null for unknown/inactive slugs (→ 404).
 */
export async function getProfession(slugInput: string): Promise<ProfessionDetail | null> {
  const slug = normalizeProfessionSlug(slugInput);
  if (!slug) return null;

  const key = cacheKey("professions", "detail", slug);
  const cached = await cacheGetShared<ProfessionDetail>(key);
  if (cached) return withoutCacheDebug(cached);

  const row = await db.profession.findUnique({ where: { slug } });
  if (!row || !row.active) return null;

  const [family, specialisms] = await Promise.all([
    row.familySlug ? db.professionFamily.findUnique({ where: { slug: row.familySlug } }) : null,
    db.specialism.findMany({ where: { professionSlug: row.slug }, orderBy: { order: "asc" } }),
  ]);

  const detail: ProfessionDetail = {
    slug: row.slug,
    label: row.label,
    group: row.group,
    description: row.description,
    aliases: parseAliases(row.aliases),
    order: row.order,
    active: row.active,
    family: family ? { slug: family.slug, label: family.label } : null,
    specialisms: specialisms.map((s) => ({ slug: s.slug, label: s.label, order: s.order })),
  };

  await cacheSetShared(key, detail, PROFESSIONS_CACHE_TTL_MS, [PROFESSIONS_CHANGED_EVENT]);
  return detail;
}

/** Cached slug → id map for ACTIVE professions (legacy + seeded). */
async function loadActiveSlugIdMap(): Promise<Record<string, string>> {
  const key = cacheKey("professions", "slugmap");
  const cached = await cacheGetShared<Record<string, string>>(key);
  if (cached) return cached;

  const rows = await db.profession.findMany({
    where: { active: true },
    select: { slug: true, id: true },
  });
  const map: Record<string, string> = {};
  for (const row of rows) map[row.slug] = row.id;

  await cacheSetShared(key, map, PROFESSIONS_CACHE_TTL_MS, [PROFESSIONS_CHANGED_EVENT]);
  return map;
}

/**
 * Resolve user-supplied profession slugs → Profession ids (ProfileProfession
 * joins by professionId). Accepts ANY active DB profession — legacy slugs and
 * the expanded taxonomy alike. Matching is exact-slug after normalization
 * (trim, lowercase, whitespace → hyphen), so free-text input never silently
 * matches the wrong row. Unknown slugs simply do not resolve; callers compare
 * counts to keep the legacy 400 error behavior.
 */
export async function resolveActiveSlugs(slugs: string[]): Promise<string[]> {
  const wanted = normalizeProfessionSlugs(slugs);
  if (wanted.length === 0) return [];

  const map = await loadActiveSlugIdMap();
  const ids: string[] = [];
  for (const slug of wanted) {
    const id = map[slug];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Back-compat alias for resolveActiveSlugs (pre-expansion call sites). */
export const resolveSlugs = resolveActiveSlugs;

/**
 * Delete every professions cache key directly (rarely needed — prefer
 * cacheInvalidateEventShared("professions.changed")). Also invalidates the
 * SHARED store when CACHE_BACKEND=postgres so other instances see it.
 */
export async function invalidateProfessionsCache(): Promise<void> {
  await cacheDeleteShared(cacheKey("professions", "flat"));
  await cacheDeleteShared(cacheKey("professions", "tree"));
  await cacheDeleteShared(cacheKey("professions", "detail"));
  await cacheDeleteShared(cacheKey("professions", "slugmap"));
  await cacheInvalidateEventShared(PROFESSIONS_CHANGED_EVENT);
}
