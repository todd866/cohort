import type { VideoPedagogy } from './video-pedagogy';

export function buildVideoEmbeddingContent(input: {
  title: string;
  caption: string | null;
  transcript: string | null;
  pedagogy: VideoPedagogy | null;
}): string {
  const parts = [input.title];
  const transcriptLimit = input.pedagogy ? 4000 : 6000;

  if (input.pedagogy) {
    parts.push(input.pedagogy.embeddingText);
    parts.push(`Pedagogical summary: ${input.pedagogy.pedagogicalSummary}`);
    parts.push(`Placement rationale: ${input.pedagogy.placementRationale}`);
    parts.push(`Teaching format: ${input.pedagogy.teachingFormat}`);
    parts.push(`Learner level: ${input.pedagogy.learnerLevel}`);
    parts.push(`Feed role: ${input.pedagogy.feedRole}`);

    if (input.pedagogy.keyConcepts.length > 0) {
      parts.push(`Key concepts: ${input.pedagogy.keyConcepts.join(', ')}`);
    }

    if (input.pedagogy.keyTakeaways.length > 0) {
      parts.push(`Key takeaways: ${input.pedagogy.keyTakeaways.join(', ')}`);
    }
  }

  if (input.caption) {
    parts.push(input.caption);
  }

  if (input.transcript) {
    parts.push(input.transcript.slice(0, transcriptLimit));
  }

  return parts.join('\n\n');
}
