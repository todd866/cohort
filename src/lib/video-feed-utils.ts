/**
 * Video feed scoring — ranks videos by educational quality.
 * Educational content leads, lighter/meme content is mixed in as filler.
 * Used by both the server page and the feed API.
 */

/** Tags that indicate meme/humor/non-educational content */
const MEME_TAGS = new Set([
  'meme', 'memes', 'comedy', 'jokes', 'funny', 'humor', 'fyp',
  'foryou', 'foryoupage', 'viral', 'trending', 'pov', 'storytime',
  'skit', 'relatable', 'lol',
]);

/** Title patterns that indicate non-educational content */
const MEME_TITLE_PATTERNS = /😂|🤣|lol|tag your|tag a|who else|be like|no way|bruh/i;

/** Known educational creators (lowercased for matching) */
const EDUCATIONAL_CREATORS = new Set([
  'haney mallemat, md',
  'criticalcarenow',
  'nick pulm crit',
  'em board bombs podcast',
  'atomic anesthesia',
  'ecg lectures with reid',
  'nicole kupchik',
  'icuadvantage',
  'nysora_inc',
  'theicudoctor1',
  'scope_education_',
]);

/**
 * Score a video for educational quality. Higher = more educational.
 * Range: roughly -5 to +10.
 */
export function scoreVideo(v: {
  title: string;
  tags: string[];
  durationSecs: number;
  creatorName: string;
  rotation?: string | null;
  transcript?: string | null;
  seriousness?: number | null;
}): number {
  // When embedding-based seriousness is available, use it directly.
  // Maps 0.0–1.0 seriousness to roughly the same -5 to +10 range as the heuristic.
  if (v.seriousness != null) {
    return v.seriousness * 15 - 5;
  }

  // Heuristic fallback for videos without embeddings
  let score = 0;

  // Has rotation = matched medical vocabulary
  if (v.rotation) score += 2;

  // Known educational creator: strong signal
  if (EDUCATIONAL_CREATORS.has(v.creatorName.toLowerCase())) {
    score += 5;
  }

  // Meme tags: penalize
  const memeTags = v.tags.filter((t) => MEME_TAGS.has(t.toLowerCase()));
  score -= memeTags.length * 1.5;

  // Meme title: penalize
  if (MEME_TITLE_PATTERNS.test(v.title)) {
    score -= 3;
  }

  // Good duration for educational reels (15s - 3min)
  if (v.durationSecs >= 15 && v.durationSecs <= 180) {
    score += 2;
  } else if (v.durationSecs < 10) {
    score -= 2; // too short to be educational
  }

  // Has transcript: slight boost
  if (v.transcript) {
    score += 1;
  }

  return score;
}
