export type AnswerBoundaryKind =
  | 'blank'
  | 'unordered-list'
  | 'ordered-list'
  | 'blockquote'
  | 'heading'
  | 'component'
  | 'attribution';

function getAnswerBoundaryKind(line: string): AnswerBoundaryKind | null {
  if (line.length === 0) return 'blank';
  if (/^[-*+]\s+/.test(line)) return 'unordered-list';
  if (/^\d+\.\s+/.test(line)) return 'ordered-list';
  if (/^>\s+/.test(line)) return 'blockquote';
  if (/^#{1,6}\s+/.test(line)) return 'heading';
  if (/^<[/A-Z]/i.test(line)) return 'component';
  if (/^(?:See also|Source|Sources|Reference|References):/i.test(line)) return 'attribution';
  return null;
}

export interface TrimmedAnswer {
  answer: string;
  boundaryKind: AnswerBoundaryKind | null;
}

export function analyzeAnswerAtMarkdownBoundary(rawAnswer: string): TrimmedAnswer {
  const lines = rawAnswer.trim().split('\n');
  const kept: string[] = [];
  let boundaryKind: AnswerBoundaryKind | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (index > 0) {
      boundaryKind = getAnswerBoundaryKind(trimmed);
      if (boundaryKind) break;
    }
    kept.push(line);
  }

  return {
    answer: kept.join('\n').trim(),
    boundaryKind,
  };
}

export function trimAnswerAtMarkdownBoundary(rawAnswer: string): string {
  return analyzeAnswerAtMarkdownBoundary(rawAnswer).answer;
}
