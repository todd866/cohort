'use client';

import { ChipToggle } from '@/components/shared/Chip';
import { usePracticeFollowUpPreference } from './usePracticeFollowUpPreference';

/**
 * "No exam follow-ups": the same labelled switch chip as No videos / No images.
 * On, the feed stops adding questions built from missed practice-exam items;
 * the plans are kept and resume when it is turned off.
 */
export function PracticeFollowUpToggle({ enabled }: { enabled: boolean }) {
  const { off, saving, setOff } = usePracticeFollowUpPreference(enabled);
  if (off === null) return null;
  return (
    <ChipToggle
      on={off}
      semantics="switch"
      aria-label="No exam follow-ups"
      disabled={saving}
      onClick={() => { void setOff(!off); }}
      className="shrink-0"
    >
      <span>No exam follow-ups</span>
    </ChipToggle>
  );
}
