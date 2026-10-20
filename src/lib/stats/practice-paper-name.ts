/**
 * One display name for a published practice paper: "CAH · Paper A".
 * The shape is the paper id (`cah-2026-paper-a`, `pwh-2026-midterm-1`,
 * `pwh-2026-exam-1`) and the same words in a stored title. A title this
 * does not recognise is returned unchanged, so a fixture named "A" stays "A".
 * display-name.test.ts checks every registry paper against this function.
 */
const ROTATIONS: Array<[RegExp, string]> = [
  [/^(?:cah|child and adolescent health)\b/i, 'CAH'],
  [/^(?:critical-care|critical care)\b/i, 'CC'],
  [/^(?:paam|psychiatry and addiction medicine)\b/i, 'PAAM'],
  [/^(?:pwh|perinatal and women.s health)\b/i, 'PWH'],
];

function piece(text: string): string | null {
  const paper = text.match(/paper[- ]([a-z])\b/i);
  if (paper) return `Paper ${paper[1].toUpperCase()}`;
  const midterm = text.match(/midterm[- ](\d+)\b/i);
  if (midterm) return `Midterm ${midterm[1]}`;
  const exam = text.match(/exam[- ](\d+)\b/i);
  if (exam) return `Exam ${exam[1]}`;
  return null;
}

export function practicePaperDisplayName(input: { id?: string | null; title?: string | null; rotation?: string | null }): string {
  const ref = (input.id || input.title || '').trim();
  if (!ref) return 'Practice paper';
  for (const [pattern, short] of ROTATIONS) {
    if (!pattern.test(ref)) continue;
    const label = piece(ref);
    if (label) return `${short} · ${label}`;
  }
  return ref;
}
