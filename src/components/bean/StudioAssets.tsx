"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Film, Image as ImageIcon, Music, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/bean/EmptyState";
import { MediaThumb } from "@/components/bean/MediaThumb";

/**
 * Studio Asset Library — one shared library for every professional asset the
 * creator has uploaded anywhere in the product (profile imagery, project
 * covers and galleries, LAXII references, Code Giftz materials). Read-only
 * here on purpose: uploads keep flowing through the existing upload flows and
 * deletion stays on DELETE /api/media/:id with its in-use guards, so the
 * library can never break a published page by deleting a referenced file.
 */

interface AssetItem {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  url: string;
  usedInProjects: number;
}

interface AssetsResponse {
  assets: AssetItem[];
  total: number;
  storage: { bytes: number; count: number };
}

const KIND_FILTERS = [
  { value: "*", label: "All types" },
  { value: "IMAGE", label: "Images" },
  { value: "VIDEO", label: "Videos" },
  { value: "AUDIO", label: "Audio" },
  { value: "DOCUMENT", label: "Documents" },
] as const;

const PAGE_SIZE = 60;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "size-3.5";
  if (kind === "VIDEO") return <Film className={cls} aria-hidden />;
  if (kind === "AUDIO") return <Music className={cls} aria-hidden />;
  if (kind === "DOCUMENT") return <FileText className={cls} aria-hidden />;
  return <ImageIcon className={cls} aria-hidden />;
}

function AssetTile({
  asset,
  busy,
  onRequestDelete,
}: {
  asset: AssetItem;
  busy: boolean;
  onRequestDelete: (a: AssetItem) => void;
}) {
  const isImage = asset.kind === "IMAGE";
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="relative w-full">
        {isImage ? (
          <MediaThumb src={asset.url} alt={asset.filename} aspect="aspect-square" className="w-full" />
        ) : (
          <div className="grid aspect-square w-full place-items-center bg-muted/40 text-muted-foreground" aria-hidden>
            {asset.kind === "VIDEO" ? <Film className="size-8" /> : asset.kind === "AUDIO" ? <Music className="size-8" /> : <FileText className="size-8" />}
          </div>
        )}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground backdrop-blur">
          <KindIcon kind={asset.kind} /> {asset.kind}
        </span>
        {asset.usedInProjects > 0 && (
          <span className="absolute right-2 top-2">
            <Badge className="rounded-full border-transparent bg-primary/10 text-primary ring-1 ring-primary/30" title="Attached to this many projects">
              {asset.usedInProjects} {asset.usedInProjects === 1 ? "use" : "uses"}
            </Badge>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-1 text-xs font-medium text-foreground" title={asset.filename}>
          {asset.filename}
        </p>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {formatBytes(asset.size)}
          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          {` · ${formatDateTime(asset.createdAt)}`}
        </p>
        <div className="mt-auto flex items-center gap-1 pt-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => {
              void navigator.clipboard
                .writeText(asset.url.startsWith("http") ? asset.url : `${window.location.origin}${asset.url}`)
                .then(() => toast.success("File link copied"))
                .catch(() => toast.error("Could not copy the link"));
            }}
          >
            Copy link
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${asset.filename}`}
            disabled={busy}
            onClick={() => onRequestDelete(asset)}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </li>
  );
}

export default function StudioAssets() {
  const [kind, setKind] = useState<string>("*");
  const [data, setData] = useState<AssetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (k: string) => {
    setLoading(true);
    setError(null);
    try {
      const qs = k === "*" ? "" : `&kind=${encodeURIComponent(k)}`;
      const res = await api<AssetsResponse>(`/api/media?limit=${PAGE_SIZE}${qs}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your assets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(kind);
  }, [kind, load]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setBusyId(deleteTarget.id);
    try {
      await api(`/api/media/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`"${deleteTarget.filename}" deleted`);
      setDeleteTarget(null);
      await load(kind);
    } catch (e) {
      // 409 = still referenced somewhere — the server's message is actionable.
      toast.error(e instanceof Error ? e.message : "Could not delete asset");
    } finally {
      setDeleting(false);
      setBusyId(null);
    }
  }

  const visible = data?.assets ?? [];
  const showEmpty = !loading && !error && data !== null && visible.length === 0;
  const kindLabel = useMemo(() => KIND_FILTERS.find((f) => f.value === kind)?.label ?? "assets", [kind]);

  return (
    <section aria-label="Asset library">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? "Loading your library…"
            : error
              ? ""
              : data
                ? `${data.total} ${data.total === 1 ? "asset" : "assets"} · ${formatBytes(data.storage.bytes)} used across ${data.storage.count} ${data.storage.count === 1 ? "file" : "files"}`
                : ""}
        </p>
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="h-9 w-full rounded-full text-xs sm:w-40" aria-label="Filter assets by type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => void load(kind)}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      <div className="mt-4">
        {loading && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading assets">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="overflow-hidden rounded-xl border border-border/60 bg-card">
                <Skeleton className="aspect-square w-full rounded-none" />
                <div className="space-y-1.5 p-3">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {!loading && error && (
          <EmptyState
            icon={RefreshCw}
            title="Something went wrong"
            description={error}
            action={<Button onClick={() => void load(kind)}>Try again</Button>}
          />
        )}

        {showEmpty && (
          <EmptyState
            icon={ImageIcon}
            title={`No ${kindLabel.toLowerCase()} yet`}
            description="Files you upload anywhere in BEAN Folio — project covers and galleries, profile imagery, LAXII references or Code Giftz materials — collect here automatically."
          />
        )}

        {!loading && !error && visible.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((a) => (
              <AssetTile key={a.id} asset={a} busy={busyId === a.id} onRequestDelete={setDeleteTarget} />
            ))}
          </ul>
        )}
      </div>

      {/* Delete confirmation — mirrors the project delete pattern; in-use files are refused server-side with an actionable message. */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.filename}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the file. Files still attached to a project, profile or website are refused — remove those uses first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete file"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
