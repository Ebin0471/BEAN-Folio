"use client";

import { useEffect, useState } from "react";
import { UserCheck, UserPlus, Clock } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";
import type { FollowState, PublicPerson, RelationshipResponse } from "@/lib/types";

/**
 * Social follow button with full relationship semantics: instant follow on
 * public accounts, a "Requested" pending state on private accounts, and
 * withdraw-request via the same toggle. State comes from the relationship
 * probe (GET /api/profiles/:username/follow → { state }) so it is accurate
 * across devices and refreshes.
 */
export function FollowButton({
  person,
  size = "sm",
  initialState,
  onChange,
}: {
  person: PublicPerson;
  size?: "sm" | "default";
  /** Known follow state from a parent fetch (e.g. profile response). */
  initialState?: FollowState;
  onChange?: (state: FollowState) => void;
}) {
  const { user } = useSession();
  const [state, setState] = useState<FollowState | null>(initialState ?? null);
  const [busy, setBusy] = useState(false);

  const shouldResolve = initialState === undefined;

  useEffect(() => {
    if (!user || !shouldResolve) return;
    let alive = true;
    api<RelationshipResponse>(`/api/profiles/${person.username}/follow`)
      .then((r) => alive && setState(r.state))
      .catch(() => alive && setState("NONE")); // state unknown → still allow a follow attempt
    return () => {
      alive = false;
    };
  }, [user, person.username, shouldResolve]);

  if (!user || user.username === person.username) return null;

  const loading = state === null;
  const isActive = state === "ACTIVE";
  const isPending = state === "PENDING";

  async function toggle() {
    if (busy || loading) return;
    setBusy(true);
    try {
      const res = await api<{ state: FollowState }>(`/api/profiles/${person.username}/follow`, {
        method: isActive || isPending ? "DELETE" : "POST",
      });
      setState(res.state);
      onChange?.(res.state);
      toast.success(
        res.state === "ACTIVE"
          ? `Following ${person.name}`
          : res.state === "PENDING"
            ? `Follow request sent to ${person.name}`
            : isActive
              ? `Unfollowed ${person.name}`
              : `Request withdrawn`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update follow");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={isActive ? "secondary" : "default"}
      size={size}
      onClick={toggle}
      disabled={busy || loading}
      aria-pressed={isActive}
      className="gap-1.5"
    >
      {isPending ? (
        <Clock className="size-4" aria-hidden />
      ) : isActive ? (
        <UserCheck className="size-4" aria-hidden />
      ) : (
        <UserPlus className="size-4" aria-hidden />
      )}
      {isPending ? "Requested" : isActive ? "Following" : "Follow"}
    </Button>
  );
}
