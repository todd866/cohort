import { createHash } from 'node:crypto';

export interface ImageAlternativeTeachingSource {
  type: 'card' | 'question';
  front?: string;
  back?: string;
  backs?: unknown;
  stem?: string;
  options?: unknown;
  context?: string | null;
}

/** A cheap comparison of already-loaded teaching text, never a history read. */
export function imageAlternativeTeachingFingerprint(source: ImageAlternativeTeachingSource): string | null {
  const front = source.type === 'card' ? source.front : source.stem;
  const answer = source.type === 'card'
    ? Array.isArray(source.backs) && source.backs.length > 0 && source.backs.every(b => typeof b === 'string')
      ? source.backs.join('; ') : source.back
    : Array.isArray(source.options) ? source.options.filter(o => o && typeof o === 'object' && o.isCorrect === true)
      .map(o => typeof o.text === 'string' ? o.text : '').filter(Boolean).join('; ') : null;
  if (typeof front !== 'string' || typeof answer !== 'string') return null;
  return createHash('sha256').update(JSON.stringify({ front, answer, context: source.context ?? '' })).digest('hex');
}
