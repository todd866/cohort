import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export interface IdentitySignals {
  version: 1;
  cookieHash?: string;
  networkHash?: string;
  day: string;
}

/** Correlation hints only. None of these values is identity/merge authority. */
export function buildIdentitySignals(input: {
  secret?: string;
  anonymousCookie: string | null;
  forwardedIp?: string | null;
  trustedVercel: boolean;
  now?: Date;
}): IdentitySignals | undefined {
  if (!input.secret || input.secret.length < 16) return undefined;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return undefined;
  const day = now.toISOString().slice(0, 10);
  const hash = (purpose: string, value: string) => createHmac('sha256', input.secret!)
    .update(`md3-identity-v1:${purpose}:${value}`).digest('hex');
  const cookie = input.anonymousCookie;
  const cookieHash = cookie && /^[a-zA-Z0-9_-]{8,128}$/.test(cookie)
    ? hash('cookie', cookie) : undefined;
  // Vercel overwrites this header. Never accept arbitrary proxy chains or
  // request-supplied forwarding on a custom/self-hosted deployment.
  const ip = input.trustedVercel ? input.forwardedIp?.trim() : undefined;
  const networkHash = ip && isIP(ip) ? hash(`network:${day}`, ip.toLowerCase()) : undefined;
  if (!cookieHash && !networkHash) return undefined;
  return { version: 1, day, ...(cookieHash ? { cookieHash } : {}), ...(networkHash ? { networkHash } : {}) };
}
