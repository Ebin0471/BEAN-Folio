import type { Prisma } from "@prisma/client";

/**
 * BEAN Folio — public-visibility rules (single source of truth).
 *
 * Every PUBLIC discovery surface (discover feed, search, category filters,
 * related work, public profiles) MUST derive its owner/profile filters from
 * this module so the rules cannot drift between endpoints.
 *
 * A user's content is publicly discoverable only when ALL of these hold:
 *  - the account is not a demo fixture (`isDemo: false`) — fixtures exist only
 *    inside their own signed-in workspace and never appear to the public;
 *  - the account is not soft-deleted (`deletedAt: null`);
 *  - the account chose PUBLIC profile visibility (the Settings toggle copy:
 *    "Private — hidden, direct link shows not found").
 *
 * Visibility is ALWAYS enforced server-side; the frontend never filters.
 */

/** Owner filter for Project queries on PUBLIC surfaces. */
export const publicOwnerFilter: Prisma.UserWhereInput = {
  isDemo: false,
  deletedAt: null,
  profileVisibility: "PUBLIC",
};

/** Base filter for User rows on PUBLIC surfaces (username/visibility checks stay endpoint-specific). */
export const publicProfileBaseFilter: Prisma.UserWhereInput = {
  isDemo: false,
  deletedAt: null,
};

/** Status+visibility clause every public project query must include. */
export const publicProjectStatusFilter: Prisma.ProjectWhereInput = {
  status: "PUBLISHED",
  visibility: "PUBLIC",
};

/**
 * Whether a profile row may be shown to the given viewer.
 * `isSelf` always passes (owners can always open their own profile, demo
 * fixtures included — their private workspace stays functional).
 */
export function isProfilePubliclyVisible(
  profile: { isDemo: boolean; deletedAt: Date | null; profileVisibility: string } | null | undefined,
  isSelf: boolean
): boolean {
  if (!profile) return false;
  if (isSelf) return true;
  if (profile.isDemo) return false;
  if (profile.deletedAt) return false;
  return profile.profileVisibility === "PUBLIC";
}
