import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSessionUser } from "@/lib/auth";
import { handler, ok, err, ERR, parseBody } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { auditEvent } from "@/lib/riishe/audit";
import {
  AUTOMATION_PREFERENCE_KEYS,
  MAX_DAILY_ACTION_CAP,
  MIN_DAILY_ACTION_CAP,
} from "@/lib/riishe/automation-policy";
import { TOOL_CATEGORIES } from "@/lib/riishe/tools";

export const dynamic = "force-dynamic";

/**
 * RIISHE memory/preferences — the inspectable, editable, deletable store of
 * RIISHE-specific facts the owner approved (tone, defaults, quiet hours, and
 * the B2 automation policy: Level-1 auto-run, Level-2 confirmation, category
 * pre-authorization, daily action cap). Nothing is written silently (every
 * write is an explicit API call the owner or an approved automation made) and
 * no conversation content is persisted.
 */

const ALLOWED_KEYS = [
  "outreach.tone",
  "outreach.defaultNote",
  "discovery.defaultLimit",
  "quietHours",
  "followup.defaultDays",
  ...AUTOMATION_PREFERENCE_KEYS,
] as const;

/**
 * B2 automation preference values are STRICTLY validated — a malformed or
 * out-of-range value can never loosen a permission. Loose-record validation
 * (the historical contract) still applies to the pre-existing keys.
 */
const AUTOMATION_VALUE_SCHEMAS: Partial<Record<(typeof ALLOWED_KEYS)[number], z.ZodType>> = {
  "automation.autoRunLevel1": z.object({ enabled: z.boolean() }).strict(),
  "automation.confirmEachLevel2": z.object({ enabled: z.boolean() }).strict(),
  "automation.allowedLevel2Categories": z
    .object({ categories: z.array(z.enum(TOOL_CATEGORIES)).max(TOOL_CATEGORIES.length) })
    .strict(),
  "automation.dailyActionCap": z
    .object({ cap: z.number().int().min(MIN_DAILY_ACTION_CAP).max(MAX_DAILY_ACTION_CAP) })
    .strict(),
};

const patchSchema = z.object({
  key: z.enum(ALLOWED_KEYS),
  value: z.record(z.string(), z.unknown()),
});

function toDTO(row: { id: string; key: string; valueJson: string; updatedAt: Date }) {
  let value: unknown = {};
  try {
    value = JSON.parse(row.valueJson);
  } catch {
    value = {};
  }
  return { id: row.id, key: row.key, value, updatedAt: row.updatedAt.toISOString() };
}

/** GET — every stored RIISHE preference, fully inspectable. */
export const GET = handler(async (): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const rows = await db.riisheUserPreference.findMany({
    where: { userId: user.id },
    orderBy: { key: "asc" },
  });
  return ok({ items: rows.map(toDTO), allowedKeys: ALLOWED_KEYS });
});

/** PATCH — upsert one preference (owner-approved automation knowledge). */
export const PATCH = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const r = await parseBody(req, patchSchema);
  if (r.response) return r.response;

  const automationSchema = AUTOMATION_VALUE_SCHEMAS[r.data.key];
  if (automationSchema) {
    const parsed = automationSchema.safeParse(r.data.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return err(`Invalid value for ${r.data.key}: ${issue?.path.join(".") || "value"} ${issue?.message ?? "invalid"}`, 400);
    }
  }

  const row = await db.riisheUserPreference.upsert({
    where: { userId_key: { userId: user.id, key: r.data.key } },
    create: { userId: user.id, key: r.data.key, valueJson: JSON.stringify(r.data.value) },
    update: { valueJson: JSON.stringify(r.data.value) },
  });
  await auditEvent(user.id, "riishe.preference.updated", "RiisheUserPreference", row.id, { key: r.data.key });
  return ok({ preference: toDTO(row) });
});

/** DELETE — remove one preference by key (the data is gone, honestly). */
export const DELETE = handler(async (req: NextRequest): Promise<NextResponse> => {
  const user = await getSessionUser();
  if (!user) return ERR.unauthorized();
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) return err("Pass ?key=<preference key>", 400);
  const res = await db.riisheUserPreference.deleteMany({ where: { userId: user.id, key } });
  if (res.count === 0) return ERR.notFound();
  await auditEvent(user.id, "riishe.preference.deleted", "RiisheUserPreference", user.id, { key });
  return ok({ removed: res.count });
});
