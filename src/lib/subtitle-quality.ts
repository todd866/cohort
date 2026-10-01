const MUSIC_MARKERS = ['🎶', '♪', '♫', 'music outro', 'music intro', '[music]'];
const MIN_WORDS_PER_SEC = 0.5;

export function isLowQualityTranscript(
  transcript: string | null | undefined,
  durationSecs: number | null | undefined,
): boolean {
  if (!transcript || !transcript.trim()) return true;
  const text = transcript.trim().toLowerCase();
  if (MUSIC_MARKERS.some((m) => text.includes(m.toLowerCase()))) return true;
  if (durationSecs && durationSecs > 5) {
    const wordCount = text.split(/\s+/).length;
    const wordsPerSec = wordCount / durationSecs;
    if (wordsPerSec < MIN_WORDS_PER_SEC) return true;
  }
  return false;
}
