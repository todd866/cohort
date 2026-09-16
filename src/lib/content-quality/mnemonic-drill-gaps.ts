/**
 * Mnemonic drill gaps — which mnemonics does the corpus teach but never test?
 *
 * `<Mnemonic>` blocks are reading-mode prose. extractMnemonicCards has
 * returned [] since 2026-05-03, when auto-generated `T=[___], E=[___]` cards
 * were retired for cueing the answer with its own letter and burying the
 * teaching in boilerplate. That fix was right, and its plan — "authors who
 * want test cards write proper KeyPoint Q&A alongside" — never happened at
 * scale: CAH and PWH have 65 mnemonic blocks between them and none drilled.
 *
 * This is the deterministic half of the usual sieve → agent QA loop. It finds
 * candidates; a human or agent decides what to author. It deliberately does
 * NOT generate cards, because generating them mechanically is the thing that
 * failed before.
 */

export interface MnemonicBlock {
  title: string;
  items: string[];
}

export interface MnemonicDrillGap extends MnemonicBlock {
  path: string;
  itemCount: number;
}

export interface SourceFile {
  path: string;
  text: string;
}

const MNEMONIC_RE = /<Mnemonic\b([^>]*)>([\s\S]*?)<\/Mnemonic>/g;
const TITLE_RE = /title="([^"]+)"/;
/** `**C**onjunctivitis (bilateral)` → `Conjunctivitis`, parenthetical dropped. */
const ITEM_RE = /^\s*\*\*([^*]+)\*\*([^\n(]*)/;

/**
 * Strip the markdown emphasis a mnemonic uses to highlight its letters, and
 * any inline JSX — `<Term abbr="BMI" />` hover-decode tags sit mid-item and
 * would otherwise be matched as part of the recall target.
 */
function cleanItem(bold: string, rest: string): string {
  return `${bold}${rest}`
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]$/, '');
}

export function extractMnemonics(text: string): MnemonicBlock[] {
  const out: MnemonicBlock[] = [];
  for (const match of text.matchAll(MNEMONIC_RE)) {
    const title = TITLE_RE.exec(match[1])?.[1];
    if (!title) continue;
    const items: string[] = [];
    for (const line of match[2].split('\n')) {
      const item = ITEM_RE.exec(line);
      if (item) items.push(cleanItem(item[1], item[2]));
    }
    out.push({ title, items });
  }
  return out;
}

/** Cloze answers in the file, lower-cased. `**A:** a; b` contributes a and b. */
function clozeAnswers(text: string): Set<string> {
  const answers = new Set<string>();
  for (const match of text.matchAll(/\*\*A:\*\*(.+)/g)) {
    for (const part of match[1].split(';')) {
      const clean = part.replace(/<\/?[^>]+>/g, '').replace(/[*_`]/g, '').trim().toLowerCase();
      if (clean) answers.add(clean);
    }
  }
  return answers;
}

/**
 * A mnemonic counts as drilled when the file either names it in a card, or
 * uses at least half its items as cloze answers. One incidental item is not
 * enough — testing conjunctivitis once does not teach the set.
 */
function isDrilled(block: MnemonicBlock, text: string, answers: Set<string>): boolean {
  const cards = text.replace(MNEMONIC_RE, '');
  if (new RegExp(`\\b${block.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(cards)) {
    return true;
  }
  if (block.items.length === 0) return false;
  const hit = block.items.filter((item) => {
    const needle = item.toLowerCase();
    return [...answers].some((a) => a === needle || a.includes(needle) || needle.includes(a));
  }).length;
  return hit * 2 >= block.items.length;
}

export function findMnemonicDrillGaps(files: SourceFile[]): MnemonicDrillGap[] {
  const gaps: MnemonicDrillGap[] = [];
  for (const file of files) {
    const answers = clozeAnswers(file.text);
    for (const block of extractMnemonics(file.text)) {
      if (isDrilled(block, file.text, answers)) continue;
      gaps.push({ ...block, path: file.path, itemCount: block.items.length });
    }
  }
  // Biggest sets first: they carry the most untested recall per card authored.
  return gaps.sort((a, b) => b.itemCount - a.itemCount || a.path.localeCompare(b.path));
}
