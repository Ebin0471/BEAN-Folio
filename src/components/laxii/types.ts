"use client";

/**
 * LAXII Studio client types — mirrored shapes of the /api/laxii/* payloads.
 */

export interface LaxiiOutputImage {
  mediaAssetId: string;
  width: number;
  height: number;
  format?: string;
  bytes?: number;
  sharpness?: number;
}

export interface LaxiiChatMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  text: string | null;
  operation: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  stage: string | null;
  progress: number;
  parentAssetId: string | null;
  refs: string[];
  outputs: LaxiiOutputImage[];
  selectedAssetId: string | null;
  error: string | null;
  meta: { providerLabel?: string; model?: string | null; estimatedCostUSD?: number | null; note?: string } | null;
  jobId: string | null;
  createdAt: string;
}

export interface LaxiiConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: "managed" | "diffusers" | "gemini" | "openai";
  label: string;
  kind: "managed-api" | "local-gpu" | "external-paid";
  available: boolean;
  reason?: string;
  isDefault: boolean;
  capabilities: {
    textToImage: boolean;
    imageToImage: boolean;
    conversationalEditing: "native" | "synthetic";
    maxReferences: number;
    aspectRatios: string[];
    maxOutputPixels: number;
    transparentBackground: boolean;
    upscaleNative: boolean;
    models: ProviderModel[];
    costEstimateUSDPerImage: Record<string, number>;
    costBasis: string;
    notes: string[];
  };
}

export interface BannerPresetInfo {
  id: string;
  label: string;
  description: string;
  width: number;
  height: number;
  safeArea: { x: number; y: number; w: number; h: number } | null;
  formats: ("PNG" | "JPEG" | "WEBP")[];
  maxBytes: number | null;
}

export interface LibraryAsset {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  laxiiKind: string | null;
  favourite: boolean;
}

export interface MediaDTO {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

export const CHAT_OPERATIONS = [
  { id: "AUTO", label: "Auto", hint: "Infer from your prompt" },
  { id: "GENERATE", label: "Create", hint: "Text-to-image (optionally with references)" },
  { id: "EDIT", label: "Edit", hint: "Instruction edit of the selected image" },
  { id: "VARIATIONS", label: "Variations", hint: "Fresh takes on the selected image" },
  { id: "REMOVE_BG", label: "Remove BG", hint: "Transparent PNG cutout (local MODNet)" },
  { id: "OUTPAINT", label: "Expand", hint: "Generative canvas expansion" },
  { id: "UPSCALE", label: "Upscale", hint: "2× / 4× resolution" },
  { id: "BANNER", label: "Banner", hint: "Platform banner with safe areas" },
] as const;

export const ASPECTS = ["1:1", "4:5", "3:2", "16:9", "21:9", "9:16"] as const;

export function mediaUrl(id: string): string {
  return `/api/media/${id}/raw`;
}
