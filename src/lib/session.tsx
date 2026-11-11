"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { PublicMe } from "@/lib/types";

/**
 * Single authoritative client session state.
 *
 * Status semantics (explicit, never guessed):
 * - "loading":         the session has not been conclusively resolved yet.
 * - "authenticated":   the server confirmed a valid session (200 + user).
 * - "unauthenticated": the server authoritatively answered 200 { user: null }.
 * - "error":           the check could not be completed (network, 429, 5xx).
 *                      This is NOT "logged out" — a valid cookie may still exist,
 *                      so the caller may retry instead of showing a sign-in gate.
 *
 * Only a 200 response with { user: null } classifies the visitor as signed out.
 * Transient failures are retried before the state is exposed as "error".
 */
export type SessionStatus = "loading" | "authenticated" | "unauthenticated" | "error";

interface SessionValue {
  user: PublicMe | null;
  loading: boolean;
  status: SessionStatus;
  error: boolean;
  refresh: () => Promise<PublicMe | null>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue>({
  user: null,
  loading: true,
  status: "loading",
  error: false,
  refresh: async () => null,
  logout: async () => undefined,
});

/** Transient-failure retry policy for session checks. */
const MAX_REFRESH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;
/** A single check must never hang forever (a hung fetch would deadlock retries). */
const CHECK_TIMEOUT_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicMe | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  // Concurrent refresh callers await the SAME in-flight check — no duplicate
  // requests, and the lock always clears because attempts are time-boxed.
  const checkRef = useRef<Promise<PublicMe | null> | null>(null);

  const refresh = useCallback((): Promise<PublicMe | null> => {
    if (checkRef.current) return checkRef.current;
    const check = (async (): Promise<PublicMe | null> => {
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await api<{ user: PublicMe | null }>("/api/auth/me", {
              cache: "no-store",
              signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            });
            setUser(res.user);
            setStatus(res.user ? "authenticated" : "unauthenticated");
            return res.user;
          } catch {
            // Transient failure — never classify as logged out on this basis.
            if (attempt < MAX_REFRESH_RETRIES) {
              await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
              continue;
            }
            setStatus("error");
            return null;
          }
        }
      } finally {
        checkRef.current = null;
      }
    })();
    checkRef.current = check;
    return check;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    // The server must confirm revocation; only then is client state cleared.
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      user,
      loading: status === "loading",
      status,
      error: status === "error",
      refresh,
      logout,
    }),
    [user, status, refresh, logout]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  return useContext(SessionContext);
}
