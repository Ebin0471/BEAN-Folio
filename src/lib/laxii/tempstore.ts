import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import path from "path";

/**
 * LAXII private temp workspace.
 *
 * Intermediate frames (generated plates, subject crops, composites) live in
 * `<project>/data/laxii-tmp/<jobId>/` — deliberately OUTSIDE `uploads/`, so
 * the media-serving boundary can never resolve them (storage.ts only serves
 * paths under `<root>/uploads`). Directories are deleted when a job finishes
 * and swept by age on every job start, so a crashed job cannot leak files.
 *
 * Nothing here is a public URL; nothing is logged; nothing trains anything.
 */

const ROOT = path.resolve(process.cwd(), "data", "laxii-tmp");
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h crash guard

export async function createWorkspace(jobId: string): Promise<string> {
  const dir = path.join(ROOT, sanitize(jobId));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeFrame(dir: string, name: string, buf: Buffer): Promise<string> {
  const p = path.join(dir, sanitize(name));
  await writeFile(p, buf);
  return p;
}

export async function readFrame(p: string): Promise<Buffer> {
  const { readFile } = await import("fs/promises");
  return readFile(p);
}

export async function removeWorkspace(dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  // Defense in depth: only ever delete inside the LAXII temp root.
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(ROOT + path.sep)) return;
  await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
}

/** Sweep stale workspaces (crashed jobs). Called before each job starts. */
export async function sweepStale(): Promise<void> {
  try {
    const entries = await readdir(ROOT).catch(() => [] as string[]);
    const now = Date.now();
    for (const entry of entries) {
      const dir = path.join(ROOT, entry);
      const s = await stat(dir).catch(() => null);
      if (s && s.mtimeMs < now - MAX_AGE_MS) {
        await removeWorkspace(dir);
      }
    }
  } catch {
    // sweeping is best-effort
  }
}

function sanitize(name: string): string {
  // dots and dashes allowed — file extensions and manifest.json must survive
  return name.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80) || "x";
}
