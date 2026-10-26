/**
 * Every MCQ stem renders the same way: the scenario, then the question line as
 * its own paragraph, all at body weight (owner, 22 Oct 2026: no bold on stems).
 * Authored stems put the question in its own
 * paragraph; older ones run it on, so the final question sentence is split off
 * at render time rather than relying on the source to be tidy.
 */
const NON_TERMINAL = /\b(?:e\.g|i\.e|etc|approx|vs|cf|Dr|Mr|Mrs|Ms|Prof|St|No|Fig)\.$/;

export function splitStemLead(text: string): { body: string; lead: string | null } {
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\s*\n/);
  const last = paragraphs.at(-1)?.trim() ?? '';
  if (!/[?:]$/.test(last)) return { body: trimmed, lead: null };
  if (paragraphs.length > 1) return { body: paragraphs.slice(0, -1).join('\n\n').trim(), lead: last };

  // One paragraph: the lead is the sentence after the last safe boundary.
  let cut = -1;
  for (const match of last.matchAll(/[.!?](?=\s+[A-Z(])/g)) {
    const end = (match.index ?? 0) + 1;
    if (match[0] === '.' && NON_TERMINAL.test(last.slice(0, end))) continue;
    cut = end;
  }
  if (cut < 0) return { body: '', lead: last };
  return { body: last.slice(0, cut).trim(), lead: last.slice(cut).trim() };
}
