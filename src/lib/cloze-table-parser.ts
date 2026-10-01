import { parseMarkdownTable, hasMarkdownTable, type ParsedTable } from './inline-markdown';

export interface ClozeSegment {
  type: 'text' | 'table';
  text?: string;
  table?: ParsedTable;
  clozeStartIndex: number;
}

export interface ClozeTableResult {
  preText: string;
  postText: string;
  table: ParsedTable;
  segments: ClozeSegment[];
}

/** Count [___] blanks in a string */
function countBlanks(text: string): number {
  return (text.match(/\[___\]/g) ?? []).length;
}

/**
 * Parse front text that contains a markdown table with cloze blanks.
 * Returns structured segments with cloze indices for rendering.
 * Returns null if no table is present.
 */
export function parseClozeWithTable(front: string): ClozeTableResult | null {
  if (!hasMarkdownTable(front)) return null;

  const parsed = parseMarkdownTable(front);
  if (!parsed) return null;

  const segments: ClozeSegment[] = [];
  let clozeIndex = 0;

  // Pre-text segment
  if (parsed.preText) {
    segments.push({
      type: 'text',
      text: parsed.preText,
      clozeStartIndex: clozeIndex,
    });
    clozeIndex += countBlanks(parsed.preText);
  }

  // Table segment
  segments.push({
    type: 'table',
    table: parsed,
    clozeStartIndex: clozeIndex,
  });
  // Count blanks in all table cells
  for (const row of parsed.rows) {
    for (const cell of row) {
      clozeIndex += countBlanks(cell);
    }
  }

  // Post-text segment
  if (parsed.postText) {
    segments.push({
      type: 'text',
      text: parsed.postText,
      clozeStartIndex: clozeIndex,
    });
  }

  return {
    preText: parsed.preText,
    postText: parsed.postText,
    table: parsed,
    segments,
  };
}
