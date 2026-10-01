/**
 * Extract a clean answer string from an Instagram caption.
 * Strips hashtags, "Answer:" prefix, and trailing whitespace.
 */
export function extractAnswerFromCaption(caption: string | null | undefined): string | null {
  if (!caption) return null;
  let text = caption.replace(/#\S+/g, '').trim();
  const answerMatch = text.match(/answer\s*[:.]?\s*(.+)/i);
  if (answerMatch) text = answerMatch[1].trim();
  return text || null;
}
