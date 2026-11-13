"use client";

/**
 * Thin typed fetch client for the BEAN Folio API.
 * All requests use relative paths (same origin). Errors surface as ApiError
 * with a user-safe message from the server's `{ error }` body.
 */

export interface ApiOptions extends Omit<RequestInit, "body"> {
  /** JSON body — will be serialized automatically */
  json?: unknown;
  /** FormData body (uploads) */
  form?: FormData;
  /**
   * Client-side request deadline in ms. The request is aborted when the
   * server has not responded within this window — a stalled connection (dead
   * network, suspended tab, black-holed proxy) must surface as an error, not
   * hang the caller's loading state forever. Default: no deadline (existing
   * callers unchanged); chat flows opt in with a bound above the server's own
   * worst-case response time.
   */
  timeoutMs?: number;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * The preview panel may embed the app in a (cross-site) iframe. Embedded
 * clients announce themselves so the server can issue a partitioned session
 * cookie the browser will actually store for the frame (see lib/auth.ts).
 */
function embedHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    return window.self !== window.top ? { "X-Bean-Embed": "1" } : {};
  } catch {
    // Accessing window.top from a cross-origin frame throws — which is itself
    // proof that we are embedded.
    return { "X-Bean-Embed": "1" };
  }
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { json, form, headers, timeoutMs, ...rest } = opts;
  // Deadline: abort the request when the server stops answering. Aborting a
  // COMPLETED request is a no-op, so the happy path is untouched.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = timeoutMs ? new AbortController() : undefined;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        ...embedHeaders(),
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : form ?? undefined,
      credentials: "include",
    });
  } catch {
    // An AbortController-driven abort throws the same way a network failure
    // does; distinguish it so the UI can say WHY the request ended.
    if (controller?.signal.aborted) {
      throw new ApiError("The request took too long and was stopped. Please try again.", 408);
    }
    throw new ApiError("Network error — check your connection and try again.", 0);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let data: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export type MediaUploadResult = {
  media: { id: string; kind: string; mime: string; size: number; url: string };
};

/**
 * Direct-upload capability (presigned PUT to object storage), sticky per page
 * load. null = not probed yet; false = this deployment answered 501 (local-
 * disk storage) → the classic multipart transport is used without probing
 * again. A single failed probe costs one small JSON round trip per session,
 * not per upload.
 */
let directUploadSupported: boolean | null = null;

/** Best-effort media kind for the presign request (the server re-sniffs the real bytes). */
function fileKind(file: File): string | null {
  const t = (file.type || "").split(";")[0].trim().toLowerCase();
  if (t.startsWith("image/")) return "IMAGE";
  if (t.startsWith("video/")) return "VIDEO";
  if (t.startsWith("audio/")) return "AUDIO";
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (["pdf", "txt", "text", "log", "md", "markdown", "csv", "tsv", "json", "html", "htm", "css", "js", "mjs"].includes(ext)) {
    return "DOCUMENT";
  }
  return null;
}

async function readError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body === "object" && typeof body.error === "string") message = body.error;
  } catch {
    // keep the default message
  }
  return new ApiError(message, res.status);
}

/** PUT the file straight to object storage with progress (XHR — upload progress). */
function xhrPut(url: string, file: File, contentType: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(`Storage rejected the upload (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("Network error during upload.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    xhr.send(file);
  });
}

/** The classic multipart transport — POST /api/media/upload (server stores the bytes). */
function classicUpload(file: File, onProgress?: (pct: number) => void): Promise<MediaUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as { media?: unknown; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.media) {
        resolve(body as MediaUploadResult);
      } else {
        reject(new ApiError(body?.error ?? `Upload failed (${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError("Network error during upload.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    const fd = new FormData();
    fd.append("file", file);
    // Mirror the embed header — uploads establish no session, but keep every
    // request consistently identified for embedded previews.
    const embed = embedHeaders();
    for (const [k, v] of Object.entries(embed)) xhr.setRequestHeader(k, v);
    xhr.send(fd);
  });
}

/**
 * Upload a file with progress callbacks.
 *
 * Transport: presigned DIRECT upload to object storage when the deployment
 * supports it (bytes go browser → object store; the app server only signs
 * and verifies — large media never passes through an API handler), with a
 * transparent fallback to the classic multipart upload on local-disk
 * deployments (501 probe) or a mid-flight direct-upload network failure.
 * Both transports enforce the same server-side validation (magic bytes,
 * size caps) before the media is attachable, and the returned shape is
 * identical, so callers are transport-agnostic.
 */
export async function uploadFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<MediaUploadResult> {
  const kind = fileKind(file);
  if (kind && directUploadSupported !== false) {
    try {
      const presignRes = await fetch("/api/media/direct/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...embedHeaders() },
        credentials: "include",
        body: JSON.stringify({ kind, size: file.size, filename: file.name, mime: file.type }),
      });
      if (presignRes.status === 501) {
        directUploadSupported = false; // local-disk deployment — fall back below, stop probing
      } else if (!presignRes.ok) {
        // Validation/quota rejections surface honestly — the classic path
        // would enforce the same rules, so there is nothing to fall back to.
        throw await readError(presignRes);
      } else {
        const presigned = (await presignRes.json()) as {
          media: { id: string; uploadUrl: string; headers: Record<string, string> };
        };
        await xhrPut(
          presigned.media.uploadUrl,
          file,
          presigned.media.headers["Content-Type"] ?? file.type,
          onProgress
        );
        const completeRes = await fetch("/api/media/direct/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...embedHeaders() },
          credentials: "include",
          body: JSON.stringify({ mediaId: presigned.media.id }),
        });
        if (!completeRes.ok) throw await readError(completeRes);
        const done = (await completeRes.json()) as MediaUploadResult;
        onProgress?.(100);
        return done;
      }
    } catch (e) {
      const isNetworkFailure = e instanceof ApiError && e.status === 0;
      if (!isNetworkFailure) throw e; // server rejection = a real, honest error
      // Network-level failure (presign/PUT/complete unreachable) — the classic
      // multipart path may still work; nothing is attachable until complete,
      // so retrying cannot double-store anything.
    }
  }
  return classicUpload(file, onProgress);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n % 1000 >= 100 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
