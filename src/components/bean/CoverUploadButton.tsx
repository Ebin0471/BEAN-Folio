"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { uploadFile } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { MediaDTO } from "@/lib/types";

/**
 * Cover upload button — picks a single image (JPG/JPEG/PNG/WebP) and hands the
 * resulting MediaDTO to onUploaded. The cover is linked as the project's
 * coverMediaId, independent of the regular media list, so it never consumes
 * one of the 30 media slots.
 *
 * Client-side type/size checks give instant feedback; the server still sniffs
 * magic bytes as the source of truth (lib/media.ts) and the PATCH/POST
 * project endpoints verify ownership before linking the cover.
 */

const COVER_ACCEPT = "image/jpeg,image/png,image/webp";
const COVER_MAX_BYTES = 8 * 1024 * 1024; // mirrors MEDIA_RULES.IMAGE in lib/media.ts
const COVER_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Returns an error message when the file can't be a cover, or null when valid. */
export function validateCoverFile(file: File): string | null {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (!COVER_MIMES.has(mime) || !/\.(jpe?g|png|webp)$/.test(name)) {
    return "Covers must be JPG, JPEG, PNG or WebP images.";
  }
  if (file.size === 0) return "That file is empty — choose a valid image.";
  if (file.size > COVER_MAX_BYTES) return "Cover image exceeds the 8MB limit.";
  return null;
}

export function CoverUploadButton({
  label = "Upload cover",
  onUploaded,
  variant = "outline",
  size = "default",
  className,
  disabled,
  showProgress = true,
}: {
  label?: string;
  onUploaded: (media: MediaDTO) => void;
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  disabled?: boolean;
  /** Render the slim progress bar below the button (label always shows %). */
  showProgress?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function handleFile(file: File) {
    const invalid = validateCoverFile(file);
    if (invalid) {
      toast.error(invalid);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const res = await uploadFile(file, setProgress);
      onUploaded(res.media);
      toast.success("Cover updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cover upload failed");
    } finally {
      setBusy(false);
      setProgress(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={COVER_ACCEPT}
        className="sr-only"
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={busy || disabled}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ImagePlus className="size-4" aria-hidden />}
        {busy ? `${progress}%` : label}
      </Button>
      {busy && showProgress && (
        <Progress value={progress} className="mt-2 h-1.5 w-full" aria-label="Cover upload progress" />
      )}
    </>
  );
}
