/**
 * Design-job durability shadow (Phase 4, audit §4 "jobs stored only in memory").
 *
 * The website-design pipeline keeps its live stepping in memory (unchanged
 * behavior — tests and UX depend on it). This module ADDITIVELY persists the
 * terminal state of every design job as an AgentTask row (kind SITE_DESIGN_JOB)
 * so completed/failed/cancelled history survives a server restart. It never
 * throws into the pipeline: a persistence hiccup is logged, never surfaced.
 */

import { db } from "@/lib/db";

import type { DesignJob } from "./jobs";
import type { VerificationReport } from "./verify";

const KIND = "SITE_DESIGN_JOB";
const AGENT = "CODE_GIFTZ";

/** Persist (create or update) the terminal record for one design job. */
export async function persistDesignJobTerminalState(job: DesignJob): Promise<void> {
  try {
    const resultJson = JSON.stringify({
      jobId: job.id,
      request: job.plan?.reply ?? null,
      status: job.status,
      changes: job.changes.slice(0, 16),
      error: job.error ?? null,
      steps: job.steps.map((s) => ({
        id: s.id,
        title: s.title,
        tool: s.tool,
        targets: s.targets,
        status: s.status,
        error: s.error ?? null,
      })),
      verification: summarizeVerification(job.verification ?? null),
    });

    const existing = await db.agentTask.findFirst({
      where: { userId: job.userId, kind: KIND, agent: AGENT, resultJson: { contains: job.id } },
      select: { id: true },
    });

    const title = (job.plan?.reply ?? "Site design execution").slice(0, 80);
    const status =
      job.status === "completed" ? "COMPLETED" : job.status === "failed" ? "FAILED" : "CANCELLED";

    if (existing) {
      await db.agentTask.update({
        where: { id: existing.id },
        data: { title, status, resultJson, error: job.error ?? null },
      });
    } else {
      await db.agentTask.create({
        data: {
          userId: job.userId,
          agent: AGENT,
          kind: KIND,
          title,
          status,
          stepsJson: JSON.stringify([{ step: "execute", status: job.status === "completed" ? "done" : job.status === "failed" ? "failed" : "skipped" }]),
          resultJson,
          error: job.error ?? null,
        },
      });
    }
  } catch (error) {
    console.error("[ai-design] durability shadow write failed:", error instanceof Error ? error.message : error);
  }
}

function summarizeVerification(report: VerificationReport | null): { passed: number; warned: number; failed: number; untested: string[]; checks: { label: string; status: string }[] } | null {
  if (!report) return null;
  return {
    passed: report.passed,
    warned: report.warned,
    failed: report.failed,
    untested: report.untested,
    checks: (report.checks ?? []).map((c) => ({ label: c.label, status: c.status })),
  };
}
