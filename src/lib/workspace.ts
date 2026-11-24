import { cookies } from "next/headers";
import { db } from "@/lib/db";

/**
 * BEAN Folio — active workspace context (M31).
 *
 * A user's personal profile is separate from organization workspaces. The
 * ACTIVE workspace selects which context RIISHE tools and organization-aware
 * surfaces operate on.
 *
 * Security model:
 * - The active organization is a per-browser cookie (`bean_org`). The cookie
 *   VALUE is untrusted client input — it is NEVER used for authorization by
 *   itself. Every resolution re-verifies, server-side, that the signed-in
 *   user has an ACTIVE membership in that organization (the existing
 *   permission matrix remains the single source of truth).
 * - An invalid, foreign or expired cookie silently resolves to the PERSONAL
 *   workspace (fail-safe to the least-privileged context, never an error).
 * - Organization data and personal memory/files never mix: tools receive an
 *   explicit workspace context and must scope every query by it.
 */

export const WORKSPACE_COOKIE = "bean_org";

export type WorkspaceContext =
  | { type: "PERSONAL"; organizationId: null }
  | {
      type: "ORGANIZATION";
      organizationId: string;
      organization: { id: string; displayName: string; slug: string; verificationStatus: string };
      membershipRole: string;
    };

/**
 * Resolve the active workspace for a signed-in user from the workspace
 * cookie, re-authorizing the organization server-side on EVERY call.
 */
export async function resolveWorkspace(userId: string): Promise<WorkspaceContext> {
  const store = await cookies();
  const organizationId = store.get(WORKSPACE_COOKIE)?.value;
  if (!organizationId) return { type: "PERSONAL", organizationId: null };

  const membership = await db.employerMembership.findFirst({
    where: { organizationId, userId, status: "ACTIVE" },
    include: {
      organization: {
        select: { id: true, displayName: true, slug: true, verificationStatus: true },
      },
    },
  });
  if (!membership) return { type: "PERSONAL", organizationId: null };

  return {
    type: "ORGANIZATION",
    organizationId: membership.organization.id,
    organization: membership.organization,
    membershipRole: membership.role,
  };
}

/** Set the active-organization cookie (after server-side authorization). */
export async function setWorkspaceCookie(organizationId: string): Promise<void> {
  const store = await cookies();
  store.set(WORKSPACE_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_SECURE_COOKIES
      ? process.env.SESSION_SECURE_COOKIES === "true"
      : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90 days — a convenience pointer, never an authorization
  });
}

/** Clear the active-organization cookie → back to the personal workspace. */
export async function clearWorkspaceCookie(): Promise<void> {
  const store = await cookies();
  store.set(WORKSPACE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_SECURE_COOKIES
      ? process.env.SESSION_SECURE_COOKIES === "true"
      : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
