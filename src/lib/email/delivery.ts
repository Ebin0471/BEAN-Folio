import { db } from "@/lib/db";

/**
 * BEAN Folio — email delivery adapter (M31).
 *
 * The platform has NO transactional email provider configured. This module is
 * the single configurable seam for verification-email delivery:
 *
 * - `EMAIL_DELIVERY_ADAPTER=none` (default): nothing is sent. The adapter
 *   reports `delivered: false, reason: "no-provider"` — the platform NEVER
 *   pretends an email was sent.
 * - `EMAIL_DELIVERY_ADAPTER=console`: a development/test-only adapter that
 *   writes the message to the server log via console.info. It is refused in
 *   production by startup validation (see src/lib/startup-validation.ts).
 *
 * A real provider (SMTP/Resend/SES/Postmark) is an explicit owner decision
 * requiring credentials — none are configured in this milestone. The adapter
 * interface below is the only point a provider implementation plugs into.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  bodyText: string;
  /** Best-effort delivery metadata (never secrets or tokens' plaintext). */
  meta?: Record<string, string>;
};

export type EmailDeliveryResult =
  | { delivered: true; adapter: string }
  | { delivered: false; adapter: string; reason: string };

export interface EmailDeliveryAdapter {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/** Default: honest no-op. Reports non-delivery; never fabricates success. */
class NoneAdapter implements EmailDeliveryAdapter {
  readonly name = "none";
  async send(_message: EmailMessage): Promise<EmailDeliveryResult> {
    return { delivered: false, adapter: this.name, reason: "no-provider" };
  }
}

/** Development/test adapter: logs to the server console only. */
class ConsoleAdapter implements EmailDeliveryAdapter {
  readonly name = "console";
  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    // Verification tokens are never logged here — callers pass meta WITHOUT
    // secrets; the message body (which may contain a token) is only printed
    // when this explicitly dev-only adapter is active.
    console.info(
      `[email:console] to=${message.to} subject="${message.subject}" body="${message.bodyText}"`,
      message.meta ?? {}
    );
    return { delivered: true, adapter: this.name };
  }
}

export function resolveEmailAdapter(): EmailDeliveryAdapter {
  const configured = (process.env.EMAIL_DELIVERY_ADAPTER ?? "none").toLowerCase();
  if (configured === "console" && process.env.NODE_ENV !== "production") {
    return new ConsoleAdapter();
  }
  return new NoneAdapter();
}

/**
 * Record a delivery attempt outcome on the user's audit trail (best-effort —
 * audit failures never break the verification flow).
 */
export async function auditEmailDelivery(
  userId: string,
  action: string,
  meta: Record<string, unknown>
): Promise<void> {
  await db.auditEvent
    .create({
      data: {
        actorUserId: userId,
        action,
        targetType: "USER",
        targetId: userId,
        meta: JSON.stringify(meta),
      },
    })
    .catch(() => undefined);
}
