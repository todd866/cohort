/**
 * Server-side admin allowlist check.
 *
 * Authorization must never depend on a NEXT_PUBLIC_* value: those variables
 * are bundled for clients and can drift independently from the server's
 * authoritative allowlist. Callers use this helper only from server routes,
 * server components, and the auth session callback.
 */

function parseEmailList(raw: string): string[] {
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function getAdminEmailSet(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? '';
  return new Set(parseEmailList(raw));
}

const ADMIN_EMAIL_SET = getAdminEmailSet();

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAIL_SET.has(email.toLowerCase());
}
