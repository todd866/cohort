/**
 * The one topic a card is ABOUT, chosen from the many tags it carries.
 *
 * Why this exists. `Card.topics` is a match list, not an identity. The heading
 * extractor deliberately emits the heading phrase AND every significant word in
 * it, because single words are what curriculum matching and scaffold lookups
 * key on. That is right for matching and useless for naming: the commonest CAH
 * tags include "recognition", "findings", "More", "need" and "driven", which are
 * fragments of headings rather than subjects.
 *
 * Cluster labels were built by taking the commonest tags of a cluster's member
 * cards, so they inherited the fragments. The result was 107 CAH clusters
 * carrying 64 distinct labels, nine of them "Surgery", with 54% of cards under a
 * name shared by more than one square. A square you cannot name is a square you
 * cannot choose.
 *
 * This picks the identity out of the match list, leaving `topics` untouched so
 * nothing that matches on it changes behaviour. It is a pure function over data
 * already stored: no schema change and no re-seed, which also means a wrong rule
 * here is cheap to correct.
 */

/**
 * Heading furniture and rotation noise. These are real entries in `topics` and
 * several are among the most frequent, so they must be excluded by name rather
 * than by frequency — frequency is exactly what promoted them.
 */
const NOT_A_SUBJECT = new Set([
  'cah', 'pwh', 'paam', 'more', 'need', 'needs', 'driven', 'findings', 'finding',
  'image', 'images', 'recognition', 'imaging', 'medical', 'general', 'clinical',
  'additional', 'pearls', 'overview', 'introduction', 'summary', 'notes',
  'paediatric', 'paediatrics', 'pediatric', 'pediatrics', 'child', 'children',
  'week', 'cards', 'card', 'questions', 'question', 'review', 'other', 'misc',
]);

/**
 * Strip the labeller's unbalanced-parenthesis artefact. "Ophthalmology (CAH" is
 * a truncation, not a qualifier, and it reaches us in the stored tags.
 */
function stripTruncatedParen(topic: string): string {
  const opens = (topic.match(/\(/g) ?? []).length;
  const closes = (topic.match(/\)/g) ?? []).length;
  const trimmed = opens > closes ? topic.slice(0, topic.indexOf('(')) : topic;
  return trimmed.replace(/\s+/g, ' ').trim();
}

function isSubject(topic: string): boolean {
  if (topic.length < 4) return false;
  const words = topic.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // A phrase made entirely of furniture is furniture: "More findings",
  // "Additional Clinical Pearls", "Image recognition".
  return words.some((word) => !NOT_A_SUBJECT.has(word));
}

/**
 * Pick the card's subject: the NEAREST heading it sits under.
 *
 * `topics` is built by walking ancestor headings from the card outward, so the
 * array is ordered closest-first — the card's own heading, then its words, then
 * the section above it, then the chapter. Taking the first surviving entry
 * therefore takes the most specific heading an author actually wrote.
 *
 * An earlier version of this took the LONGEST tag on the theory that longer
 * means more specific. That is backwards where it matters, because a chapter
 * name is often longer than the subject beneath it: a card headed "Diabetes"
 * inside a chapter headed "Endocrinology" scored the chapter. Worse, chapter
 * headings that list several specialties ("Cardiology, Developmental,
 * Dermatology & Endocrinology") are split and stamped on EVERY card beneath
 * them, so length-wins filed a congenital heart lesion and an ADHD card under
 * Endocrinology. Nearest-first fixes both: those cards score "Congenital Heart
 * Disease" and "Attention Deficit Hyperactivity Disorder (ADHD)" instead.
 *
 * Order is load-bearing and is safe to rely on: it comes from document
 * position, not from set iteration, and `[...new Set(...)]` preserves it.
 */
export function primaryTopicOf(topics: readonly string[]): string | null {
  for (const topic of topics) {
    const cleaned = stripTruncatedParen(topic);
    if (cleaned.length > 0 && isSubject(cleaned)) return cleaned;
  }
  return null;
}

/**
 * Group cards into heatmap squares by subject.
 *
 * `minCards` is the tail cut. Measured on CAH at 4,202 cards under the
 * nearest-heading rule: a floor of 3 yields 286 subjects covering 78% of the
 * corpus, and 5 yields 160 covering 68%. Everything below the floor is a topic
 * too thin to be worth a square of its own, and is returned separately rather
 * than silently dropped — the caller decides whether it merges upward.
 *
 * Coverage is lower than the discarded longest-tag rule scored, and that is the
 * rule working rather than failing: the missing cards were ones it had filed
 * under a chapter they did not belong to.
 */
export function groupByPrimaryTopic(
  cards: ReadonlyArray<{ id: string; topics: readonly string[] }>,
  minCards: number,
): { squares: Map<string, string[]>; tail: Map<string, string[]> } {
  const all = new Map<string, string[]>();
  for (const card of cards) {
    const topic = primaryTopicOf(card.topics);
    if (!topic) continue;
    const bucket = all.get(topic) ?? [];
    bucket.push(card.id);
    all.set(topic, bucket);
  }

  const squares = new Map<string, string[]>();
  const tail = new Map<string, string[]>();
  for (const [topic, ids] of all) {
    (ids.length >= minCards ? squares : tail).set(topic, ids);
  }
  return { squares, tail };
}
