'use client';

import { useState } from 'react';
import { InlineMarkdown } from '@/lib/inline-markdown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ABGContextPanelProps {
  contextText: string;
}

export interface ParsedABGValue {
  label: string;
  value: number;
  raw: string; // original matched text (e.g. "+4", "7.25")
  isAbnormal: boolean;
}

export interface ParsedABGContext {
  patientLine: string | null;
  abgValues: ParsedABGValue[];
  electrolytes: ParsedABGValue[];
  otherLines: string[];
  fiO2: string | null;
}

// ---------------------------------------------------------------------------
// Reference ranges
// ---------------------------------------------------------------------------

interface Range {
  low: number;
  high: number;
  label: string;
  unit: string;
}

const ABG_RANGES: Record<string, Range> = {
  ph:      { low: 7.35,  high: 7.45,  label: 'pH',           unit: '' },
  paco2:   { low: 35,    high: 45,    label: 'PaCO\u2082',   unit: 'mmHg' },
  pao2:    { low: 80,    high: 100,   label: 'PaO\u2082',    unit: 'mmHg' },
  hco3:    { low: 22,    high: 26,    label: 'HCO\u2083',    unit: 'mmol/L' },
  be:      { low: -2,    high: 2,     label: 'BE',            unit: '' },
  lactate: { low: 0,     high: 2,     label: 'Lactate',       unit: 'mmol/L' },
};

const ELECTROLYTE_RANGES: Record<string, Range> = {
  na:      { low: 135,   high: 145,   label: 'Na',       unit: 'mmol/L' },
  k:       { low: 3.5,   high: 5.0,   label: 'K',        unit: 'mmol/L' },
  cl:      { low: 96,    high: 106,   label: 'Cl',       unit: 'mmol/L' },
  glucose: { low: 3.5,   high: 5.5,   label: 'Glucose',  unit: 'mmol/L (fasting)' },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Individual value patterns — order matters for overlapping labels.
 * Each entry: [key, regex to match "label <number>"]
 * Capture group 1 = the numeric value (possibly with sign).
 */
const VALUE_PATTERNS: [string, RegExp][] = [
  // ABG values
  ['ph',      /\bpH\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['paco2',   /\b(?:PaCO2|pCO2|pco2)\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['pao2',    /\b(?:PaO2|pO2|po2)\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['hco3',    /\b(?:HCO3|bicarb(?:onate)?)\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['be',      /\bBE\s*[:=]?\s*([+-]?\s*[0-9]+\.?[0-9]*)/i],
  ['lactate', /\b(?:Lactate|Lac)\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  // Electrolytes
  ['na',      /\bNa\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['k',       /\bK\s*[:=+]?\s*([0-9]+\.?[0-9]*)/i],
  ['cl',      /\bCl\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
  ['glucose', /\b(?:Glucose|BSL|BGL)\s*[:=]?\s*([0-9]+\.?[0-9]*)/i],
];

const FIO2_PATTERN = /(?:FiO2|on)\s+([\d.]+%?|room\s*air|\d+L(?:\s*NC)?)/i;
const PATIENT_LINE_PATTERN = /^(\d{1,3}\s*(?:yo|y\/o|y\.o\.?)?\s*(?:M|F|male|female)?[^.]*\.?)/i;

function isAbnormal(key: string, value: number): boolean {
  const range = ABG_RANGES[key] ?? ELECTROLYTE_RANGES[key];
  if (!range) return false;
  return value < range.low || value > range.high;
}

function formatRangeString(range: Range): string {
  if (range.label === 'Lactate') return `<${range.high} ${range.unit}`;
  if (range.label === 'BE') return `${range.low} to +${range.high}`;
  const unitSuffix = range.unit ? ` ${range.unit}` : '';
  return `${range.low}\u2013${range.high}${unitSuffix}`;
}

export function parseABGContext(text: string): ParsedABGContext {
  const result: ParsedABGContext = {
    patientLine: null,
    abgValues: [],
    electrolytes: [],
    otherLines: [],
    fiO2: null,
  };

  if (!text || !text.trim()) return result;

  // Try to extract patient line (first line that looks like demographics)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';

  const patientMatch = firstLine.match(PATIENT_LINE_PATTERN);
  if (patientMatch) {
    result.patientLine = patientMatch[1].trim();
  }

  // Extract FiO2
  const fio2Match = text.match(FIO2_PATTERN);
  if (fio2Match) {
    result.fiO2 = fio2Match[1].trim();
  }

  // Extract values
  const abgKeys = new Set(Object.keys(ABG_RANGES));
  const electrolyteKeys = new Set(Object.keys(ELECTROLYTE_RANGES));
  const matchedKeys = new Set<string>();

  for (const [key, pattern] of VALUE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const rawStr = match[1].replace(/\s/g, '');
      const num = parseFloat(rawStr);
      if (Number.isFinite(num)) {
        const parsed: ParsedABGValue = {
          label: (ABG_RANGES[key]?.label ?? ELECTROLYTE_RANGES[key]?.label ?? key),
          value: num,
          raw: rawStr,
          isAbnormal: isAbnormal(key, num),
        };
        if (abgKeys.has(key)) {
          result.abgValues.push(parsed);
        } else if (electrolyteKeys.has(key)) {
          result.electrolytes.push(parsed);
        }
        matchedKeys.add(key);
      }
    }
  }

  // If we found no structured values at all, put everything in otherLines
  if (result.abgValues.length === 0 && result.electrolytes.length === 0) {
    result.patientLine = null;
    result.otherLines = lines;
    return result;
  }

  // Collect lines that aren't purely value data (clinical info, etc.)
  // Skip the patient line and lines that are mostly value data or section headers
  const valueSectionHeaders = /^(?:ABG|VBG|Electrolytes?|Bloods?)\b/i;
  const bulletLine = /^[•\-*]\s*/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip patient line
    if (i === 0 && result.patientLine) continue;
    // Skip section headers like "ABG (room air):" or "Electrolytes:"
    if (valueSectionHeaders.test(line.replace(bulletLine, ''))) continue;
    // Skip lines that are just bullet-pointed values (contain a matched pattern)
    const stripped = line.replace(bulletLine, '');
    const hasValue = VALUE_PATTERNS.some(([key, pat]) => matchedKeys.has(key) && pat.test(stripped));
    if (hasValue) continue;
    // Keep everything else as "other" info
    if (stripped.length > 0) {
      result.otherLines.push(stripped);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ValueRow({
  parsed,
  rangeKey,
  showRanges,
}: {
  parsed: ParsedABGValue;
  rangeKey: string;
  showRanges: boolean;
}) {
  const range = ABG_RANGES[rangeKey] ?? ELECTROLYTE_RANGES[rangeKey];

  return (
    <div className="flex items-baseline gap-1.5 text-xs leading-relaxed">
      <span className="text-[var(--md-on-surface-variant)] font-medium min-w-[4.5rem]">
        {parsed.label}
      </span>
      <span
        className={`font-semibold tabular-nums ${
          parsed.isAbnormal
            ? 'text-[var(--md-error)]'
            : 'text-[var(--md-on-surface)]'
        }`}
      >
        {parsed.raw}
      </span>
      {parsed.isAbnormal && (
        <span className="text-[var(--md-error)] text-[10px]">
          {parsed.value < (range?.low ?? 0) ? '\u2193' : '\u2191'}
        </span>
      )}
      {showRanges && range && (
        <span className="text-[var(--md-on-surface-variant)]/50 text-[10px]">
          ({formatRangeString(range)})
        </span>
      )}
    </div>
  );
}

// Map parsed labels back to range keys for lookup
function getRangeKey(label: string): string {
  // Reverse lookup from label to key
  for (const [key, range] of Object.entries(ABG_RANGES)) {
    if (range.label === label) return key;
  }
  for (const [key, range] of Object.entries(ELECTROLYTE_RANGES)) {
    if (range.label === label) return key;
  }
  return label.toLowerCase();
}

export function ABGContextPanel({ contextText }: ABGContextPanelProps) {
  const [showRanges, setShowRanges] = useState(false);
  const parsed = parseABGContext(contextText);

  const hasStructuredData = parsed.abgValues.length > 0 || parsed.electrolytes.length > 0;

  // No structured data — render as plain text
  if (!hasStructuredData) {
    return (
      <div className="px-3 py-1.5 bg-[var(--md-surface-container-high)] text-xs text-[var(--md-on-surface-variant)] border-b border-[var(--md-outline-variant)]">
        <InlineMarkdown text={contextText} />
      </div>
    );
  }

  return (
    <div className="bg-[var(--md-surface-container-high)] border-b border-[var(--md-outline-variant)] px-3 py-2 space-y-1.5">
      {/* Patient line */}
      {parsed.patientLine && (
        <div className="text-xs font-medium text-[var(--md-on-surface)]">
          {parsed.patientLine}
        </div>
      )}

      {/* FiO2 badge */}
      {parsed.fiO2 && (
        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)] border border-[var(--md-outline-variant)]">
          FiO₂ {parsed.fiO2}
        </span>
      )}

      {/* ABG values */}
      {parsed.abgValues.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--md-on-surface-variant)] font-semibold">
            ABG
          </div>
          {parsed.abgValues.map((v) => (
            <ValueRow
              key={v.label}
              parsed={v}
              rangeKey={getRangeKey(v.label)}
              showRanges={showRanges}
            />
          ))}
        </div>
      )}

      {/* Electrolytes */}
      {parsed.electrolytes.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-[var(--md-on-surface-variant)] font-semibold">
            Electrolytes
          </div>
          {parsed.electrolytes.map((v) => (
            <ValueRow
              key={v.label}
              parsed={v}
              rangeKey={getRangeKey(v.label)}
              showRanges={showRanges}
            />
          ))}
        </div>
      )}

      {/* Other clinical info */}
      {parsed.otherLines.length > 0 && (
        <div className="text-xs text-[var(--md-on-surface-variant)] space-y-0.5">
          {parsed.otherLines.map((line, i) => (
            <div key={i}><InlineMarkdown text={line} /></div>
          ))}
        </div>
      )}

      {/* Show ranges toggle */}
      <button
        onClick={() => setShowRanges(!showRanges)}
        className="text-[10px] text-[var(--md-tertiary)] hover:text-[var(--md-on-tertiary-container)] transition-colors"
      >
        {showRanges ? 'Hide ranges' : 'Show ranges'}
      </button>
    </div>
  );
}
