/**
 * Split a wall of text into 2-3 paragraphs at natural sentence boundaries.
 * Used by MCQ explanation rendering to break long explanations into readable chunks.
 *
 * The regex avoids breaking at decimal points (e.g. "7.55" stays together).
 */
export function splitAtSentences(text: string): string[] {
  // Match sentences, but don't break at decimal points (e.g. "7.55" stays together)
  const sentences = text.match(/(?:[^.!?]|\.\d)+[.!?]+(?:\s+|$)/g);
  if (!sentences || sentences.length <= 2) {
    // Fallback: split long single/dual-sentence blocks at clause boundaries.
    if (text.length > 220) {
      const clauses = text.split(/;\s+/);
      if (clauses.length > 1) {
        const midpoint = Math.ceil(clauses.length / 2);
        return [
          `${clauses.slice(0, midpoint).join('; ').trim()}${clauses.length > midpoint ? ';' : ''}`,
          clauses.slice(midpoint).join('; ').trim(),
        ].filter(Boolean);
      }
    }
    return [text];
  }

  // Target 2-3 paragraphs of roughly equal length
  const targetParagraphs = sentences.length >= 5 ? 3 : 2;
  const targetLen = text.length / targetParagraphs;
  const paragraphs: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    current += sentence;
    if (current.length >= targetLen && paragraphs.length < targetParagraphs - 1) {
      paragraphs.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs.length > 1 ? paragraphs : [text];
}
