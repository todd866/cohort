'use client';

/** Public builds never create a voice controller or request microphone access. */
export function useReviewVoiceSupport(
  _ownerKey: string | null | undefined,
  _enabled = true,
): null {
  void _ownerKey;
  void _enabled;
  return null;
}
