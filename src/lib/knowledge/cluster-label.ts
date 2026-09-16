/**
 * Cluster display labels.
 *
 * `Cluster.name` is auto-labelled from the commonest topics of its member
 * cards, and the raw output is sludge: "ENT / CAH / ENT (CAH",
 * "Surgery (CAH / CAH / Surgery", "Empirical / Empirical findings & Q&A
 * defence / defence". Three failure modes recur — an unbalanced parenthesis
 * where the labeller truncated mid-token, the rotation acronym repeated as if
 * it were a topic, and the same topic appearing twice at different lengths.
 *
 * This is presentation only. Nothing downstream keys off the tidied string.
 */

const SEPARATOR = ' / ';
const JOINER = ' · ';
const MAX_FRAGMENTS = 2;
const FALLBACK = 'Untitled topic';

/**
 * Strip an unbalanced trailing "(" group. "Dermatology (CAH" → "Dermatology";
 * a balanced "(paeds)" is left alone because it is probably meant.
 */
function stripUnbalancedParen(fragment: string): string {
  const opens = (fragment.match(/\(/g) ?? []).length;
  const closes = (fragment.match(/\)/g) ?? []).length;
  if (opens <= closes) return fragment;
  return fragment.slice(0, fragment.indexOf('('));
}

function normalise(fragment: string): string {
  return stripUnbalancedParen(fragment).replace(/\s+/g, ' ').trim();
}

/** Rotation slugs are kebab-case; compare on their bare letters. */
function isRotationNoise(fragment: string, rotation: string): boolean {
  const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const f = bare(fragment);
  return f.length > 0 && f === bare(rotation);
}

/**
 * Tidy one cluster name for display.
 *
 * Keeps at most the first two surviving fragments, in their original order,
 * having dropped rotation noise, case-insensitive duplicates, and any fragment
 * wholly contained in a longer one it keeps (so "Empirical" loses to
 * "Empirical findings & Q&A defence"). Containment is checked on whole
 * fragments, not words — "Asthma Plan" and "Acute Asthma" both survive.
 */
export function tidyClusterLabel(name: string, rotation: string): string {
  const raw = name.trim();
  if (raw.length === 0) return FALLBACK;

  const fragments = raw
    .split(SEPARATOR)
    .map(normalise)
    .filter((f) => f.length > 0 && !isRotationNoise(f, rotation));

  const kept: string[] = [];
  for (const fragment of fragments) {
    const lower = fragment.toLowerCase();
    // Skip anything already represented by a kept fragment…
    if (kept.some((k) => k.toLowerCase().includes(lower))) continue;
    // …and replace a kept fragment this one subsumes.
    const subsumedIndex = kept.findIndex((k) => lower.includes(k.toLowerCase()));
    if (subsumedIndex >= 0) {
      kept[subsumedIndex] = fragment;
      continue;
    }
    kept.push(fragment);
  }

  if (kept.length === 0) return normalise(raw.split(SEPARATOR)[0]) || FALLBACK;
  return kept.slice(0, MAX_FRAGMENTS).join(JOINER);
}
