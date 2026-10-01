/**
 * A surgeon narrating an operation says the answer out loud.
 *
 * "...and there's the recurrent laryngeal nerve, right in the groove" is a
 * perfect teaching sentence and a fatal clip-as-prompt stem: the learner hears
 * the answer while looking at the picture they were supposed to read it from.
 * An image-as-prompt card has no equivalent failure — a photograph cannot
 * pronounce its own caption — so this check exists only on the video path.
 *
 * It is the same idea as the answer-leak rule that governs acronym
 * hover-decode: content that hands over the answer before the learner commits
 * is not a hard question, it is a recognition test wearing one's clothes.
 *
 * The default remedy is to strip the audio (`VideoClip.audioStripped`), which
 * is why that column defaults to true. Audio is kept only when a clip has been
 * through this check and come back clean.
 */

export interface ClipAnswerLeakInput {
  /** Captions covering the clip window only, not the whole video. */
  transcript: string | null | undefined;
  /** Every answer the card accepts — all blanks of a multi-cloze, or the
   *  correct option of an MCQ. */
  answers: string[];
}

export interface ClipAnswerLeakResult {
  leaked: boolean;
  /** What was found: the answer string for a spoken answer, or the literal
   *  transcript token for an acronym. Goes into the rejection message so an
   *  author can see what to do about it. */
  matches: string[];
  /** True when there was no transcript to check. The clip is not cleared — it
   *  is unexamined, which is a different thing, and the caller must not read a
   *  false `leaked` as permission to keep the audio. */
  unverifiable: boolean;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'is', 'are',
  'was', 'were', 'be', 'by', 'for', 'with', 'that', 'this', 'it', 'its',
]);

/** Fewer content words than this and an acronym is too short to be evidence —
 *  "cystic artery" would make "CA", which collides with half of medicine. */
const MIN_WORDS_FOR_ACRONYM = 3;

/**
 * Crude, deliberate plural folding. Not a stemmer: a real one over-collapses
 * ("appendices" → "appendix" would make the substring test below fire on an
 * unrelated structure) and we would rather miss an exotic plural than reject a
 * good clip. Anatomy is mostly regular.
 */
function fold(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .map(fold);
}

export function detectClipAnswerLeak(input: ClipAnswerLeakInput): ClipAnswerLeakResult {
  const raw = (input.transcript ?? '').trim();
  if (raw.length === 0) {
    return { leaked: false, matches: [], unverifiable: true };
  }

  const spoken = new Set(contentWords(raw));
  const matches: string[] = [];

  for (const answer of input.answers) {
    const words = contentWords(answer);
    if (words.length === 0) continue;

    // Every content word of the answer appears somewhere in the window. Order
    // -independent on purpose: "the nerve here is laryngeal, the recurrent one"
    // gives the game away exactly as much as saying it in order does.
    if (words.every((w) => spoken.has(w))) {
      matches.push(answer);
      continue;
    }

    if (words.length >= MIN_WORDS_FOR_ACRONYM) {
      const acronym = words.map((w) => w[0]).join('');
      const found = raw.match(new RegExp(`\\b${acronym}\\b`, 'i'));
      if (found) matches.push(found[0]);
    }
  }

  return { leaked: matches.length > 0, matches, unverifiable: false };
}
