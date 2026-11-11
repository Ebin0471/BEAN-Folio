# BEAN Folio — Media Pipeline

**Summary:** Media upload, storage and serving as built: client XHR with progress →
`POST /api/media/upload` → magic-byte validation (client MIME never trusted) → **object storage via
`src/lib/storage.ts` (local disk driver, or S3-compatible object storage in production)** →
`MediaAsset` row → served through `GET /api/media/:id/raw` behind an authorization ladder. The
remaining production upgrades (presigned direct uploads, background worker, FFmpeg processing,
durable job table) are designed below and clearly labelled **not-yet-implemented**.

**Status:** Upload flow — as built in this repository, verified (live tests including negative
paths, in both storage drivers). Storage layer — **implemented**: local disk + S3-compatible
object storage behind one API (`src/lib/storage.ts`); the S3 driver was verified end-to-end
against a local S3-compatible server (upload → object stored → byte-identical serve → delete).
Background processing pipeline — design only.

---

## 1. As-built upload flow

```
Browser                          API                                Disk / DB
───────                          ───                                ─────────
MediaUploadButton
  → uploadFile(file, onProgress)      (src/lib/client.ts, XHR)
     POST /api/media/upload  ───────► auth (getSessionUser)
     multipart: file                  401 if anonymous
     XHR upload.onprogress ──►        rate limit: 30/h per user (429)
                                      saveUpload(file, ownerId)        (src/lib/media.ts)
                                        ├─ sniff magic bytes (head 16B)
                                        ├─ kind + allowlist check ──► 400 "This … format is not allowed"
                                        ├─ size cap per kind ───────► 400 "… exceeds the …MB limit"
                                        ├─ empty-file check ────────► 400
                                        ├─ re-verify after full read ("content changed" guard)
                                        ├─ mkdir uploads/ + write <base36-time><16hex>.<ext>
                                        └─ create MediaAsset row (READY)
                                     ◄─────── 200 { media: { id, kind, mime, size, url } }
  client stores mediaId;
  attaches to project (≤30 items,
  ownership re-verified on save)
```

Key properties:

- **Client MIME never trusted** — the sniffed content type decides everything (`sniffMime`);
  the response `mime` is the sniffed value.
- **Unguessable, owner-scoped storage keys** — `uploads/<ownerId>/<base36-time><16 hex>.<ext>`
  (`buildStorageKey`), never user filenames (original filename is kept only as
  `MediaAsset.filename` metadata, capped at 180 chars). Legacy pre-multi-tenant rows use flat
  `uploads/<name>` keys and keep working through the same abstraction.
- Files are stored through the storage abstraction and are **not** statically served — every byte
  goes through the API route.

## 2. Storage layer (`src/lib/storage.ts`) — implemented

One API — `putObject` / `getObject` / `deleteObject` — with two drivers:

| Driver | When | Where bytes live |
|---|---|---|
| `local` (default) | no S3 env, or `MEDIA_STORAGE_DRIVER=local` | `<MEDIA_LOCAL_ROOT or cwd>/uploads/…` |
| `s3` | `S3_ENDPOINT` + `S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` all set | any S3-compatible bucket (AWS S3, Cloudflare R2, Supabase Storage, MinIO, …) via `@aws-sdk/client-s3` |

Guarantees (unit-tested in `tests/storage.test.ts`):

- **All-or-nothing S3 config** — a partial S3 env falls back to local rather than half-working.
- **Path-traversal guard** — `MediaAsset.storagePath` is resolved only inside the media
  directory; a tampered DB row can never make the app read `.env`, the database or source files.
- **Idempotent deletes** across both drivers.

Production rule: **on stateless hosts (Vercel) the S3 driver is required** — the local filesystem
is ephemeral and uploads would be lost on every redeploy (docs/deployment.md §0.2 Step B/C).
Media remains private: the bucket is never public; every byte is served through the
authorization ladder below.

## 3. Serving + authorization ladder (`GET /api/media/:id/raw`)

The route resolves access in this order (verified live: owner 200 / anon-on-avatar 200 /
anon-on-private-project-media 403 / deleted blob 404):

1. **Owner** — `MediaAsset.ownerId` equals the session user → allow.
2. **Avatar/cover reference** — the asset is the `avatarMediaId`/`coverMediaId` of a live
   (non-deleted) account → allow (public profile imagery).
3. **Project reference** — the asset is attached via `ProjectMedia`:
   - project `PUBLIC` or `UNLISTED` → allow (UNLISTED keeps "anyone with the link" semantics);
   - project `PRIVATE` or `DRAFT` → owner only → **403** otherwise.
4. Else **403**. Missing blob on disk marks the asset `FAILED` and returns **404**.

Response: binary body with the sniffed `Content-Type`, `Content-Length`, and
`Cache-Control: private, max-age=3600` (private because authorization is per-request; a CDN
placement in production must revisit this — see §4).

Metadata + deletion: `GET /api/media/:id` and `DELETE /api/media/:id` are owner-only
(delete removes the file — idempotently — then the row).

## 4. Limits (as built)

| Kind | Allowed content (sniffed) | Max size |
|---|---|---|
| IMAGE | jpeg, png, webp, gif | 8 MB |
| VIDEO | mp4, webm, quicktime (mov) | 64 MB |
| AUDIO | mpeg (mp3), mp4 (m4a), wav, ogg | 20 MB |
| DOCUMENT | pdf | 10 MB |

Image dimensions (jpeg/png/gif/webp) are parsed in-process (`imageDimensions`) for layout use.
No video/audio processing happens in this build — the client's `<video>`/`<audio>` elements
handle playback of the stored original.

## 5. Presigned direct uploads — **IMPLEMENTED** (P2, production readiness)

The large-file transport upgrade is built and verified (tests/media-direct.test.ts, end-to-end
against a local S3-compatible fake):

```
Browser                          API                              Object storage (S3)
───────                          ───                              ─────────
1. POST /api/media/direct/presign
   {kind, size, filename, mime} ─► auth + rate limit (30/h, same as classic)
                                    validate declared kind/size/filename/mime
                                    create MediaAsset (status=PENDING)
   ◄── {mediaId, uploadUrl}         presigned PUT, single key, TTL 10 min
2. PUT bytes ────────────────────────────────────────────────────────────────► uploads/<ownerId>/…
   (browser → bucket DIRECTLY — contents never pass through a Next.js handler,
    so the ~4.5 MB function-body cap no longer bounds upload size)
3. POST /api/media/direct/complete {mediaId}
                                 ─► ownership + PENDING check
                                    HeadObject: exists + exact size ≤ kind cap
                                    GET Range 0-15: magic-byte sniff (client mime never trusted)
                                    kind match + text whole-file NUL/UTF-8 scan
                                    PENDING → READY (mime/size/dimensions from the object)
   ◄── 200 {media: {id, kind, mime, size, url}}
```

Properties (each pinned by a test):

- **Authorization** — presign and complete both require a session; complete verifies the
  MediaAsset belongs to the caller (a foreign session cannot complete someone else's upload).
- **The bucket stays PRIVATE** — the presigned PUT grants write access to exactly ONE
  owner-scoped, unguessable key for 10 minutes; it can never read, list, or overwrite another
  object. Delivery continues through `GET /api/media/:id/raw` behind the authorization ladder.
- **Content never trusted** — the declared mime only pre-selects the key extension; the REAL
  mime is sniffed from the stored bytes on complete, the sniffed kind must match the declared
  kind, and text documents get the same whole-file NUL/UTF-8 scan as the classic path.
- **Failure leaves nothing behind** — a failed verification deletes the object AND the row;
  `complete` without an object is an honest 400.
- **Abandoned uploads are reclaimed** — the daily maintenance sweep deletes PENDING rows older
  than 24h together with their objects (counts logged in `maintenance.sweep`).
- **Local-disk deployments** — the direct routes return an honest 501 and the client
  (`uploadFile` in lib/client.ts) falls back to the classic multipart transport transparently
  (probe is sticky per page load). The returned DTO shape is identical for both transports.
- **Idempotent completion** — re-calling complete on a READY asset returns the same row.

Not implemented (unchanged scope): FFmpeg transcoding / variant pipeline (§4 target design)
and a CDN in front of the private bucket (delivery is still app-authorized; public-class
media now carries `Cache-Control: public, max-age=3600` — see docs/ops/RUNBOOK.md §caching).

## 6. Remaining production upgrades — **NOT YET IMPLEMENTED**

The storage layer + large-file transport above make media **persistent and unbounded** in
production. What is still missing is processing:

Target architecture for the production blueprint (S3-compatible storage + worker):

```
Browser                    API (NestJS)                  Object storage (S3)         Worker
───────                    ────────────                  ───────────────────         ──────
1. POST /media/sign
   { kind, size, mime } ──► validate + rate limit
   ◄── { uploadUrl, mediaId } (presigned PUT, short TTL)
2. PUT bytes ──────────────────────────────────────────► uploads/<mediaId> (original)
3. POST /media/complete { mediaId } ──► create MediaAsset (status=PENDING)
                                         enqueue job ───────────────────────► pick up job
                                                                              ├─ verify magic bytes (again, server-side)
                                                                              ├─ FFmpeg: video → mp4 (H.264) + poster/thumbnail frames
                                                                              ├─ image → resized variants (cover/card/thumb), strip EXIF
                                                                              ├─ audio → duration probe, waveform optional
                                                                              ├─ status → READY, write width/height/duration
                                                                              └─ retries with backoff; poison → FAILED + alert
4. client polls GET /media/:id ──► { status: READY, variants: {…} }
```

Design decisions to carry over from the as-built rules:

| Concern | Production rule |
|---|---|
| Validation | Magic-byte checks move to the worker (defense in depth); the API still caps kind+size at sign time. Strip EXIF/GPS from images |
| Storage | ✅ implemented — `src/lib/storage.ts` (S3 driver, env names below); object keys `uploads/<ownerId>/<mediaKey>.<ext>` |
| Serving | Signed GET URLs or a CDN in front of the bucket; the authorization ladder (owner / avatar-cover / project visibility) is evaluated when minting URLs, and private media gets short-TTL signed URLs instead of `private` cache-control on an app route |
| Large uploads | Vercel functions cap request bodies at ~4.5 MB — the current server-side upload works for typical images but NOT for large videos. The presigned-PUT flow below is the designed fix |
| Job durability | `MediaJob` table: `{ id, mediaId, type, attempts, status: PENDING\|RUNNING\|READY\|FAILED, error, lockedAt, runAfter }` — idempotency key = `(mediaId, type)` so retries never duplicate outputs |
| Retries | Exponential backoff, max N attempts, then FAILED + monitoring alert (`docs/deployment.md` §5) |
| Abandoned uploads | Cleanup job deletes S3 objects with no `MediaAsset` completion after 24h (stale presigned PUTs), and orphaned originals whose owning project/media rows were deleted |
| Uploads UX | The existing XHR progress pattern becomes a direct-to-S3 PUT with progress; `uploadFile()` in `src/lib/client.ts` keeps its signature and swaps the transport |
| Video posters | FFmpeg extracts a poster frame at N seconds; cover fallback logic in the publish gate can reuse it |

Migration notes: `MediaAsset.storagePath` already stores object-storage keys for new uploads
(`uploads/<ownerId>/…`); a `PENDING` status and variant-aware URLs arrive with the worker above.

## 7. Related docs

`docs/security.md` §6 (upload safety) · `docs/database.md` §1 (MediaAsset model) ·
`docs/deployment.md` (where S3 env vars come from) · `docs/known-limitations.md` (local-disk
limitation)
