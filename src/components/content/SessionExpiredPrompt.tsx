'use client';
import { InlineMagicLink } from '@/components/ui/InlineMagicLink';

/**
 * Shown inline when a flag (or other write) returns 401. Re-signing in via the
 * magic link reloads the app, which triggers ConnectionBanner's mount flush and
 * replays the queued flags automatically.
 */
export function SessionExpiredPrompt() {
  return (
    <div className="mt-2 rounded-lg border border-[var(--md-outline)] p-2 text-xs">
      <p className="mb-1 text-[var(--md-on-surface-variant)]">
        Session expired — your flag is saved and will send after you sign in.
      </p>
      <InlineMagicLink compact />
    </div>
  );
}
