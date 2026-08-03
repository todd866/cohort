import { logger } from '@/lib/logger';
import { createHash } from 'node:crypto';

const ALERT_TIMEOUT_MS = 5_000;
const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';

export interface OpsAlert {
  source: string;
  severity: 'warning' | 'critical';
  code: string;
  summary: string;
  details?: Record<string, string | number | boolean | null>;
}

export type OpsAlertResult =
  | { delivered: true }
  | { delivered: false; reason: 'not-configured' | 'invalid-url' | 'delivery-failed' };

function parseAdminRecipients(): string[] {
  return [...new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )].slice(0, 50);
}

function alertIdentity(alert: OpsAlert) {
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const key = createHash('sha256')
    .update(['md3', environment, alert.source, alert.code, day].join('|'))
    .digest('hex');
  return {
    environment,
    day,
    key: `md3-alert-${key}`,
  };
}

function alertEnvelope(alert: OpsAlert, identity: ReturnType<typeof alertIdentity>) {
  return {
    service: 'md3',
    environment: identity.environment,
    // Day-bucketed so a provider retry with the same idempotency key has an
    // identical control-plane payload. Resend retains keys for 24 hours.
    timestamp: `${identity.day}T00:00:00.000Z`,
    alertKey: identity.key,
    ...alert,
  };
}

/**
 * Deliver a privacy-safe operational alert. A configured incident webhook is
 * preferred; otherwise the existing Resend/admin-email channel is used.
 * Callers must pass aggregate/control-plane metadata only—never user content.
 */
export async function notifyOpsAlert(alert: OpsAlert): Promise<OpsAlertResult> {
  const rawUrl = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
  let url: URL | null = null;
  if (rawUrl) {
    try {
      url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.username || url.password) {
        return { delivered: false, reason: 'invalid-url' };
      }
    } catch {
      return { delivered: false, reason: 'invalid-url' };
    }
  }

  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const emailFrom = process.env.EMAIL_FROM?.trim();
  const adminRecipients = parseAdminRecipients();
  if (!url && (!resendApiKey || !emailFrom || adminRecipients.length === 0)) {
    return { delivered: false, reason: 'not-configured' };
  }

  const identity = alertIdentity(alert);
  const envelope = alertEnvelope(alert, identity);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    if (url) {
      const token = process.env.OPS_ALERT_WEBHOOK_TOKEN?.trim();
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-md3-alert-key': identity.key,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(envelope),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`webhook returned ${response.status}`);
    } else {
      const response = await fetch(RESEND_EMAIL_API_URL, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          authorization: `Bearer ${resendApiKey}`,
          'content-type': 'application/json',
          'idempotency-key': identity.key,
        },
        body: JSON.stringify({
          from: emailFrom,
          to: adminRecipients,
          subject: `[MD3 ${alert.severity}] ${alert.code}`,
          text: [
            alert.summary,
            '',
            JSON.stringify(envelope, null, 2),
          ].join('\n'),
        }),
        redirect: 'error',
      });
      // A 409 means the provider already accepted this daily incident key (or
      // an identical request is concurrent), so the alert is not undelivered.
      if (!response.ok && response.status !== 409) {
        throw new Error(`email provider returned ${response.status}`);
      }
    }
    return { delivered: true };
  } catch (error) {
    logger.error('Operational alert delivery failed', {
      source: alert.source,
      code: alert.code,
      error: error instanceof Error ? error.message : String(error),
    });
    return { delivered: false, reason: 'delivery-failed' };
  } finally {
    clearTimeout(timer);
  }
}
