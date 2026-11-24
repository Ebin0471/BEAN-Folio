import { cookies } from "next/headers";
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { PublicMe } from "@/lib/types";

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "bean_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------- Passwords (scrypt, per-user salt, timing-safe compare) ----------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const derived = await scrypt(password, salt, 64);
  const keyBuf = Buffer.from(key, "hex");
  if (keyBuf.length !== derived.length) return false;
  return timingSafeEqual(keyBuf, derived);
}

// ---------- Sessions (opaque tokens; only their SHA-256 is stored) ----------

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Either the global Prisma client or an interactive-transaction client. */
export type DbClient = typeof db | Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Create a login session. Pass an interactive-transaction client (`tx`) when
 * the session row must commit atomically with related writes (e.g. the user
 * row during registration) — otherwise the global client is used.
 */
export async function createSession(userId: string, client: DbClient = db): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await client.session.create({
    data: { token: hashToken(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}

export async function setSessionCookie(token: string, req?: NextRequest): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(isEmbeddedClient(req)));
}

/**
 * The preview panel embeds the app in an iframe. Depending on the gateway
 * origin that frame may be cross-site, where a `SameSite=Lax` cookie is
 * silently dropped and the user appears logged out on every reload. Embedded
 * clients mark their requests with `X-Bean-Embed: 1`; for them we issue a
 * first-party-partitioned cookie (CHIPS) which works inside the frame without
 * weakening the first-party behavior for normal navigation.
 */
export function isEmbeddedClient(req?: NextRequest): boolean {
  return req?.headers.get("x-bean-embed") === "1";
}

export function sessionCookieOptions(embedded: boolean) {
  return embedded
    ? {
        httpOnly: true,
        sameSite: "none" as const,
        secure: true, // required by browsers for SameSite=None; gateway serves https
        partitioned: true as const,
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      }
    : {
        httpOnly: true,
        sameSite: "lax" as const,
        // Secure when running in production (the `start` script sets
        // NODE_ENV=production). SESSION_SECURE_COOKIES, when set, overrides:
        // "true" forces Secure (staging behind TLS), "false" allows an
        // explicitly non-TLS self-hosted deployment.
        secure: process.env.SESSION_SECURE_COOKIES
          ? process.env.SESSION_SECURE_COOKIES === "true"
          : process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_TTL_MS / 1000,
      };
}

export async function clearSessionCookie(req?: NextRequest): Promise<void> {
  const store = await cookies();
  // Mirror the attributes of the cookie being cleared so the browser actually
  // replaces it (a SameSite=None; Partitioned cookie cannot be overwritten by
  // a Lax cookie with the same name — they are different cookie jars).
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(isEmbeddedClient(req)), maxAge: 0 });
}

/** Resolve the signed-in user from the session cookie. Returns null when anonymous/invalid. */
export async function getSessionUser() {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = await db.session.findUnique({
    where: { token: hashToken(raw) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (session.user.deletedAt) return null;
  return session.user;
}

export async function revokeSession(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    await db.session.deleteMany({ where: { token: hashToken(raw) } }).catch(() => undefined);
  }
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.session.deleteMany({ where: { userId } }).catch(() => undefined);
}

// ---------- DTO builders ----------

type UserWithTaxonomy = {
  id: string;
  email: string;
  name: string;
  username: string | null;
  headline: string | null;
  bio: string | null;
  location: string | null;
  avatarMediaId: string | null;
  coverMediaId: string | null;
  coverPositionY: number;
  avatarFit: string;
  avatarZoom: number;
  avatarPosX: number;
  avatarPosY: number;
  availability: string | null;
  experienceLevel: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  profileVisibility: string;
  aiConsent: boolean;
  onboarded: boolean;
  isDemo: boolean;
  role: string;
  primaryIdentity: string | null;
  createdAt: Date;
  professions: { profession: { slug: string } }[];
  skills: { skill: { slug: string } }[];
};

export function buildPublicMe(user: UserWithTaxonomy): PublicMe {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    headline: user.headline,
    bio: user.bio,
    location: user.location,
    avatarUrl: user.avatarMediaId ? `/api/media/${user.avatarMediaId}/raw` : null,
    coverUrl: user.coverMediaId ? `/api/media/${user.coverMediaId}/raw` : null,
    coverPositionY: user.coverPositionY,
    avatarFit: user.avatarFit,
    avatarZoom: user.avatarZoom,
    avatarPosX: user.avatarPosX,
    avatarPosY: user.avatarPosY,
    availability: user.availability,
    experienceLevel: user.experienceLevel,
    contactEmail: user.contactEmail,
    websiteUrl: user.websiteUrl,
    professions: user.professions.map((p) => p.profession.slug),
    skills: user.skills.map((s) => s.skill.slug),
    aiConsent: user.aiConsent,
    onboarded: user.onboarded,
    profileVisibility: user.profileVisibility,
    isDemo: user.isDemo,
    role: user.role,
    primaryIdentity: user.primaryIdentity,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Load a user with taxonomy relations included (for buildPublicMe / public person). */
export function getUserWithTaxonomy(userId: string) {
  return db.user.findUnique({
    where: { id: userId },
    include: {
      professions: { include: { profession: true }, orderBy: { profession: { order: "asc" } } },
      skills: { include: { skill: true } },
    },
  });
}
