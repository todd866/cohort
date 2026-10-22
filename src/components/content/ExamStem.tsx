/**
 * Renders an exam stem: paragraphs split on blank lines, and a markdown pipe
 * table (header row, `|---|` separator, body rows) as a real table. Lab
 * results are the one structure exam vignettes need; on a phone a table of
 * raw pipes is unreadable. `x10^9` is written as ×10⁹.
 */
import { splitStemLead } from '@/lib/question-stem-lead';
type Block = { kind: 'text'; text: string } | { kind: 'table'; header: string[]; rows: string[][] };

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

export function formatPowers(text: string): string {
  return text.replace(/(?:[x×]\s?)?10\^(-?\d+)/g, (match, exp: string) => {
    const times = /^[x×]/.test(match) ? '×' : '';
    return `${times}10${[...exp].map((c) => SUPERSCRIPT[c] ?? c).join('')}`;
  });
}

const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function parseStem(stem: string): Block[] {
  const blocks: Block[] = [];
  const lines = stem.split('\n');
  let text: string[] = [];
  const flushText = () => {
    const joined = text.join('\n').trim();
    if (joined) {
      for (const para of joined.split(/\n\s*\n/)) {
        if (para.trim()) blocks.push({ kind: 'text', text: para.trim() });
      }
    }
    text = [];
  };
  for (let i = 0; i < lines.length; ) {
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flushText();
      const header = cells(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    text.push(lines[i]);
    i += 1;
  }
  flushText();
  return blocks;
}

/** The question line is bold here as in review (splitStemLead). */
function StemLead({ text }: { text: string }) {
  const { body, lead } = splitStemLead(text);
  return <>
    {body && <p className="whitespace-pre-line">{formatPowers(body)}</p>}
    {lead && <p data-question-lead className="whitespace-pre-line">{formatPowers(lead)}</p>}
  </>;
}

export function ExamStem({ stem, className = '' }: { stem: string; className?: string }) {
  return (
    <div data-question-stem className={`space-y-3 text-base leading-relaxed ${className}`}>
      {parseStem(stem).map((block, b, blocks) =>
        block.kind === 'text' ? (
          b === blocks.findLastIndex((x) => x.kind === 'text')
            ? <StemLead key={b} text={block.text} />
            : <p key={b} className="whitespace-pre-line">{formatPowers(block.text)}</p>
        ) : (
          <div key={b} className="overflow-x-auto">
            <table className="w-full border-collapse text-sm tabular-nums">
              <thead>
                <tr>
                  {block.header.map((h, c) => (
                    <th
                      key={c}
                      scope="col"
                      className="border-b px-2 py-1.5 text-left font-semibold"
                      style={{ borderColor: 'var(--md-outline)' }}
                    >
                      {formatPowers(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td
                        key={c}
                        className="border-b px-2 py-1.5 align-top"
                        style={{
                          borderColor: 'var(--md-outline-variant)',
                          color: c === row.length - 1 && row.length > 2 ? 'var(--md-on-surface-variant)' : undefined,
                        }}
                      >
                        {formatPowers(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ),
      )}
    </div>
  );
}
