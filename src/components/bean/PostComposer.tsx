"use client";

import { useRef, useState } from "react";
import { FileText, Film, ImagePlus, Images, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/bean/TagInput";
import { api, uploadFile } from "@/lib/client";
import { useProfessionOptions } from "@/lib/use-professions";
import type { MediaDTO, PublicPost } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Create Post composer for the Discover homepage — real uploads through the
 * existing secure media infrastructure (`uploadFile` → /api/media/upload or
 * the presigned direct flow) and REAL persistence via POST /api/posts.
 * Nothing is simulated: upload or creation failures surface as errors and
 * the post is not added to the feed.
 *
 * Modes: Text update · Image post (1..8, carousel) · Video/reel post
 * (+ optional image thumbnail). Caption + hashtags apply to every mode.
 */

type Mode = "text" | "image" | "video";

interface PendingMedia {
  asset: MediaDTO;
  altText: string;
}

export function PostComposer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (post: PublicPost) => void;
}) {
  const [mode, setMode] = useState<Mode>("text");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [profession, setProfession] = useState<string>("");
  const [images, setImages] = useState<PendingMedia[]>([]);
  const [video, setVideo] = useState<PendingMedia | null>(null);
  const [poster, setPoster] = useState<MediaDTO | null>(null);
  const [uploading, setUploading] = useState(0); // in-flight upload count
  const [submitting, setSubmitting] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const posterInputRef = useRef<HTMLInputElement>(null);

  const professionOptions = useProfessionOptions();

  function reset() {
    setMode("text");
    setBody("");
    setTags([]);
    setProfession("");
    setImages([]);
    setVideo(null);
    setPoster(null);
  }

  async function handleUpload(file: File): Promise<MediaDTO | null> {
    setUploading((n) => n + 1);
    try {
      const res = await uploadFile(file);
      return res.media;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
      return null;
    } finally {
      setUploading((n) => n - 1);
    }
  }

  async function onImagesChosen(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = 8 - images.length;
    if (room <= 0) {
      toast.error(`An image post can contain at most 8 images`);
      return;
    }
    const list = Array.from(files).slice(0, room);
    for (const f of list) {
      if (!f.type.startsWith("image/")) {
        toast.error(`${f.name}: images only for photo posts`);
        continue;
      }
      const media = await handleUpload(f);
      if (media) setImages((prev) => [...prev, { asset: media, altText: "" }]);
    }
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  async function onVideoChosen(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      toast.error("Video posts need a video file (mp4, webm or mov)");
      return;
    }
    const media = await handleUpload(f);
    if (media) setVideo({ asset: media, altText: "" });
    if (videoInputRef.current) videoInputRef.current.value = "";
  }

  async function onPosterChosen(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("The thumbnail must be an image");
      return;
    }
    const media = await handleUpload(f);
    if (media) setPoster(media);
    if (posterInputRef.current) posterInputRef.current.value = "";
  }

  const canSubmit =
    !submitting &&
    uploading === 0 &&
    (mode === "text"
      ? body.trim().length > 0
      : mode === "image"
        ? images.length > 0
        : video !== null);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const payload =
        mode === "text"
          ? { body, hashtags: tags, profession: profession || null, visibility: "PUBLIC", media: [] }
          : mode === "image"
            ? {
                body,
                hashtags: tags,
                profession: profession || null,
                visibility: "PUBLIC",
                media: images.map((m) => ({ mediaAssetId: m.asset.id, altText: m.altText })),
              }
            : {
                body,
                hashtags: tags,
                profession: profession || null,
                visibility: "PUBLIC",
                media: video ? [{ mediaAssetId: video.asset.id, altText: video.altText }] : [],
                posterMediaAssetId: mode === "video" && poster ? poster.id : null,
              };
      const created = await api<PublicPost>("/api/posts", {
        method: "POST",
        json: payload,
      });
      onCreated(created);
      toast.success("Posted");
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the post");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border/60 bg-background sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display">Create a post</DialogTitle>
        </DialogHeader>

        {/* mode switch */}
        <div className="grid grid-cols-3 gap-2" role="tablist" aria-label="Post type">
          {(
            [
              { id: "text", label: "Text", icon: FileText },
              { id: "image", label: "Photos", icon: Images },
              { id: "video", label: "Video / Reel", icon: Film },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                mode === id
                  ? "border-primary/60 bg-gold-soft text-foreground"
                  : "border-border/60 text-muted-foreground hover:border-primary/30 hover:text-foreground"
              )}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          ))}
        </div>

        {/* caption + tags (all modes) */}
        <div className="space-y-3">
          {mode === "text" ? (
            <div>
              <Label htmlFor="post-body">Your update</Label>
              <Textarea
                id="post-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                maxLength={2000}
                placeholder="Share a professional update, question, insight or announcement… #hashtags"
                className="mt-1.5"
              />
            </div>
          ) : (
            <div>
              <Label htmlFor="post-caption">Caption</Label>
              <Textarea
                id="post-caption"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="Add a caption… #hashtags"
                className="mt-1.5"
              />
            </div>
          )}

          {/* media pickers */}
          {mode === "image" ? (
            <div>
              <div className="flex items-center justify-between">
                <Label>Photos ({images.length}/8)</Label>
                <Button variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} disabled={uploading > 0 || images.length >= 8}>
                  <ImagePlus className="size-4" aria-hidden /> Add photos
                </Button>
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                className="sr-only"
                aria-label="Choose images"
                onChange={(e) => void onImagesChosen(e.target.files)}
              />
              {images.length > 0 ? (
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {images.map((m, i) => (
                    <div key={m.asset.id} className="group relative overflow-hidden rounded-lg border border-border/60">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.asset.url} alt={m.altText || `Upload ${i + 1}`} className="aspect-square w-full object-cover" />
                      <button
                        type="button"
                        aria-label={`Remove image ${i + 1}`}
                        onClick={() => setImages((prev) => prev.filter((x) => x.asset.id !== m.asset.id))}
                        className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-foreground shadow hover:text-destructive"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">Multiple photos become a carousel post.</p>
              )}
            </div>
          ) : null}

          {mode === "video" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Video</Label>
                <Button variant="outline" size="sm" onClick={() => videoInputRef.current?.click()} disabled={uploading > 0}>
                  <Film className="size-4" aria-hidden /> {video ? "Replace video" : "Choose video"}
                </Button>
              </div>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="sr-only"
                aria-label="Choose a video"
                onChange={(e) => void onVideoChosen(e.target.files)}
              />
              {video ? (
                <div className="flex items-center gap-3 rounded-lg border border-border/60 p-2">
                  <div className="w-20 shrink-0 overflow-hidden rounded-md bg-black">
                    {poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={poster.url} alt="Video thumbnail" className="aspect-video w-full object-cover" />
                    ) : (
                      <video src={video.asset.url} muted playsInline preload="metadata" className="aspect-video w-full object-cover" aria-label="Selected video preview" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-xs">
                    <p className="truncate font-medium">{video.asset.url.split("/").pop()}</p>
                    <p className="text-muted-foreground">{(video.asset.size / 1024 / 1024).toFixed(1)} MB · ready</p>
                    <div className="mt-1 flex items-center gap-2">
                      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => posterInputRef.current?.click()} disabled={uploading > 0}>
                        {poster ? "Replace thumbnail" : "Add thumbnail"}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          setVideo(null);
                          setPoster(null);
                        }}
                      >
                        <Trash2 className="size-3" aria-hidden /> Remove
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">mp4, webm or mov — up to 64 MB. A thumbnail is optional.</p>
              )}
              <input
                ref={posterInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-label="Choose a video thumbnail"
                onChange={(e) => void onPosterChosen(e.target.files)}
              />
            </div>
          ) : null}

          {/* hashtags + category */}
          <div>
            <Label>Hashtags</Label>
            <div className="mt-1.5">
              <TagInput value={tags} onChange={setTags} placeholder="editing, motiondesign…" max={12} ariaLabel="Hashtags" />
            </div>
          </div>
          <div>
            <Label>Category (profession)</Label>
            <Select value={profession} onValueChange={setProfession}>
              <SelectTrigger className="mt-1.5 w-full" aria-label="Post category">
                <SelectValue placeholder="Optional category" />
              </SelectTrigger>
              <SelectContent>
                {professionOptions.map((p) => (
                  <SelectItem key={p.slug} value={p.slug}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {uploading > 0 ? (
            <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Uploading…
            </span>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Post
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
