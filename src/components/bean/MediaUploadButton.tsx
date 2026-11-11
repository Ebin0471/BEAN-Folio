"use client";

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { uploadFile } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { MediaDTO } from "@/lib/types";

const ACCEPT_BY_KIND: Record<string, string> = {
  IMAGE: "image/jpeg,image/png,image/webp,image/gif",
  VIDEO: "video/mp4,video/webm,video/quicktime",
  AUDIO: "audio/mpeg,audio/mp4,audio/wav,audio/ogg",
  // PDFs, OOXML office documents, text formats and zip-based design sources
  // (the server still sniffs real content — this only filters the picker).
  DOCUMENT:
    "application/pdf,.docx,.pptx,.xlsx,.zip,.sketch,.xd,.key,text/plain,.md,.csv,.json,.html,.css,.js",
  ANY: "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg,application/pdf,.docx,.pptx,.xlsx,.zip,.sketch,.xd,.key,.txt,.md,.csv,.json,.html,.css,.js",
};

/**
 * Upload button with progress. On success calls onUploaded with the media DTO.
 * Validation errors from the server are surfaced via toast.
 */
export function MediaUploadButton({
  kind = "ANY",
  label = "Upload media",
  onUploaded,
  variant = "outline",
  size = "default",
  className,
  disabled,
}: {
  kind?: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "ANY";
  label?: string;
  onUploaded: (media: MediaDTO) => void;
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  async function handleFile(file: File) {
    setBusy(true);
    setProgress(0);
    try {
      const res = await uploadFile(file, setProgress);
      onUploaded(res.media);
      toast.success("Upload complete");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
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
        accept={ACCEPT_BY_KIND[kind]}
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
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
        {busy ? `${progress}%` : label}
      </Button>
      {busy && (
        <Progress value={progress} className="mt-2 h-1.5 w-full" aria-label="Upload progress" />
      )}
    </>
  );
}
