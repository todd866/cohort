/** The queue's next card or question, for prefetching its voice brief. Null for anything else. */
export function upcomingVoiceItem(items: ReadonlyArray<{ type: string; id: string }>, currentIndex: number): { type: 'card' | 'question'; id: string } | null {
  const next = items[Math.max(0, currentIndex) + 1];
  if (!next || (next.type !== 'card' && next.type !== 'question')) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/.test(next.id) ? { type: next.type, id: next.id } : null;
}
