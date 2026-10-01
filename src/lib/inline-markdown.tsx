import { Fragment, ReactNode } from 'react';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';

/**
 * Parse a range string like "7.35–7.45" or "35–45" or "<2" into bounds.
 * Returns null if not parseable.
 */
function parseRange(text: string): { low: number; high: number } | null {
  const trimmed = text.trim().replace(/\s*(mmHg|mmol\/L|g\/L|%|bpm|°C|mL\/min|U\/L|ng\/L|μmol\/L|s)\s*/gi, '');
  // Range: "7.35–7.45" or "35-45" or "22–26"
  const rangeMatch = trimmed.match(/^([<>]?\s*[\d.]+)\s*[–\-−]\s*([<>]?\s*[\d.]+)$/);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1].replace(/[<>]/g, ''));
    const high = parseFloat(rangeMatch[2].replace(/[<>]/g, ''));
    if (!isNaN(low) && !isNaN(high)) return { low, high };
  }
  // Single bound: "<2" or ">90"
  const ltMatch = trimmed.match(/^<\s*([\d.]+)$/);
  if (ltMatch) {
    const high = parseFloat(ltMatch[1]);
    if (!isNaN(high)) return { low: 0, high };
  }
  const gtMatch = trimmed.match(/^>\s*([\d.]+)$/);
  if (gtMatch) {
    const low = parseFloat(gtMatch[1]);
    if (!isNaN(low)) return { low, high: Infinity };
  }
  return null;
}

/** Extract the first numeric value from a cell string. */
function extractNumeric(text: string): number | null {
  const match = text.trim().match(/^[<>]?\s*([\d.]+)/);
  if (match) {
    const val = parseFloat(match[1]);
    return isNaN(val) ? null : val;
  }
  return null;
}

/** Get color class and arrow indicator for a value relative to its normal range. */
function getValueFlag(value: number, range: { low: number; high: number }): { colorClass: string; arrow: string } {
  const span = range.high - range.low || 1;
  if (value < range.low) {
    const critical = (range.low - value) > span * 0.5;
    return {
      colorClass: critical
        ? 'text-red-600 dark:text-red-400 font-semibold'
        : 'text-amber-600 dark:text-amber-400 font-semibold',
      arrow: critical ? ' ↓↓' : ' ↓',
    };
  }
  if (value > range.high) {
    const critical = (value - range.high) > span * 0.5;
    return {
      colorClass: critical
        ? 'text-red-600 dark:text-red-400 font-semibold'
        : 'text-amber-600 dark:text-amber-400 font-semibold',
      arrow: critical ? ' ↑↑' : ' ↑',
    };
  }
  return { colorClass: '', arrow: '' };
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  preText: string;
  postText: string;
}

/** Normalize authored markdown before any table detection or parsing. */
export function normalizeMarkdownSource(text: string): string {
  return decodeHtmlEntities(
    normalizeAngleBracketEscapes(text)
      .replace(/\r\n/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n'),
  );
}

/** Check whether text contains a markdown table (header + separator + body). */
export function hasMarkdownTable(text: string): boolean {
  const lines = normalizeMarkdownSource(text).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (isTableRow(lines[i]) && isSeparatorRow(lines[i + 1])) return true;
  }
  return false;
}

/** Parse the first markdown table found in text, returning headers, rows, and surrounding text. */
export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = normalizeMarkdownSource(text).split('\n');

  // Find the header + separator pair
  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (isTableRow(lines[i]) && isSeparatorRow(lines[i + 1])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  const headers = parseCells(lines[headerIdx]);

  // Collect body rows starting after the separator
  const rows: string[][] = [];
  let endIdx = headerIdx + 2; // first body row index
  while (endIdx < lines.length && isTableRow(lines[endIdx])) {
    rows.push(parseCells(lines[endIdx]));
    endIdx++;
  }

  const preText = lines.slice(0, headerIdx).join('\n').trim();
  const postText = lines.slice(endIdx).join('\n').trim();

  return { headers, rows, preText, postText };
}

/**
 * Split text into its (first) markdown table and the prose around it, or null
 * when there is no table. Applies the same entity decoding and inline-table
 * normalisation InlineMarkdown does, so a caller sees the table InlineMarkdown
 * would have rendered.
 */
export function extractMarkdownTable(text: string): { table: ParsedTable; prose: string } | null {
  const normalized = normalizeInlineTables(normalizeMarkdownSource(text));
  const table = parseMarkdownTable(normalized);
  if (!table) return null;
  return { table, prose: [table.preText, table.postText].filter(Boolean).join('\n\n') };
}

type MarkdownBlock = { kind: 'prose'; text: string } | { kind: 'table'; table: ParsedTable };

/** Multiple side panels must identify themselves without intervening prose. */
export function tablesCanUseSidePane(tables: ParsedTable[]): boolean {
  if (tables.length <= 1) return tables.length === 1;
  const labels = tables.map((table) => table.headers[0]?.trim().toLowerCase() ?? '');
  return labels.every(Boolean) && new Set(labels).size === labels.length;
}

/**
 * Extract every authored markdown table while keeping the prose around them.
 * Tables are returned in source order; prose contains only non-table content.
 */
export function extractMarkdownTables(text: string): { tables: ParsedTable[]; prose: string; blocks: MarkdownBlock[] } {
  const normalized = normalizeInlineTables(normalizeMarkdownSource(text));
  const lines = normalized.split('\n');
  const tables: ParsedTable[] = [];
  const proseParts: string[] = [];
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;

  let i = 0;
  while (i < lines.length - 1) {
    if (!isTableRow(lines[i]) || !isSeparatorRow(lines[i + 1])) {
      i++;
      continue;
    }

    const preText = lines.slice(cursor, i).join('\n').trim();
    if (preText) {
      proseParts.push(preText);
      blocks.push({ kind: 'prose', text: preText });
    }

    const headers = parseCells(lines[i]);
    const rows: string[][] = [];
    let endIdx = i + 2;
    while (endIdx < lines.length && isTableRow(lines[endIdx])) {
      rows.push(parseCells(lines[endIdx]));
      endIdx++;
    }
    const table = { headers, rows, preText, postText: lines.slice(endIdx).join('\n').trim() };
    tables.push(table);
    blocks.push({ kind: 'table', table });
    cursor = endIdx;
    i = endIdx;
  }

  const trailing = lines.slice(cursor).join('\n').trim();
  if (trailing) {
    proseParts.push(trailing);
    blocks.push({ kind: 'prose', text: trailing });
  }

  return { tables, prose: proseParts.join('\n\n'), blocks };
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2;
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s\-:|]+\|$/.test(line);
}

function parseCells(line: string): string[] {
  // Remove leading/trailing pipes and split by pipes
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1); // remove outer pipes
  return inner.split('|').map(c => c.trim());
}

/**
 * Normalize inline table syntax (single-line pipe tables) into multi-line
 * format so the existing table parser can detect and render them.
 *
 * Finds the separator row (e.g. |---|---|) as an anchor, counts pipes-per-row,
 * then splits the surrounding text into proper table rows.
 */
export function normalizeInlineTables(text: string): string {
  text = normalizeMarkdownSource(text);
  // A canonical table must not hide a collapsed table elsewhere in the stem.
  // Normalize only prose lines containing a separator, leaving table rows intact.
  if (hasMarkdownTable(text)) {
    return text.split('\n').map((line) =>
      /\|\s*[-:]+\s*(?:\|\s*[-:]+\s*)+\|/.test(line) && !isSeparatorRow(line)
        ? normalizeInlineTables(line)
        : line,
    ).join('\n');
  }

  // Find separator: |---| pattern with at least 2 columns
  const sepRegex = /\|\s*[-:]+\s*(?:\|\s*[-:]+\s*)+\|/;
  const sepMatch = text.match(sepRegex);
  if (!sepMatch) return text;

  const sep = sepMatch[0];
  const numPipes = (sep.match(/\|/g) || []).length;

  const sepIdx = sepMatch.index!;

  // Scan backwards from separator to find header row (same pipe count)
  let pipeCount = 0;
  let headerStart = sepIdx;
  for (let i = sepIdx - 1; i >= 0; i--) {
    if (text[i] === '|') {
      pipeCount++;
      if (pipeCount === numPipes) {
        headerStart = i;
        break;
      }
    }
  }
  if (pipeCount < numPipes) return text;

  // Scan forward from after separator to extract data rows
  const afterSep = sepIdx + sep.length;
  const rows: string[] = [];
  let currentRow = '';
  let pipesInRow = 0;
  let lastRowEnd = afterSep;

  for (let i = afterSep; i < text.length; i++) {
    if (text[i] === '|') {
      pipesInRow++;
      currentRow += text[i];
      if (pipesInRow === numPipes) {
        rows.push(currentRow.trim());
        currentRow = '';
        pipesInRow = 0;
        lastRowEnd = i + 1;
      }
    } else {
      currentRow += text[i];
      // Stop if we hit content that can't be a table row (e.g. starts a list)
      if (pipesInRow === 0 && currentRow.trimStart().startsWith('-')) {
        break;
      }
    }
  }

  const preText = text.slice(0, headerStart).trim();
  const headerRow = text.slice(headerStart, sepIdx).trim();
  const postText = text.slice(lastRowEnd).trim();

  const parts: string[] = [];
  if (preText) parts.push(preText);
  parts.push(headerRow);
  parts.push(sep.trim());
  parts.push(...rows);
  if (postText) parts.push(postText);

  return parts.join('\n');
}

/**
 * Leaf renderer type: converts plain text (no markdown) into React elements.
 * Default is identity (passthrough). Can be overridden to add glossary/term support.
 */
export type LeafRenderer = (text: string) => ReactNode;

const defaultLeaf: LeafRenderer = (text: string) => text;

/**
 * Renders inline markdown (bold, italic, tables) as React elements.
 * Handles **bold**, *italic*, HTML entities, and markdown tables.
 *
 * @param text - The text to render
 * @param leafRenderer - Optional custom renderer for plain-text leaf nodes.
 *   Defaults to identity (passthrough). Pass a glossary-aware function to also
 *   render abbreviation tooltips.
 */
export function InlineMarkdown({ text, leafRenderer }: { text: string; leafRenderer?: LeafRenderer }): ReactNode {
  const leaf = leafRenderer ?? defaultLeaf;

  // First decode HTML entities
  const decoded = normalizeMarkdownSource(text);

  // Normalize inline tables (single-line pipe tables) before detection
  const tableNormalized = normalizeInlineTables(decoded);

  // Check for table content
  if (hasMarkdownTable(tableNormalized)) {
    return renderWithTable(tableNormalized, leaf);
  }

  // Parse inline markdown and return React elements
  return parseInlineMarkdown(decoded, leaf);
}


/**
 * One markdown table as a real <table>, with the Value/Normal colour coding.
 * Exported so a results table can be rendered somewhere other than inline —
 * the MCQ view puts a stem's results block in the side pane beside the stem.
 */
export function MarkdownTable({ table, leafRenderer }: { table: ParsedTable; leafRenderer?: LeafRenderer }): ReactNode {
  const leaf = leafRenderer ?? defaultLeaf;
  const parsed = table;
  // Detect "Normal" / "Reference" column for color-coding
  const normalHeaders = ['normal', 'normal range', 'reference', 'ref'];
  const valueHeaders = ['value', 'result'];
  const normalColIdx = parsed.headers.findIndex(h => normalHeaders.includes(h.trim().toLowerCase()));
  const valueColIdx = parsed.headers.findIndex(h => valueHeaders.includes(h.trim().toLowerCase()));

  return (
    <table className="my-2 w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-[var(--md-outline-variant)]">
            {parsed.headers.map((h, i) => (
              <th key={i} className="py-1 px-2 text-left text-xs font-medium text-[var(--md-on-surface-variant)] uppercase tracking-wider">
                {parseInlineMarkdown(h, leaf)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parsed.rows.map((row, ri) => {
            // If we have both Value and Normal columns, compute color + arrow for the value cell
            let flag = { colorClass: '', arrow: '' };
            if (normalColIdx >= 0 && valueColIdx >= 0 && row[normalColIdx] && row[valueColIdx]) {
              const range = parseRange(row[normalColIdx]);
              const value = extractNumeric(row[valueColIdx]);
              if (range && value !== null) {
                flag = getValueFlag(value, range);
              }
            }
  
            return (
              <tr key={ri} className="border-b border-[var(--md-outline-variant)]/30">
                {row.map((cell, ci) => (
                  <td key={ci} className={`py-1 px-2 ${ci === valueColIdx ? flag.colorClass : ''}`}>
                    {parseInlineMarkdown(cell, leaf)}
                    {ci === valueColIdx && flag.arrow && (
                      <span className={flag.colorClass}>{flag.arrow}</span>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
  );
}

function renderWithTable(text: string, leaf: LeafRenderer): ReactNode {
  const extracted = extractMarkdownTables(text);
  if (extracted.tables.length === 0) return parseInlineMarkdown(text, leaf);

  return <>{extracted.blocks.map((block, index) => block.kind === 'prose'
    ? <span key={index}>{parseInlineMarkdown(block.text, leaf)}</span>
    : <MarkdownTable key={index} table={block.table} leafRenderer={leaf} />)}</>;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', ge: '≥', le: '≤',
    rarr: '→', uarr: '↑', darr: '↓', plusmn: '±',
    deg: '°', alpha: 'α', beta: 'β', micro: 'µ',
    nbsp: ' ', quot: '"', apos: "'",
  };
  return text.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (match, e) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16)) || match;
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10)) || match;
    return entities[e] ?? match;
  });
}

function parseInlineMarkdown(text: string, leaf: LeafRenderer): ReactNode {
  const parts: ReactNode[] = [];
  let key = 0;

  const boldPattern = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = boldPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={key++}>
          {parseItalic(text.slice(lastIndex, match.index), leaf)}
        </Fragment>
      );
    }
    parts.push(
      <strong key={key++} className="font-semibold">
        {parseItalic(match[1], leaf)}
      </strong>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Fragment key={key++}>
        {parseItalic(text.slice(lastIndex), leaf)}
      </Fragment>
    );
  }

  return parts.length > 0 ? parts : leaf(text);
}

function parseItalic(text: string, leaf: LeafRenderer): ReactNode {
  const parts: ReactNode[] = [];
  let key = 0;

  const italicPattern = /(?<!\*)\*([^*]+)\*(?!\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = italicPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={key++}>
          {leaf(text.slice(lastIndex, match.index))}
        </Fragment>
      );
    }
    parts.push(
      <em key={key++}>{leaf(match[1])}</em>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Fragment key={key++}>
        {leaf(text.slice(lastIndex))}
      </Fragment>
    );
  }

  return parts.length > 0 ? parts : leaf(text);
}
