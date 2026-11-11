"use client";

import { useEffect, useState } from "react";
import { UserCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";
import type { PublicPerson } from "@/lib/types";

export function FollowButton({
  person,
  size = "sm",
  initialFollowing,
  onChange,
}: {
  person: PublicPerson;
  size?: "sm" | "default";
  /** Known follow state from a parent fetch (e.g. profile response). */
  initialFollowing?: boolean;
  onChange?: (following: boolean) => void;
}) {
  const { user } = useSession();
  const [following, setFollowing] = useState<boolean | null>(initialFollowing ?? null);
  const [busy, setBusy] = useState(false);

  const shouldResolve = initialFollowing === undefined;

  useEffect(() => {
    if (!user || !shouldResolve) return;
    let alive = true;
    api<{ following: boolean }>(`/api/profiles/${person.username}/follow`)
      .then((r) => alive && setFollowing(r.following))
      .catch(() => alive && setFollowing(false)); // state unknown → still allow a follow attempt
    return () => {
      alive = false;
    };
  }, [user, person.username, shouldResolve]);

  if (!user || user.username === person.username) return null;

  const isFollowing = following === true;
  const loading = following === null;

  async function toggle() {
    if (busy || loading) return;
    setBusy(true);
    try {
      const res = await api<{ following: boolean }>(`/api/profiles/${person.username}/follow`, {
        method: isFollowing ? "DELETE" : "POST",
      });
      setFollowing(res.following);
      onChange?.(res.following);
      toast.success(res.following ? `Following ${person.name}` : `Unfollowed ${person.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update follow");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={isFollowing ? "secondary" : "default"}
      size={size}
      onClick={toggle}
      disabled={busy || loading}
      aria-pressed={isFollowing}
      className="gap-1.5"
    >
      {isFollowing ? <UserCheck className="size-4" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
      {isFollowing ? "Following" : "Follow"}
    </Button>
  );
}
