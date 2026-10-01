import type { CuratedQuestion } from './types';

const REPLACEMENTS: Array<[string, string]> = [
  ['NaHCO3', 'NaHCO₃'],
  ['H2CO3', 'H₂CO₃'],
  ['PaCO2', 'PaCO₂'],
  ['PACO2', 'PACO₂'],
  ['EtCO2', 'EtCO₂'],
  ['ETCO2', 'ETCO₂'],
  ['PaO2', 'PaO₂'],
  ['PAO2', 'PAO₂'],
  ['FiO2', 'FiO₂'],
  ['FIO2', 'FIO₂'],
  ['SpO2', 'SpO₂'],
  ['SPO2', 'SPO₂'],
  ['SaO2', 'SaO₂'],
  ['cmH2O', 'cmH₂O'],
  ['HCO3-', 'HCO₃⁻'],
  ['HCO3', 'HCO₃⁻'],
  ['H2O', 'H₂O'],
  ['N2O', 'N₂O'],
  ['CO2', 'CO₂'],
  ['SO42-', 'SO₄²⁻'],
  ['SO4^2-', 'SO₄²⁻'],
  ['NH4+', 'NH₄⁺'],
  ['Fe3+', 'Fe³⁺'],
  ['Fe2+', 'Fe²⁺'],
  ['Ca2+', 'Ca²⁺'],
  ['Mg2+', 'Mg²⁺'],
  ['Na+', 'Na⁺'],
  ['K+', 'K⁺'],
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_CHARS = /[a-zA-Z0-9₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/;
const PATTERN = new RegExp(REPLACEMENTS.map(([key]) => escapeRegex(key)).join('|'), 'g');
const MAP = new Map(REPLACEMENTS);

export function normalizeMedicalNotationText(text: string): string {
  if (!text) return text;

  return text.replace(PATTERN, (match, offset) => {
    const i = Number(offset);

    if (i > 0 && WORD_CHARS.test(text[i - 1])) return match;
    const after = i + match.length;
    if (after < text.length && WORD_CHARS.test(text[after])) return match;

    return MAP.get(match) ?? match;
  });
}

export function normalizeQuestionNotation(question: CuratedQuestion): CuratedQuestion {
  let changed = false;

  const stem = normalizeMedicalNotationText(question.stem);
  if (stem !== question.stem) changed = true;

  const context = normalizeMedicalNotationText(question.context);
  if (context !== question.context) changed = true;

  const options = question.options.map((option) => {
    const text = normalizeMedicalNotationText(option.text);
    const optionExplanation =
      typeof option.explanation === 'string'
        ? normalizeMedicalNotationText(option.explanation)
        : option.explanation;
    if (text !== option.text || optionExplanation !== option.explanation) changed = true;
    return {
      ...option,
      text,
      ...(typeof optionExplanation === 'string' ? { explanation: optionExplanation } : {}),
    };
  });

  const correctVariants = Array.isArray(question.correctVariants)
    ? question.correctVariants.map((variant) => {
        const normalized = normalizeMedicalNotationText(variant);
        if (normalized !== variant) changed = true;
        return normalized;
      })
    : question.correctVariants;

  const annotations = question.annotations
    ? Object.fromEntries(
        Object.entries(question.annotations).map(([k, v]) => {
          const nk = normalizeMedicalNotationText(k);
          const nv = normalizeMedicalNotationText(v);
          if (nk !== k || nv !== v) changed = true;
          return [nk, nv];
        })
      )
    : question.annotations;

  const abbreviations = question.abbreviations
    ? Object.fromEntries(
        Object.entries(question.abbreviations).map(([k, v]) => {
          const nk = normalizeMedicalNotationText(k);
          const nv = normalizeMedicalNotationText(v);
          if (nk !== k || nv !== v) changed = true;
          return [nk, nv];
        })
      )
    : question.abbreviations;

  if (!changed) return question;

  return {
    ...question,
    stem,
    context,
    options,
    correctVariants,
    annotations,
    abbreviations,
  };
}
