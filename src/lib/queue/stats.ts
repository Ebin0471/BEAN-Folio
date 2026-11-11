/**
 * BEAN Folio — queue snapshot for /api/health.
 *
 * Policy: health is liveness plus value-free counters. This module reports
 * ONLY aggregate counts/ages — never error text, never user data. It never
 * throws: if the database is unreachable the counters degrade to nulls so a
 * DB outage cannot flip the liveness endpoint red.
 */

import { db } from "@/lib/db";

import { getWorkerStatus } from "./worker";

export type QueueStatusCounts = {
  QUEUED: number;
  RUNNING: number;
  SUCCEEDED: number;
  FAILED: number;
  DEAD: number;
  CANCELLED: number;
};

export interface QueueStats {
  /** Row counts by lifecycle status (zero-filled). */
  byStatus: QueueStatusCounts;
  /** Age of the oldest QUEUED job (scheduling pressure indicator). */
  oldestQueuedAgeMs: number | null;
  /** Jobs currently RUNNING across all workers (null when the snapshot failed). */
  runningCount: number | null;
  /** How long ago THIS process's worker last polled (null = no in-process worker). */
  lastTickAgoMs: number | null;
}

const EMPTY_COUNTS: QueueStatusCounts = {
  QUEUED: 0,
  RUNNING: 0,
  SUCCEEDED: 0,
  FAILED: 0,
  DEAD: 0,
  CANCELLED: 0,
};

export async function queueStats(): Promise<QueueStats> {
  try {
    const [grouped, oldestQueued] = await Promise.all([
      db.backgroundJob.groupBy({ by: ["status"], _count: { _all: true } }),
      db.backgroundJob.findFirst({
        where: { status: "QUEUED" },
        orderBy: { runAt: "asc" },
        select: { runAt: true },
      }),
    ]);

    const byStatus: QueueStatusCounts = { ...EMPTY_COUNTS };
    for (const row of grouped) {
      if ((row.status as keyof QueueStatusCounts) in byStatus) {
        byStatus[row.status as keyof QueueStatusCounts] = row._count._all;
      }
    }

    const worker = getWorkerStatus();
    const lastTickAgoMs = worker.lastTickAt ? Math.max(0, Date.now() - Date.parse(worker.lastTickAt)) : null;

    return {
      byStatus,
      oldestQueuedAgeMs: oldestQueued ? Math.max(0, Date.now() - oldestQueued.runAt.getTime()) : null,
      runningCount: byStatus.RUNNING,
      lastTickAgoMs,
    };
  } catch {
    // Database unreachable (or client not ready) — degrade honestly to nulls
    // instead of throwing the liveness probe under the bus.
    return {
      byStatus: { ...EMPTY_COUNTS },
      oldestQueuedAgeMs: null,
      runningCount: null,
      lastTickAgoMs: null,
    };
  }
}
