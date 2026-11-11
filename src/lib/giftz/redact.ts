/**
 * Secret redaction for CODE GIFTZ (Phase 4).
 *
 * Everything the engineering agent captures from the outside world — command
 * output, file content summaries, error details — passes through `redactText`
 * before it is stored in AgentTask rows, returned to clients or logged.
 * House rule inherited from the gateway observability layer: no secrets, no
 * credentials, no environment values in persistent records or logs.
 */

interface RedactionRule {
  name: string;
  pattern: RegExp;
  /** Build the replacement from the regex match groups — never echoes the secret. */
  to: (groups: string[]) => string;
}

const RULES: RedactionRule[] = [
  {
    name: "bearer",
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    to: (g) => `${g[1]} <redacted>`,
  },
  {
    name: "key-value-secret",
    // KEY=... / KEY: ... for secret-ish keys (values ≥6 chars; already-redacted values are skipped for idempotency)
    pattern: /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*["']?(?!<redacted>)([^\s"']{6,})["']?/gi,
    to: (g) => `${g[1]}=<redacted>`,
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: () => "<redacted private key>",
  },
  {
    name: "aws-access-key",
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    to: () => "<redacted aws key id>",
  },
  {
    name: "long-hex-token",
    // 40+ hex chars (covers sha-256+ secrets and long API tokens; leaves git's 40-char ids alone only when short — conservative choice documented in tests).
    pattern: /\b[0-9a-f]{40,}\b/gi,
    to: () => "<redacted token>",
  },
  {
    name: "connection-url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^/\s:]+:([^@\s/]+)@/gi,
    to: (g) => `${g[1]}://<redacted>@`,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
}

/** Redact secret-shaped substrings. Idempotent (already-redacted text passes through). */
export function redactText(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      const groups = args.slice(0, args.length - 2).map(String);
      return rule.to(groups);
    });
  }
  return { text, count };
}

/**
 * Paths/files the inspector and editor must never read or write.
 * Used as a predicate for reads AND writes.
 */
const SECRET_FILE_RE =
  /(^|\/)(.*secret.*|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|.*\.pfx|.*\.p12|credentials.*|\.npmrc|\.netrc)$/i;

export function isSecretPath(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, "/");
  if (/(^|\/)\.env($|\.)/i.test(p)) return true;
  return SECRET_FILE_RE.test(p);
}

const IGNORED_DIR_RE =
  /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|\.cache|\.turbo|\.bun|__pycache__|vendor|target)(\/|$)/;

export function isIgnoredPath(relativePath: string): boolean {
  return IGNORED_DIR_RE.test(relativePath.replace(/\\/g, "/"));
}

/** Binary sniff: NUL byte in the first 8 KB (same idiom as media.ts). */
export function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 8192);
  return head.includes(0);
}
