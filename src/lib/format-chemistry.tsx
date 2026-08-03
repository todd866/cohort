import { Fragment, type ReactNode } from 'react';

/**
 * Normalize Unicode sub/superscript characters back to plain ASCII
 * so patterns match regardless of input encoding.
 */
const SUP_DIGITS: Record<string, string> = {
  '\u2070': '0', '\u00B9': '1', '\u00B2': '2', '\u00B3': '3',
  '\u2074': '4', '\u2075': '5', '\u2076': '6', '\u2077': '7',
  '\u2078': '8', '\u2079': '9',
};

function normalizeUnicode(text: string): string {
  return text
    .replace(/[\u2080-\u2089]/g, ch => String(ch.charCodeAt(0) - 0x2080))
    .replace(/[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]/g, ch => SUP_DIGITS[ch] ?? ch)
    .replace(/\u207A/g, '+')
    .replace(/\u207B/g, '-');
}

/**
 * Greek letter substitution for medical terminology.
 * Uses word-boundary matching to avoid mangling words like "alphabet".
 * Only converts when followed by a hyphen or whitespace (e.g. "beta-blocker", "alpha 1").
 */
const GREEK_RE = /\b(alpha|beta|gamma|delta)([-\s])/gi;
const GREEK_MAP: Record<string, string> = {
  'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ',
};

function substituteGreekLetters(text: string): string {
  return text.replace(GREEK_RE, (_, letter, sep) => {
    return (GREEK_MAP[letter.toLowerCase()] ?? letter) + sep;
  });
}

/**
 * Render any remaining Unicode subscript/superscript characters as
 * proper <sub>/<sup> elements. Catches anything the CHEM whitelist misses
 * (e.g. Zn²⁺, MnO₄⁻, e⁻ from electrochemistry content).
 */
const UNICODE_SUB_SUP_RE = /([\u2080-\u2089]+)|([\u2070\u00B9\u00B2\u00B3\u2074-\u2079\u207A\u207B]+)/g;

function renderUnicodeSubSup(text: string, baseKey: number): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let k = 0;

  UNICODE_SUB_SUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNICODE_SUB_SUP_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const ascii = normalizeUnicode(m[0]);
    if (m[1]) {
      parts.push(<sub key={`u${baseKey}-${k++}`}>{ascii}</sub>);
    } else {
      parts.push(<sup key={`u${baseKey}-${k++}`}>{ascii}</sup>);
    }
    last = UNICODE_SUB_SUP_RE.lastIndex;
  }

  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment key={`uf${baseKey}`}>{parts}</Fragment>;
}

/**
 * Known chemistry patterns → JSX with proper <sub>/<sup> tags.
 * Ordered longest-first so the regex alternation matches greedily.
 *
 * Includes common uppercase variants (ETCO2, FIO2, SPO2 etc.) since
 * question bank content sometimes uses all-caps notation.
 */
function sub2(prefix: string) {
  const Sub2 = (k: number) => <Fragment key={k}>{prefix}<sub>2</sub></Fragment>;
  Sub2.displayName = `Sub2(${prefix})`;
  return Sub2;
}
function sub2O(prefix: string) {
  const Sub2O = (k: number) => <Fragment key={k}>{prefix}<sub>2</sub>O</Fragment>;
  Sub2O.displayName = `Sub2O(${prefix})`;
  return Sub2O;
}

const CHEM: Array<[string, (k: number) => ReactNode]> = [
  // --- Gas exchange (longest patterns first) ---
  ['PaCO2',  sub2('PaCO')],
  ['PACO2',  sub2('PACO')],   // uppercase variant
  ['EtCO2',  sub2('EtCO')],
  ['ETCO2',  sub2('ETCO')],   // uppercase variant
  ['ScvO2',  sub2('ScvO')],   // central venous O2 saturation
  ['pCO2',   sub2('pCO')],
  ['SvO2',   sub2('SvO')],    // mixed venous O2 saturation
  ['CaO2',   sub2('CaO')],    // arterial O2 content
  ['CvO2',   sub2('CvO')],    // venous O2 content
  ['PAO2',   sub2('PAO')],    // alveolar O2 (capital A)
  ['PaO2',   sub2('PaO')],
  ['PvO2',   sub2('PvO')],    // venous O2 partial pressure
  ['FiO2',   sub2('FiO')],
  ['FIO2',   sub2('FIO')],    // uppercase variant
  ['SpO2',   sub2('SpO')],
  ['SPO2',   sub2('SPO')],    // uppercase variant
  ['SaO2',   sub2('SaO')],
  ['DO2',    sub2('DO')],     // oxygen delivery
  ['VO2',    sub2('VO')],     // oxygen consumption

  // --- Bicarbonate ---
  ['NaHCO3', k => <Fragment key={k}>NaHCO<sub>3</sub></Fragment>],
  ['HCO3-',  k => <Fragment key={k}>HCO<sub>3</sub><sup>-</sup></Fragment>],
  ['HCO3',   k => <Fragment key={k}>HCO<sub>3</sub></Fragment>],

  // --- Compounds (longest first) ---
  ['H2CO3',  k => <Fragment key={k}>H<sub>2</sub>CO<sub>3</sub></Fragment>],
  ['MgSO4',  k => <Fragment key={k}>MgSO<sub>4</sub></Fragment>],
  ['CaCO3',  k => <Fragment key={k}>CaCO<sub>3</sub></Fragment>],
  ['CaCl2',  k => <Fragment key={k}>CaCl<sub>2</sub></Fragment>],
  ['cmH2O',  sub2O('cmH')],
  ['CO2',    sub2('CO')],
  ['H2O',    k => <Fragment key={k}>H<sub>2</sub>O</Fragment>],
  ['N2O',    k => <Fragment key={k}>N<sub>2</sub>O</Fragment>],
  ['NH3',    k => <Fragment key={k}>NH<sub>3</sub></Fragment>],
  ['O2',     sub2('O')],

  // --- Ions (longest-first within each element) ---
  // No-caret variants for Unicode-normalized input (SO₄²⁻ → SO42-)
  ['PO43-',  k => <Fragment key={k}>PO<sub>4</sub><sup>3-</sup></Fragment>],
  ['PO4^3-', k => <Fragment key={k}>PO<sub>4</sub><sup>3-</sup></Fragment>],
  ['PO4',    k => <Fragment key={k}>PO<sub>4</sub></Fragment>],
  ['SO42-',  k => <Fragment key={k}>SO<sub>4</sub><sup>2-</sup></Fragment>],
  ['SO4^2-', k => <Fragment key={k}>SO<sub>4</sub><sup>2-</sup></Fragment>],
  ['SO4',    k => <Fragment key={k}>SO<sub>4</sub></Fragment>],
  ['NH4+',   k => <Fragment key={k}>NH<sub>4</sub><sup>+</sup></Fragment>],
  ['Fe3+',   k => <Fragment key={k}>Fe<sup>3+</sup></Fragment>],
  ['Fe2+',   k => <Fragment key={k}>Fe<sup>2+</sup></Fragment>],
  ['Ca2+',   k => <Fragment key={k}>Ca<sup>2+</sup></Fragment>],
  ['Mg2+',   k => <Fragment key={k}>Mg<sup>2+</sup></Fragment>],
  ['Na+',    k => <Fragment key={k}>Na<sup>+</sup></Fragment>],
  ['K+',     k => <Fragment key={k}>K<sup>+</sup></Fragment>],
  ['H+',     k => <Fragment key={k}>H<sup>+</sup></Fragment>],
  ['OH-',    k => <Fragment key={k}>OH<sup>-</sup></Fragment>],
  ['Cl-',    k => <Fragment key={k}>Cl<sup>-</sup></Fragment>],
];

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const CHEM_RE = new RegExp(
  `\\b(?:${CHEM.map(([p]) => esc(p)).join('|')})`,
  'g',
);

const RENDER = new Map(CHEM);

/**
 * formatChemistry — converts plain-text chemistry notation into proper
 * HTML sub/superscripts rendered as React elements.
 *
 *   PaO2  → PaO<sub>2</sub>
 *   Na+   → Na<sup>+</sup>
 *   HCO3- → HCO<sub>3</sub><sup>-</sup>
 *   DO2   → DO<sub>2</sub>
 *   cmH2O → cmH<sub>2</sub>O
 *
 * Handles three layers:
 * 1. Known CHEM patterns (whitelist) → exact rendering
 * 2. Unicode sub/superscript characters → generic <sub>/<sup> rendering
 * 3. Greek letter substitution (alpha → α, etc.)
 */
export function formatChemistry(text: string): ReactNode {
  if (!text) return text;

  // Greek substitution first (may change string length)
  const withGreek = substituteGreekLetters(text);

  // Normalize Unicode → ASCII for CHEM pattern matching.
  // normalizeUnicode does 1:1 char replacement so positions are preserved
  // between withGreek and norm.
  const norm = normalizeUnicode(withGreek);

  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  CHEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHEM_RE.exec(norm)) !== null) {
    if (m.index > last) {
      // For unmatched segments, render any remaining Unicode sub/super
      // from the original (pre-normalization) text at the same positions
      parts.push(renderUnicodeSubSup(withGreek.slice(last, m.index), key++));
    }
    const render = RENDER.get(m[0]);
    if (render) parts.push(render(key++));
    last = CHEM_RE.lastIndex;
  }

  if (parts.length === 0) {
    // No CHEM patterns matched — still render Unicode sub/super generically
    return renderUnicodeSubSup(withGreek, 0);
  }

  if (last < norm.length) {
    parts.push(renderUnicodeSubSup(withGreek.slice(last), key++));
  }

  return <>{parts}</>;
}
