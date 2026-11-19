/**
 * What is on the review screen, in words, for a live voice to talk about the
 * item. It is sent as unspoken context, so it holds only what the learner can
 * see: before the answer shows, the question, its options, a case's context and
 * that a picture is there; once it shows, the answer, why each
 * option is right or wrong, the explanation and the picture's teaching
 * caption. Nothing reveal-gated goes out early, because unspoken context can
 * still leak into what the voice says.
 */
import type { UnifiedItem } from '@/lib/study/unified-session-types';

/** Markdown and HTML out, whitespace collapsed; the voice needs the words, not the markup. */
export function plainText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type BackgroundItem = Pick<UnifiedItem, 'type' | 'front' | 'back' | 'backs' | 'context' | 'contextText' | 'stem' | 'options' | 'explanation' | 'imageCaption' | 'imageUrl' | 'clipCaption' | 'diagnosisSummary'>;

export function itemBackground(item: BackgroundItem, revealed: boolean, correctOption?: string | null): string {
  const lines: string[] = [];
  const add = (label: string, text: string | null | undefined) => {
    const clean = plainText(text);
    if (clean) lines.push(`${label}: ${clean}`);
  };
  const picture = item.imageUrl ? (revealed ? '' : 'a picture is on screen; it is described once the answer shows') : '';
  if (item.type === 'card') {
    add('CARD', item.front);
    add('PICTURE', picture);
    add('CLIP', item.clipCaption);
    if (revealed) {
      // A card's context paragraph shows with its answer and often restates it.
      add('CONTEXT', item.context);
      add('ANSWER', item.backs?.length ? item.backs.join('; ') : item.back);
      add('PICTURE SHOWS', item.imageCaption);
    }
    return lines.join('\n');
  }
  add('CASE', item.contextText);
  add('QUESTION', item.stem);
  const keyed = correctOption ?? item.options?.find((option) => option.isCorrect)?.label ?? null;
  for (const option of item.options ?? []) {
    const verdict = revealed && keyed ? (option.label === keyed ? ' (correct)' : ' (wrong)') : '';
    const why = revealed ? plainText(option.explanation) : '';
    lines.push(`${option.label}. ${plainText(option.text)}${verdict}${why ? ` — ${why}` : ''}`);
  }
  add('PICTURE', picture);
  add('CLIP', item.clipCaption);
  if (revealed) {
    add('EXPLANATION', item.explanation);
    add('PICTURE SHOWS', item.imageCaption);
    add('SUMMARY', item.diagnosisSummary);
  }
  return lines.join('\n');
}
