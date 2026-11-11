/**
 * BEAN Intelligence gateway — structured observability.
 *
 * Every gateway decision (request, fallback, circuit transition, refusal)
 * emits ONE single-line JSON log record. Rules:
 *  - never log prompt contents, message bodies, image bytes or credentials;
 *  - never log more of the user than the opaque user id;
 *  - provider/model identifiers MAY appear (operator-facing server logs only —
 *    they are never forwarded to clients by this module).
 */

export type GatewayAgent = "RIISHE" | "LAXII" | "CODE_GIFTZ" | "SYSTEM";

export type GatewayEventName =
  | "gateway.request"
  | "gateway.retry"
  | "gateway.fallback"
  | "gateway.circuit"
  | "gateway.refused";

export interface GatewayLogFields {
  event: GatewayEventName;
  agent?: GatewayAgent;
  feature?: string;
  capability?: string;
  provider?: string;
  model?: string;
  outcome?: "success" | "failure";
  durationMs?: number;
  attempt?: number;
  userId?: string;
  error?: string;
}

/** Emit one structured JSON log line (single line = grep/ship friendly). */
export function logGatewayEvent(fields: GatewayLogFields): void {
  const record = {
    ts: new Date().toISOString(),
    system: "bean-intelligence",
    event: fields.event,
    ...(fields.agent !== undefined ? { agent: fields.agent } : {}),
    ...(fields.feature !== undefined ? { feature: fields.feature } : {}),
    ...(fields.capability !== undefined ? { capability: fields.capability } : {}),
    ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    ...(fields.outcome !== undefined ? { outcome: fields.outcome } : {}),
    ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
    ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
    ...(fields.userId !== undefined ? { userId: fields.userId } : {}),
    ...(fields.error !== undefined ? { error: fields.error.slice(0, 300) } : {}),
  };
  const line = JSON.stringify(record);
  if (fields.outcome === "failure") {
    console.error(line);
  } else {
    console.info(line);
  }
}
