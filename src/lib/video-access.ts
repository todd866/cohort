/** Controls who can access /videos. Separate from admin — lets you grant video access without full admin. */

function getVideoAccessEmails(): Set<string> {
  const raw = process.env.VIDEO_ACCESS_EMAILS ?? process.env.ADMIN_EMAILS ?? '';
  return new Set(
    raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  );
}

const VIDEO_ACCESS_SET = getVideoAccessEmails();

export function hasVideoAccess(email: string | null | undefined): boolean {
  if (!email) return false;
  return VIDEO_ACCESS_SET.has(email.toLowerCase());
}
