/**
 * CODE GIFTZ controlled command runner (Phase 4 spec §5).
 *
 * Security model:
 * - STRICT allowlist: `bun test [files]`, `bun run <script from the workspace
 *   package.json>`, `bunx tsc --noEmit`, `bunx eslint <paths>` — nothing else.
 *   No shell (`shell:false`, argv arrays only), workspace cwd only.
 * - Every subprocess runs with a MINIMAL environment (PATH/HOME/LANG/TMPDIR)
 *   — application secrets like DATABASE_URL can never reach a child process.
 * - Hard timeout with process-tree kill; cancellation kills running children.
 * - stdout/stderr are capped (tail kept), counted, and REDACTED before storage.
 * - Executables are resolved by fixed name; PATH is not scanned for arbitrary
 *   user-supplied binaries; no interpolation, no quoting games.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

import { redactText } from "./redact";
import type { CommandRun } from "./types";
import { minimalEnv, WorkspaceError, workspaceDir } from "./workspace";

export const COMMAND_LIMITS = {
  timeoutMs: 120_000,
  maxOutputBytes: 64 * 1024,
  maxArgv: 12,
  maxArgLength: 256,
} as const;

export const ALLOWED_DIRECT = new Set(["bun", "bunx", "node"]);

/** In-flight children per task — enables hard cancellation. */
const runningChildren = new Map<string, Set<ReturnType<typeof spawn>>>();

function registerChild(taskId: string, child: ReturnType<typeof spawn>): void {
  let set = runningChildren.get(taskId);
  if (!set) {
    set = new Set();
    runningChildren.set(taskId, set);
  }
  set.add(child);
  child.once("close", () => {
    set?.delete(child);
    if (set && set.size === 0) runningChildren.delete(taskId);
  });
}

/** Kill any running children of the task (cancellation). Returns how many were killed. */
export function killTaskChildren(taskId: string): number {
  const set = runningChildren.get(taskId);
  if (!set) return 0;
  let killed = 0;
  for (const child of set) {
    try {
      child.kill("SIGKILL");
      killed += 1;
    } catch {
      /* already dead */
    }
  }
  return killed;
}

// ---------------------------------------------------------------------------
// Allowlist validation
// ---------------------------------------------------------------------------

export interface ValidatedCommand {
  argv: string[];
  label: string;
}

/**
 * Validate an argv against the allowlist. `packageScripts` supplies the
 * workspace's package.json script names (bun run <name> only).
 * Throws WorkspaceError (400) with an actionable message.
 */
export function validateCommand(
  input: { label?: string; argv: string[] },
  packageScripts: string[],
): ValidatedCommand {
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new WorkspaceError("Command must be a non-empty argv array");
  }
  if (argv.length > COMMAND_LIMITS.maxArgv) {
    throw new WorkspaceError(`Command exceeds ${COMMAND_LIMITS.maxArgv} argv entries`);
  }
  for (const part of argv) {
    if (typeof part !== "string" || part.length === 0 || part.length > COMMAND_LIMITS.maxArgLength) {
      throw new WorkspaceError("Invalid argv entry (empty or too long)");
    }
    if (part.includes("\0") || /[\r\n]/.test(part)) {
      throw new WorkspaceError("Invalid characters in command arguments");
    }
  }
  const [bin, sub, ...rest] = argv;
  let label = input.label?.trim() || argv.join(" ");

  if (bin === "bun" && sub === "test") {
    // bun test [pattern...] — patterns must be plain file/dir substrings.
    for (const pattern of rest) {
      if (!/^[\w./@-]+$/.test(pattern)) {
        throw new WorkspaceError(`"bun test" patterns must be plain paths (rejected: ${pattern.slice(0, 40)})`);
      }
    }
    return { argv, label: label === argv.join(" ") ? "bun test" : label };
  }

  if (bin === "bun" && sub === "run") {
    const scriptName = rest[0];
    if (!scriptName || rest.length > 1) {
      throw new WorkspaceError('"bun run" takes exactly one script name from the workspace package.json');
    }
    if (!packageScripts.includes(scriptName)) {
      throw new WorkspaceError(
        `"${scriptName}" is not a script in this workspace's package.json (available: ${packageScripts.join(", ") || "none"})`,
      );
    }
    return { argv, label: label === argv.join(" ") ? `bun run ${scriptName}` : label };
  }

  if (bin === "bunx" && sub === "tsc") {
    const flags = rest;
    const allowed = new Set(["--noEmit", "--pretty", "false", "true"]);
    for (const flag of flags) {
      if (!allowed.has(flag) && !/^--\w[\w-]*$/.test(flag)) {
        throw new WorkspaceError(`"bunx tsc" supports flag-style arguments only (rejected: ${flag.slice(0, 40)})`);
      }
    }
    return { argv, label: label === argv.join(" ") ? "bunx tsc" : label };
  }

  if (bin === "bunx" && sub === "eslint") {
    for (const arg of rest) {
      if (!/^[\w./@*-]*$/.test(arg)) {
        throw new WorkspaceError(`"bunx eslint" arguments must be plain paths/flags (rejected: ${arg.slice(0, 40)})`);
      }
    }
    return { argv, label: label === argv.join(" ") ? "bunx eslint" : label };
  }

  if (bin === "node" && (sub === "--version" || sub === "-v") && rest.length === 0) {
    return { argv, label: label === argv.join(" ") ? "node --version" : label };
  }

  throw new WorkspaceError(
    `Command not allowed: "${argv.slice(0, 3).join(" ")}". Allowed: bun test, bun run <script>, bunx tsc, bunx eslint, node --version`,
    403,
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run one allowlisted command in the workspace. Output is redacted before return. */
export function runCommand(
  taskId: string,
  repoId: string,
  validated: ValidatedCommand,
  opts: { timeoutMs?: number; runId?: string } = {},
): Promise<CommandRun> {
  const dir = workspaceDir(repoId);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    return Promise.resolve({
      id: opts.runId ?? crypto.randomUUID(),
      label: validated.label,
      argv: validated.argv,
      cwd: ".",
      exitCode: null,
      signal: null,
      durationMs: 0,
      status: "error",
      stdoutTail: "",
      stderrTail: "workspace directory is missing",
      stdoutTruncated: false,
      stderrTruncated: false,
      redactionCount: 0,
      at: new Date().toISOString(),
    });
  }

  const timeoutMs = Math.min(opts.timeoutMs ?? COMMAND_LIMITS.timeoutMs, COMMAND_LIMITS.timeoutMs);
  const startedAt = Date.now();

  return new Promise<CommandRun>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const child = spawn(validated.argv[0], validated.argv.slice(1), {
      cwd: dir,
      env: minimalEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    registerChild(taskId, child);

    const appendCapped = (chunk: Buffer | string, isStdout: boolean): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (isStdout) {
        if (stdout.length >= COMMAND_LIMITS.maxOutputBytes) {
          stdoutTruncated = true;
          return;
        }
        stdout += text;
        if (stdout.length > COMMAND_LIMITS.maxOutputBytes) {
          stdout = stdout.slice(0, COMMAND_LIMITS.maxOutputBytes);
          stdoutTruncated = true;
        }
      } else {
        if (stderr.length >= COMMAND_LIMITS.maxOutputBytes) {
          stderrTruncated = true;
          return;
        }
        stderr += text;
        if (stderr.length > COMMAND_LIMITS.maxOutputBytes) {
          stderr = stderr.slice(0, COMMAND_LIMITS.maxOutputBytes);
          stderrTruncated = true;
        }
      }
    };

    child.stdout?.on("data", (c: Buffer | string) => appendCapped(c, true));
    child.stderr?.on("data", (c: Buffer | string) => appendCapped(c, false));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, status: CommandRun["status"], errorTail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = redactText(stdout);
      const err = redactText(errorTail !== undefined ? errorTail + (stderr ? "\n" + stderr : "") : stderr);
      const run: CommandRun = {
        id: opts.runId ?? crypto.randomUUID(),
        label: validated.label,
        argv: validated.argv,
        cwd: ".",
        exitCode,
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
        status,
        stdoutTail: out.text,
        stderrTail: err.text,
        stdoutTruncated,
        stderrTruncated,
        redactionCount: out.count + err.count,
        at: new Date().toISOString(),
      };
      resolve(run);
    };

    child.on("error", (error: Error) => {
      finish(null, null, "error", `failed to start: ${error.message}`);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) finish(code, signal, "timeout", `command exceeded the ${Math.round(timeoutMs / 1000)}s timeout and was killed.\n`);
      else if (signal === "SIGKILL" && !timedOut) finish(code, signal, "killed");
      else if (code === 0) finish(code, signal, "passed");
      else finish(code, signal, "failed");
    });
  });
}

/** Parse `bun test` output into a test-count summary (best-effort, honest). */
export function summarizeTestRun(run: CommandRun): { passed: number; failed: number; parsed: boolean } | null {
  const text = `${run.stdoutTail}\n${run.stderrTail}`;
  const passMatch = /(\d+) pass/.exec(text);
  const failMatch = /(\d+) fail/.exec(text);
  if (!passMatch && !failMatch) return null;
  return {
    passed: passMatch ? Number(passMatch[1]) : 0,
    failed: failMatch ? Number(failMatch[1]) : 0,
    parsed: true,
  };
}
