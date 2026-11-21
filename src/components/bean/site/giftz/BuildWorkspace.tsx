"use client";

/**
 * BuildWorkspace — the GIFTZ "Build" tab (contract §8): everything around the
 * generated website's project files that is NOT the canvas:
 *
 *   · Run build + latest build card (status, duration, checks, summary)
 *   · Diagnostics (error red / warning amber rows, monospace)
 *   · Build history (collapsed by default)
 *   · Deployment history (LIVE/FAILED/ROLLED_BACK badges, Rollback on LIVE rows)
 *   · Custom domains (add / verify / delete + the honest routing note)
 *   · Activity feed (latest 30, kind icons, relative times)
 *
 * Every section loads on mount and loads again via the manual refresh button.
 * Failures are honest per-section error states — never fabricated success.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity as ActivityIcon,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  FileMinus2,
  FilePen,
  FilePlus2,
  Globe,
  Hammer,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addSiteDomain,
  deleteSiteDomain,
  getSiteBuild,
  listSiteActivity,
  listSiteBuilds,
  listSiteDeployments,
  listSiteDomains,
  rollbackSiteDeployment,
  runSiteBuild,
  verifySiteDomain,
  type GiftzActivityDTO,
  type GiftzBuildDTO,
  type GiftzDeploymentDTO,
  type GiftzDomainDTO,
} from "@/lib/giftz-client";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------ helpers

function statusTone(status: string): string {
  if (status === "SUCCEEDED" || status === "LIVE" || status === "VERIFIED") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "FAILED") {
    return "border-destructive/40 bg-destructive/10 text-destructive";
  }
  if (status === "PENDING" || status === "BUILDING" || status === "QUEUED" || status === "DEPLOYING" || status === "PREPARING") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  return "border-border/60 bg-muted/40 text-muted-foreground"; // ROLLED_BACK and friends
}

/** "2m ago"-style relative labels (Intl.RelativeTimeFormat). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86400), "day");
}

function durationLabel(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  "site.create": Sparkles,
  "ai.compose": Sparkles,
  "ai.edit": FilePen,
  "file.write": FilePen,
  "file.delete": FileMinus2,
  "file.rename": FilePen,
  build: Hammer,
  deploy: CloudUpload,
  publish: Globe,
  unpublish: Globe,
  "version.save": History,
  "version.restore": RotateCcw,
  "domain.add": Globe,
  "domain.verify": ShieldCheck,
};

/** Honest routing note (contract §7.3 — shown verbatim in the domains section). */
const DOMAIN_ROUTING_NOTE =
  "DNS verified does not mean traffic is routed: external proxy/DNS configuration is required and is not available in this environment.";

// ------------------------------------------------------------------ component

export function BuildWorkspace({
  siteId,
  refreshToken,
  className,
}: {
  siteId: string;
  /** Bumped by the parent after saves / applies — reloads every section. */
  refreshToken: number;
  className?: string;
}) {
  const [builds, setBuilds] = useState<GiftzBuildDTO[] | null>(null);
  const [latestBuild, setLatestBuild] = useState<GiftzBuildDTO | null>(null);
  const [buildsError, setBuildsError] = useState<string | null>(null);
  const [runningBuild, setRunningBuild] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [deployments, setDeployments] = useState<GiftzDeploymentDTO[] | null>(null);
  const [adapterNote, setAdapterNote] = useState<string | null>(null);
  const [deploymentsError, setDeploymentsError] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  const [domains, setDomains] = useState<GiftzDomainDTO[] | null>(null);
  const [domainsError, setDomainsError] = useState<string | null>(null);
  const [newHostname, setNewHostname] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);
  const [busyDomainId, setBusyDomainId] = useState<string | null>(null);

  const [activity, setActivity] = useState<GiftzActivityDTO[] | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const loadBuilds = useCallback(async () => {
    try {
      const r = await listSiteBuilds(siteId);
      setBuilds(r.builds);
      setBuildsError(null);
      // The list omits diagnostics — fetch the newest build's full detail.
      if (r.builds[0]) {
        try {
          const detail = await getSiteBuild(siteId, r.builds[0].id);
          setLatestBuild(detail.build);
        } catch {
          setLatestBuild(r.builds[0]);
        }
      } else {
        setLatestBuild(null);
      }
    } catch (e) {
      setBuildsError(e instanceof Error ? e.message : "Could not load builds");
    }
  }, [siteId]);

  const loadDeployments = useCallback(async () => {
    try {
      const r = await listSiteDeployments(siteId);
      setDeployments(r.deployments);
      setAdapterNote(r.adapter?.note ?? null);
      setDeploymentsError(null);
    } catch (e) {
      setDeploymentsError(e instanceof Error ? e.message : "Could not load deployments");
    }
  }, [siteId]);

  const loadDomains = useCallback(async () => {
    try {
      const r = await listSiteDomains(siteId);
      setDomains(r.domains);
      setDomainsError(null);
    } catch (e) {
      setDomainsError(e instanceof Error ? e.message : "Could not load domains");
    }
  }, [siteId]);

  const loadActivity = useCallback(async () => {
    try {
      const r = await listSiteActivity(siteId);
      setActivity(r.activity.slice(0, 30));
      setActivityError(null);
    } catch (e) {
      setActivityError(e instanceof Error ? e.message : "Could not load activity");
    }
  }, [siteId]);

  const reloadAll = useCallback(() => {
    void loadBuilds();
    void loadDeployments();
    void loadDomains();
    void loadActivity();
  }, [loadBuilds, loadDeployments, loadDomains, loadActivity]);

  useEffect(() => {
    setBuilds(null);
    setDeployments(null);
    setDomains(null);
    setActivity(null);
    reloadAll();
  }, [siteId, refreshToken, reloadAll]);

  const handleRunBuild = async () => {
    setRunningBuild(true);
    try {
      const r = await runSiteBuild(siteId);
      setLatestBuild(r.build);
      setBuilds((prev) => [r.build, ...(prev ?? []).filter((b) => b.id !== r.build.id)]);
      if (r.build.status === "SUCCEEDED") toast.success("Build succeeded", { description: r.build.summary ?? undefined });
      else toast.error("Build failed", { description: r.build.summary ?? "Check the diagnostics below." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not run the build");
    } finally {
      setRunningBuild(false);
    }
  };

  const handleRollback = async (deploymentId: string) => {
    setRollingBackId(deploymentId);
    try {
      const r = await rollbackSiteDeployment(siteId, deploymentId);
      toast.success("Rolled back — the selected deployment is live again");
      setDeployments((prev) => [r.deployment, ...(prev ?? []).filter((d) => d.id !== r.deployment.id)]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not roll back");
    } finally {
      setRollingBackId(null);
    }
  };

  const handleAddDomain = async () => {
    const hostname = newHostname.trim().toLowerCase();
    if (!/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,}$/.test(hostname)) {
      toast.error("Enter a valid hostname — for example www.example.com (no scheme, no path).");
      return;
    }
    setAddingDomain(true);
    try {
      const r = await addSiteDomain(siteId, hostname);
      setDomains((prev) => [r.domain, ...(prev ?? []).filter((d) => d.id !== r.domain.id)]);
      setNewHostname("");
      toast.success("Domain added — run Verify once the DNS records exist");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add the domain");
    } finally {
      setAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (domainId: string) => {
    setBusyDomainId(domainId);
    try {
      const r = await verifySiteDomain(siteId, domainId);
      setDomains((prev) => (prev ?? []).map((d) => (d.id === r.domain.id ? r.domain : d)));
      if (r.domain.status === "VERIFIED") toast.success(`${r.domain.hostname} verified`, { description: r.routingNote ?? DOMAIN_ROUTING_NOTE });
      else if (r.domain.status === "FAILED") toast.error(`Verification failed for ${r.domain.hostname}`, { description: r.domain.lastError ?? undefined });
      else toast.info(`${r.domain.hostname} not found yet`, { description: r.domain.lastError ?? "The DNS records do not exist yet — status stays PENDING." });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not verify the domain");
    } finally {
      setBusyDomainId(null);
    }
  };

  const handleDeleteDomain = async (domainId: string) => {
    setBusyDomainId(domainId);
    try {
      await deleteSiteDomain(siteId, domainId);
      setDomains((prev) => (prev ?? []).filter((d) => d.id !== domainId));
      toast.success("Domain removed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the domain");
    } finally {
      setBusyDomainId(null);
    }
  };

  const diagnostics = latestBuild?.diagnostics ?? [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  return (
    <div className={cn("min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5", className)} style={{ scrollbarWidth: "thin" }}>
      {/* ---------------- build ---------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60 p-3" aria-label="Build">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-xs font-semibold text-foreground">Build</h3>
          <Button size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-[11px]" onClick={() => void handleRunBuild()} disabled={runningBuild}>
            {runningBuild ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Hammer className="size-3.5" aria-hidden />}
            Run build
          </Button>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground" onClick={reloadAll} title="Refresh builds, deployments, domains and activity">
            <RefreshCw className="size-3.5" aria-hidden /> Refresh
          </Button>
        </div>

        {buildsError ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5" role="alert">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {buildsError}
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void loadBuilds()}>
              <RefreshCw className="size-3" aria-hidden /> Retry
            </Button>
          </div>
        ) : !builds ? (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading builds…
          </p>
        ) : latestBuild ? (
          <div className="mt-2 rounded-md border border-border/60 bg-background/60 p-2.5">
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", statusTone(latestBuild.status))}>
                {latestBuild.status}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={latestBuild.summary ?? undefined}>
                {latestBuild.summary ?? "No summary recorded."}
              </span>
              {durationLabel(latestBuild.durationMs) && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{durationLabel(latestBuild.durationMs)}</span>}
              {latestBuild.checksRun !== null && <span className="shrink-0 text-[11px] text-muted-foreground">{latestBuild.checksRun} checks</span>}
              <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(latestBuild.createdAt)}</span>
            </p>
            {diagnostics.length > 0 && (
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }} aria-label="Build diagnostics">
                {diagnostics.map((d, i) => (
                  <li
                    key={`${d.path}-${i}`}
                    className={cn(
                      "flex items-start gap-1.5 rounded border px-2 py-1",
                      d.severity === "error" ? "border-destructive/40 bg-destructive/10" : "border-amber-500/40 bg-amber-500/10"
                    )}
                  >
                    {d.severity === "error" ? (
                      <XCircle className="mt-0.5 size-3 shrink-0 text-destructive" aria-label="error" />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-3 shrink-0 text-amber-500" aria-label="warning" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[11px] text-foreground/90">{d.path}</span>
                      <span className="block break-words font-mono text-[11px] leading-snug text-muted-foreground">{d.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {diagnostics.length === 0 && latestBuild.status === "SUCCEEDED" && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" aria-hidden /> All checks passed — no diagnostics.
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-muted-foreground">No builds yet — run one to validate the project files.</p>
        )}

        {builds && builds.length > 1 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              aria-expanded={historyOpen}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            >
              <History className="size-3" aria-hidden /> Build history ({builds.length - 1})
            </button>
            {historyOpen && (
              <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
                {builds.slice(1).map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 rounded border border-border/50 bg-muted/20 px-2 py-1.5">
                    <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase", statusTone(b.status))}>{b.status}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{b.summary ?? b.trigger}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(b.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* ---------------- deployments ---------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60 p-3" aria-label="Deployments">
        <h3 className="text-xs font-semibold text-foreground">Deployment history</h3>
        {deploymentsError ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5" role="alert">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {deploymentsError}
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void loadDeployments()}>
              <RefreshCw className="size-3" aria-hidden /> Retry
            </Button>
          </div>
        ) : !deployments ? (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading deployments…
          </p>
        ) : deployments.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No deployments yet — publish the website to create one.</p>
        ) : (
          <ul className="mt-2 max-h-72 space-y-1.5 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {deployments.map((d) => (
              <li key={d.id} className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", statusTone(d.status))}>{d.status}</span>
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">{d.provider}</span>
                  {d.buildId && (
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70" title={`Built by build ${d.buildId}`}>
                      build {d.buildId.slice(0, 8)}
                    </span>
                  )}
                  {d.deployedAt && <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(d.deployedAt)}</span>}
                  {d.status === "LIVE" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      onClick={() => void handleRollback(d.id)}
                      disabled={rollingBackId !== null}
                      title="Roll the public site back to this deployment"
                    >
                      {rollingBackId === d.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <RotateCcw className="size-3" aria-hidden />} Rollback
                    </Button>
                  )}
                </p>
                {d.url && (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex max-w-full items-center gap-1 truncate rounded border border-primary/30 bg-gold-soft/40 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-gold-soft/70"
                    title="Open the deployed website"
                  >
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{d.url}</span>
                  </a>
                )}
                {d.error && <p className="mt-1 break-words text-[11px] leading-snug text-destructive">{d.error}</p>}
              </li>
            ))}
          </ul>
        )}
        {adapterNote && <p className="mt-2 text-[10px] leading-snug text-muted-foreground">{adapterNote}</p>}
      </section>

      {/* ---------------- domains ---------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60 p-3" aria-label="Custom domains">
        <h3 className="text-xs font-semibold text-foreground">Custom domains</h3>
        <div className="mt-2 flex gap-1.5">
          <Input
            value={newHostname}
            onChange={(e) => setNewHostname(e.target.value)}
            placeholder="www.example.com"
            aria-label="Custom domain hostname"
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddDomain();
            }}
          />
          <Button size="sm" className="h-8 shrink-0 gap-1 px-2 text-[11px]" onClick={() => void handleAddDomain()} disabled={addingDomain || newHostname.trim().length === 0}>
            {addingDomain ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />} Add
          </Button>
        </div>
        {domainsError ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5" role="alert">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {domainsError}
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void loadDomains()}>
              <RefreshCw className="size-3" aria-hidden /> Retry
            </Button>
          </div>
        ) : !domains ? (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading domains…
          </p>
        ) : domains.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No custom domains yet — add one and verify its DNS to claim it.</p>
        ) : (
          <ul className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {domains.map((d) => (
              <li key={d.id} className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{d.hostname}</span>
                  <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide", statusTone(d.status))}>{d.status}</span>
                  {d.status !== "VERIFIED" && (
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[11px]" onClick={() => void handleVerifyDomain(d.id)} disabled={busyDomainId !== null} title="Run the real DNS verification check">
                      {busyDomainId === d.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <ShieldCheck className="size-3" aria-hidden />} Verify
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${d.hostname}`}
                    onClick={() => void handleDeleteDomain(d.id)}
                    disabled={busyDomainId !== null}
                  >
                    {busyDomainId === d.id ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />}
                  </Button>
                </p>
                {d.lastError && <p className="mt-1 break-words text-[11px] leading-snug text-destructive">{d.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 rounded-md border border-border/60 bg-muted/30 p-2 text-[10px] leading-relaxed text-muted-foreground">{DOMAIN_ROUTING_NOTE}</p>
      </section>

      {/* ---------------- activity ---------------- */}
      <section className="rounded-lg border border-border/60 bg-card/60 p-3" aria-label="Activity">
        <h3 className="text-xs font-semibold text-foreground">Activity</h3>
        {activityError ? (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5" role="alert">
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {activityError}
            </p>
            <Button variant="outline" size="sm" className="mt-2 h-7 px-2 text-[11px]" onClick={() => void loadActivity()}>
              <RefreshCw className="size-3" aria-hidden /> Retry
            </Button>
          </div>
        ) : !activity ? (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading activity…
          </p>
        ) : activity.length === 0 ? (
          <p className="mt-2 text-[11px] text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto pr-0.5" style={{ scrollbarWidth: "thin" }}>
            {activity.map((a) => {
              const Icon = ACTIVITY_ICONS[a.kind] ?? ActivityIcon;
              const detailSummary =
                typeof a.detail?.summary === "string"
                  ? (a.detail.summary as string)
                  : typeof a.detail?.path === "string"
                    ? (a.detail.path as string)
                    : "";
              return (
                <li key={a.id} className="flex items-start gap-2 rounded border border-border/50 bg-muted/20 px-2 py-1.5">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-foreground/90">{a.kind}</span>
                    {detailSummary && <span className="block truncate text-[11px] leading-snug text-muted-foreground">{detailSummary}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{relativeTime(a.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
