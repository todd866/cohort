/**
 * Shared authoring/audit gate for measurement panels.
 *
 * A stem needs a results table for three labelled numeric measurements, or
 * a contiguous pair of distinct measurements each accompanied by a numeric
 * reference range, outside authored pipe-table rows. This is deliberately a count across the whole stem: separate
 * patient/time panels are an authoring concern for the repacker, while the
 * source gate still needs to catch them.
 */

import { extractMarkdownTables } from '../inline-markdown';

const NUMBER = String.raw`(?:[<>≤≥]\s*)?\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?(?:\s*/\s*\d+(?:[.,]\d+)?)?`;
const CONNECTOR = String.raw`\s*(?:(?:is|of|at|was|were|measured\s+at)\s*|[:=]\s*)?`;

// Each expression names one measurement family. Keeping families separate
// means HR 110 does not get counted again as a generic number in BP/RR logic.
const MEASUREMENT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(blood\s+pressure|BP)\b${CONNECTOR}${NUMBER}(?:\s*(?:mmHg|kPa))?`, 'gi'),
  new RegExp(String.raw`\b(heart\s+rate|pulse|HR)\b${CONNECTOR}${NUMBER}(?:\s*(?:bpm|beats?\s*/\s*min(?:ute)?s?))?`, 'gi'),
  new RegExp(String.raw`\b(respiratory\s+rate|respirations?|RR)\b${CONNECTOR}${NUMBER}(?:\s*(?:/\s*min(?:ute)?s?|breaths?\s*/\s*min(?:ute)?s?))?`, 'gi'),
  new RegExp(String.raw`\b(oxygen\s+saturation|oxygen\s+sat(?:uration)?|SpO(?:2|₂)|SaO(?:2|₂))(?=\s|[:=,.;)]|$)${CONNECTOR}${NUMBER}\s*%?`, 'gi'),
  new RegExp(String.raw`\b(temperature|core\s+temperature|temp)\b${CONNECTOR}${NUMBER}(?:\s*°?\s*[CF])?`, 'gi'),
  new RegExp(String.raw`\b(haemoglobin|hemoglobin|Hb|white\s+cell\s+count|leukocyte\s+count|WCC|WBC|platelets?|platelet\s+count|neutrophils?|lymphocytes?|ANC|red[- ]cell\s+count|MCV|reticulocytes?|ferritin|CK|CRP|ESR|INR|APTT|PT|LDH|troponin|BNP|TSH|T4|glucose|lactate|urea|creatinine|bilirubin|ALT|AST|GGT|ALP|albumin|calcium|magnesium|phosphate|sodium|Na[⁺+]?|potassium|K[⁺+]?|chloride|Cl[⁻-]?|bicarbonate|HCO(?:3|₃)[⁻-]?|pH|PaCO(?:2|₂)|pCO(?:2|₂)|PaO(?:2|₂)|pO(?:2|₂)|FiO(?:2|₂))(?=\s|[:=,.;)]|$)${CONNECTOR}${NUMBER}(?:\s*(?:%|g\s*/\s*L|mg\s*/\s*dL|mmol\s*/\s*L|µmol\s*/\s*L|mEq\s*/\s*L|IU\s*/\s*L|U\s*/\s*L|[x×]\s*10\^?\s*9\s*/\s*L|mmHg|kPa))?`, 'gi'),
];

type Measurement = { start: number; end: number; key: string };

const LAB_ALIASES: Record<string, string> = {
  hb: 'haemoglobin', hemoglobin: 'haemoglobin',
  whitecellcount: 'wcc', leukocytecount: 'wcc', wbc: 'wcc',
  platelet: 'platelets', plateletcount: 'platelets',
  redcellcount: 'rbc', na: 'sodium', k: 'potassium', cl: 'chloride',
  hco3: 'bicarbonate',
};

/** Mask non-measurements while retaining offsets into the original prose. */
function maskNonMeasurements(prose: string): string {
  return prose
    .replace(/\((?:normal|acceptable|reference|target)\b[^)]*\)/gi, (text) => ' '.repeat(text.length))
    // A treatment concentration is not a measured serum electrolyte.
    .replace(/\b(?:sodium|potassium|calcium)\s+chloride\s+\d+(?:\.\d+)?\s*%/gi, (text) => ' '.repeat(text.length));
}

function inlineMeasurements(prose: string): Measurement[] {
  const masked = maskNonMeasurements(prose);
  return MEASUREMENT_PATTERNS.flatMap((pattern, family) =>
    [...masked.matchAll(pattern)].map((match) => {
      const label = match[1].toLowerCase().replace(/₃/g, '3').replace(/[\s⁺+⁻-]/g, '');
      return {
        start: match.index!,
        end: match.index! + match[0].length,
        key: family < 5 ? String(family) : `lab:${LAB_ALIASES[label] ?? label}`,
      };
    }),
  ).sort((a, b) => a.start - b.start);
}

// Some counter patterns stop before a longer unit spelling or an oxygen
// condition. Only units/conditions may bridge the result and its reference;
// prose such as "after treatment" must not turn two narrative facts into a panel.
const REFERENCE_UNIT_WORDS = new Set('mm hg mmhg kpa mmol mol l dl ml g mg ug ng pg iu miu u fl meq mosm nmol pmol c f bpm beats beat breaths breath per min minute minutes s sec seconds x in on room air ra'.split(' '));
function referenceEnd(prose: string, measurementEnd: number): number | null {
  const match = prose.slice(measurementEnd).match(/^([^()\n]{0,35})\(([^()\n]*)\)/);
  if (!match || !/^[\d\s.,<>≤≥−+\-/%°×^⁰¹²³⁴⁵⁶⁷⁸⁹µμa-z]*$/i.test(match[1])) return null;
  if ((match[1].match(/[a-z]+/gi) ?? []).some((word) => !REFERENCE_UNIT_WORDS.has(word.toLowerCase()))) return null;
  // A range or threshold is evidence of a reference panel. Qualitative notes,
  // ages and isolated parenthetical counts do not satisfy this condition.
  if (!/(?:\d+(?:\.\d+)?\s*[-–—]\s*\d|[<>≤≥]\s*\d)/.test(match[2])) return null;
  return measurementEnd + match[0].length;
}

export function countInlineMeasurements(stem: string): number {
  if (typeof stem !== 'string' || !stem.trim()) return 0;
  return inlineMeasurements(extractMarkdownTables(stem).prose).length;
}

export function needsResultsTable(stem: string): boolean {
  if (typeof stem !== 'string' || !stem.trim()) return false;
  const prose = extractMarkdownTables(stem).prose;
  const measurements = inlineMeasurements(prose);
  if (measurements.length >= 3) return true;
  if (measurements.length !== 2 || measurements[0].key === measurements[1].key) return false;
  const firstEnd = referenceEnd(prose, measurements[0].end);
  const secondEnd = referenceEnd(prose, measurements[1].end);
  if (firstEnd === null || secondEnd === null) return false;
  // The pair must be explicitly listed together, not merely occur somewhere
  // in the same stem or on opposite sides of an existing authored table.
  const between = prose.slice(firstEnd, measurements[1].start);
  return !/\n\s*\n/.test(between)
    && /^\s*(?:,\s*(?:and\s+)?|;\s*(?:and\s+)?|and\s+)(?:(?:his|her|the)\s+)?$/i.test(between);
}
