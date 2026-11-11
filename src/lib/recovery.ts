import { createHash, randomBytes, timingSafeEqual } from "crypto";

/**
 * BEAN Folio — account recovery keys (forgot-password second factor).
 *
 * Design (see docs/recovery.md):
 * - A recovery key is a 125-bit cryptographically random secret, generated
 *   from the platform CSPRNG (crypto.randomBytes) — NEVER derived from
 *   usernames, emails, timestamps, sequential IDs or Math.random().
 * - Encoded in Crockford base32 (no I/L/O/U confusables) and grouped as
 *   XXXXX-XXXXX-XXXXX-XXXXX-XXXXX so humans can read, write and check it.
 * - The server stores ONLY the SHA-256 of the NORMALIZED key. The plaintext
 *   key is returned to the user exactly once (setup / rotation) and is never
 *   stored, logged or emailed — "view my key again" is therefore impossible
 *   by design; users rotate instead.
 * - Normalization (uppercase, confusables mapped, separators stripped) means
 *   "abcd-efghj" and "ABCDEFGHJ" verify identically — the key is checked
 *   with a timing-safe compare of the digests.
 * - The key is independent of the password and of session tokens; knowing
 *   one never reveals the others.
 */

// Crockford base32 — 32 chars, I/L/O/U excluded. (Also map 0→O? No: digits are
// IN the alphabet; instead the ENCODER never produces I/L/O/U, and
// normalization MAPS the confusable letters users may type onto alphabet
// letters: I,L→1 … O→0, U→V — the standard Crockford check mappings.)
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GROUPS = 5;
const GROUP_LEN = 5;

/** Normalize free-typed recovery-key input to its canonical compare form. */
export function normalizeRecoveryKey(input: string): string {
  const mapped = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
  // Keep only alphabet characters — anything else is invalid input.
  let out = "";
  for (const ch of mapped) if (ALPHABET.includes(ch)) out += ch;
  return out;
}

/** SHA-256 of the normalized key — this is the only server-side representation. */
export function hashRecoveryKey(input: string): string {
  return createHash("sha256").update(normalizeRecoveryKey(input), "utf8").digest("hex");
}

/** Timing-safe digest comparison for two sha256 hex strings. */
export function safeHashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Length (in alphabet chars) a normalized key must have. */
export const RECOVERY_KEY_CHARS = GROUPS * GROUP_LEN;

/**
 * Generate a fresh recovery key.
 * Returns the formatted plaintext (show once) and its server-side hash.
 */
export function generateRecoveryKey(): { key: string; hash: string } {
  // 16 bytes = 128 bits of CSPRNG entropy → 25 base32 chars (125 bits used).
  const bytes = randomBytes(16);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let chars = "";
  for (let i = 0; i < RECOVERY_KEY_CHARS; i++) {
    chars += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  }
  const key = (chars.match(new RegExp(`.{1,${GROUP_LEN}}`, "g")) ?? []).join("-");
  return { key, hash: hashRecoveryKey(key) };
}

/** Validate the SHAPE of a typed key without touching the database. */
export function isRecoveryKeyShape(input: string): boolean {
  const normalized = normalizeRecoveryKey(input);
  return normalized.length === RECOVERY_KEY_CHARS && [...normalized].every((c) => ALPHABET.includes(c));
}

// ---------- Single-use password-reset tokens ----------

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function generateResetToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex"); // 256-bit opaque token
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
  };
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export { RESET_TOKEN_TTL_MS };
