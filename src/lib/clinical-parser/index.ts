/**
 * Clinical Parser
 *
 * Parses question stems to extract structured clinical data for visual display.
 * Also flags quality issues for content audits.
 */

import type {
  ParsedScenario,
  Demographics,
  Vitals,
  LabValue,
  TimelineEvent,
  ParseIssue,
  Sex,
  Flag,
} from './types';

import {
  DEMOGRAPHICS_PATTERNS,
  VITAL_PATTERNS,
  LAB_PATTERNS,
  MALFORMED_PATTERNS,
  TIMELINE_PATTERNS,
  CONTEXT_PATTERNS,
  SYMPTOM_PATTERNS,
  CLINICAL_INDICATORS,
  QUESTION_PATTERNS,
} from './patterns';

import {
  LAB_RANGES,
  VITAL_RANGES,
  flagValue,
} from './reference-ranges';

/**
 * Main parse function - extracts structured clinical data from a question stem
 */
export function parseScenario(text: string): ParsedScenario {
  const issues: ParseIssue[] = [];

  // Check for malformed values first
  detectMalformedValues(text, issues);

  // Determine if this is a clinical scenario
  const isClinicalScenario = detectClinicalScenario(text);

  // Extract components
  const demographics = extractDemographics(text);
  const vitals = extractVitals(text, issues);
  const labs = extractLabs(text, issues);
  const symptoms = extractSymptoms(text);
  const context = extractContext(text);
  const timeline = extractTimeline(text);
  const question = extractQuestion(text);

  // Calculate what we successfully parsed vs unparsed
  const { unparsedText, confidence } = calculateCoverage(text, {
    demographics,
    vitals,
    labs,
    symptoms,
    context,
  });

  return {
    demographics,
    vitals,
    labs,
    conditions: [], // Not implemented - future: extract medical conditions via NLP
    medications: [], // Not implemented - future: extract medications via NLP
    symptoms,
    context,
    timeline,
    question,
    unparsedText,
    issues,
    confidence,
    isClinicalScenario,
  };
}

/**
 * Quick check if this is worth parsing as a clinical scenario
 */
function detectClinicalScenario(text: string): boolean {
  // Check for non-clinical indicators first
  if (CLINICAL_INDICATORS.isDefinition.test(text)) return false;
  if (CLINICAL_INDICATORS.isList.test(text)) return false;

  // Count positive indicators
  let score = 0;
  if (CLINICAL_INDICATORS.hasPatient.test(text)) score += 2;
  if (CLINICAL_INDICATORS.hasPresentation.test(text)) score += 1;
  if (CLINICAL_INDICATORS.hasVitals.test(text)) score += 1;
  if (CLINICAL_INDICATORS.hasLabs.test(text)) score += 1;
  if (CLINICAL_INDICATORS.hasClinicalCondition.test(text)) score += 2; // Strong indicator

  // Need at least patient + one other indicator, OR strong clinical condition
  return score >= 3;
}

/**
 * Extract patient demographics
 */
function extractDemographics(text: string): Demographics {
  // Try pediatric pattern FIRST (more specific - months, weeks, days)
  const pediatric = text.match(DEMOGRAPHICS_PATTERNS.pediatricAge);
  if (pediatric) {
    const ageUnit = parseAgeUnit(pediatric[2]);
    return {
      age: parseInt(pediatric[1], 10),
      sex: pediatric[3] ? parseSex(pediatric[3]) : 'unknown',
      ageUnit,
    };
  }

  // Try combined age+sex pattern (captures unit now)
  const combined = text.match(DEMOGRAPHICS_PATTERNS.ageAndSex);
  if (combined) {
    const ageUnit = combined[2] ? parseAgeUnit(combined[2]) : 'years';
    return {
      age: parseInt(combined[1], 10),
      sex: parseSex(combined[3]),
      ageUnit,
    };
  }

  // Try separate patterns
  const ageMatch = text.match(DEMOGRAPHICS_PATTERNS.ageOnly);
  const sexMatch = text.match(DEMOGRAPHICS_PATTERNS.sexOnly);

  const ageUnit = ageMatch?.[2] ? parseAgeUnit(ageMatch[2]) : 'years';

  return {
    age: ageMatch ? parseInt(ageMatch[1], 10) : null,
    sex: sexMatch ? parseSex(sexMatch[1]) : 'unknown',
    ageUnit,
  };
}

function parseSex(s: string): Sex {
  const lower = s.toLowerCase();
  if (['male', 'man', 'boy', 'm'].includes(lower)) return 'M';
  if (['female', 'woman', 'girl', 'f'].includes(lower)) return 'F';
  return 'unknown';
}

function parseAgeUnit(unit: string): 'years' | 'months' | 'weeks' | 'days' {
  const lower = unit.toLowerCase();
  if (lower.startsWith('month') || lower === 'mo') return 'months';
  if (lower.startsWith('week') || lower === 'wk') return 'weeks';
  if (lower.startsWith('day') || lower === 'd') return 'days';
  return 'years';
}

/**
 * Extract vital signs
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function extractVitals(text: string, _issues: ParseIssue[]): Vitals {
  const vitals: Vitals = {};

  // Heart rate
  const hrMatch = text.match(VITAL_PATTERNS.hr);
  const hrQual = text.match(VITAL_PATTERNS.hrQualitative);
  if (hrMatch || hrQual) {
    const value = hrMatch ? parseInt(hrMatch[1], 10) : null;
    vitals.hr = {
      name: 'Heart Rate',
      value,
      unit: 'bpm',
      flag: value !== null ? flagValue(value, VITAL_RANGES.hr) : 'normal',
      qualitative: hrQual?.[1],
    };
  }

  // Blood pressure
  const bpMatch = text.match(VITAL_PATTERNS.bp);
  const bpQual = text.match(VITAL_PATTERNS.bpQualitative);
  if (bpMatch || bpQual) {
    const systolic = bpMatch ? parseInt(bpMatch[1], 10) : null;
    const diastolic = bpMatch ? parseInt(bpMatch[2], 10) : null;
    const flag: Flag = systolic !== null
      ? flagValue(systolic, VITAL_RANGES.sbp)
      : (bpQual?.[1]?.toLowerCase() === 'hypotensive' ? 'low' : 'normal');
    vitals.bp = {
      systolic,
      diastolic,
      flag,
      qualitative: bpQual?.[1],
    };
  }

  // Temperature
  const tempMatch = text.match(VITAL_PATTERNS.temp);
  const tempQual = text.match(VITAL_PATTERNS.tempQualitative);
  if (tempMatch || tempQual) {
    const value = tempMatch ? parseFloat(tempMatch[1]) : null;
    vitals.temp = {
      name: 'Temperature',
      value,
      unit: '°C',
      flag: value !== null ? flagValue(value, VITAL_RANGES.temp) : 'normal',
      qualitative: tempQual?.[1],
    };
  }

  // Respiratory rate
  const rrMatch = text.match(VITAL_PATTERNS.rr);
  const rrQual = text.match(VITAL_PATTERNS.rrQualitative);
  if (rrMatch || rrQual) {
    const value = rrMatch ? parseInt(rrMatch[1], 10) : null;
    vitals.rr = {
      name: 'Respiratory Rate',
      value,
      unit: '/min',
      flag: value !== null ? flagValue(value, VITAL_RANGES.rr) : 'normal',
      qualitative: rrQual?.[1],
    };
  }

  // SpO2
  const spo2Match = text.match(VITAL_PATTERNS.spo2);
  const spo2Qual = text.match(VITAL_PATTERNS.spo2Qualitative);
  if (spo2Match || spo2Qual) {
    const value = spo2Match ? parseInt(spo2Match[1], 10) : null;
    vitals.spo2 = {
      name: 'SpO2',
      value,
      unit: '%',
      flag: value !== null ? flagValue(value, VITAL_RANGES.spo2) : 'normal',
      qualitative: spo2Qual?.[1],
    };
  }

  // GCS
  const gcsMatch = text.match(VITAL_PATTERNS.gcs);
  const gcsQual = text.match(VITAL_PATTERNS.gcsQualitative);
  if (gcsMatch || gcsQual) {
    const value = gcsMatch ? parseInt(gcsMatch[1], 10) : null;
    vitals.gcs = {
      name: 'GCS',
      value,
      unit: '',
      flag: value !== null ? flagValue(value, VITAL_RANGES.gcs) : 'normal',
      qualitative: gcsQual?.[1],
    };
  }

  return vitals;
}

/**
 * Extract lab values
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function extractLabs(text: string, _issues: ParseIssue[]): LabValue[] {
  const labs: LabValue[] = [];

  // Process each lab pattern
  const labPatterns: Array<{ key: string; pattern: RegExp; name: string }> = [
    { key: 'lactate', pattern: LAB_PATTERNS.lactate, name: 'Lactate' },
    { key: 'glucose', pattern: LAB_PATTERNS.glucose, name: 'Glucose' },
    { key: 'sodium', pattern: LAB_PATTERNS.sodium, name: 'Sodium' },
    { key: 'potassium', pattern: LAB_PATTERNS.potassium, name: 'Potassium' },
    { key: 'creatinine', pattern: LAB_PATTERNS.creatinine, name: 'Creatinine' },
    { key: 'urea', pattern: LAB_PATTERNS.urea, name: 'Urea' },
    { key: 'egfr', pattern: LAB_PATTERNS.egfr, name: 'eGFR' },
    { key: 'haemoglobin', pattern: LAB_PATTERNS.haemoglobin, name: 'Haemoglobin' },
    { key: 'wbc', pattern: LAB_PATTERNS.wbc, name: 'WBC' },
    { key: 'platelets', pattern: LAB_PATTERNS.platelets, name: 'Platelets' },
    { key: 'neutrophils', pattern: LAB_PATTERNS.neutrophils, name: 'Neutrophils' },
    { key: 'inr', pattern: LAB_PATTERNS.inr, name: 'INR' },
    { key: 'aptt', pattern: LAB_PATTERNS.aptt, name: 'APTT' },
    { key: 'bilirubin', pattern: LAB_PATTERNS.bilirubin, name: 'Bilirubin' },
    { key: 'alt', pattern: LAB_PATTERNS.alt, name: 'ALT' },
    { key: 'ast', pattern: LAB_PATTERNS.ast, name: 'AST' },
    { key: 'alp', pattern: LAB_PATTERNS.alp, name: 'ALP' },
    { key: 'ggt', pattern: LAB_PATTERNS.ggt, name: 'GGT' },
    { key: 'albumin', pattern: LAB_PATTERNS.albumin, name: 'Albumin' },
    { key: 'troponin', pattern: LAB_PATTERNS.troponin, name: 'Troponin' },
    { key: 'bnp', pattern: LAB_PATTERNS.bnp, name: 'BNP' },
    { key: 'crp', pattern: LAB_PATTERNS.crp, name: 'CRP' },
    { key: 'procalcitonin', pattern: LAB_PATTERNS.procalcitonin, name: 'Procalcitonin' },
    { key: 'ph', pattern: LAB_PATTERNS.ph, name: 'pH' },
    { key: 'pao2', pattern: LAB_PATTERNS.pao2, name: 'PaO2' },
    { key: 'paco2', pattern: LAB_PATTERNS.paco2, name: 'PaCO2' },
    { key: 'baseExcess', pattern: LAB_PATTERNS.baseExcess, name: 'Base Excess' },
  ];

  for (const { key, pattern, name } of labPatterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      const range = LAB_RANGES[key];

      if (range) {
        labs.push({
          name,
          value: isNaN(value) ? null : value,
          unit: range.unit,
          flag: isNaN(value) ? 'normal' : flagValue(value, range),
          referenceRange: { low: range.low, high: range.high },
        });
      }
    }
  }

  return labs;
}

/**
 * Extract symptoms/signs
 */
function extractSymptoms(text: string): string[] {
  const symptoms: string[] = [];

  for (const { pattern, name } of SYMPTOM_PATTERNS) {
    if (pattern.test(text)) {
      symptoms.push(name);
    }
  }

  return symptoms;
}

/**
 * Extract context (setting, treatment context)
 */
function extractContext(text: string): string[] {
  const context: string[] = [];

  if (CONTEXT_PATTERNS.icu.test(text)) context.push('ICU');
  else if (CONTEXT_PATTERNS.ed.test(text)) context.push('ED');
  else if (CONTEXT_PATTERNS.inpatient.test(text)) context.push('Inpatient');
  else if (CONTEXT_PATTERNS.outpatient.test(text)) context.push('Outpatient');

  if (CONTEXT_PATTERNS.chemo.test(text)) context.push('Chemotherapy');
  if (CONTEXT_PATTERNS.postSurgery.test(text)) context.push('Post-operative');
  if (CONTEXT_PATTERNS.immunocompromised.test(text)) context.push('Immunocompromised');

  return context;
}

/**
 * Extract timeline events
 */
function extractTimeline(text: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Hospital days
  let match;
  const hdPattern = new RegExp(TIMELINE_PATTERNS.hospitalDay.source, 'gi');
  while ((match = hdPattern.exec(text)) !== null) {
    const day = match[1] || match[2];
    events.push({
      time: `Day ${day}`,
      events: [], // Would need more context to fill
    });
  }

  // Duration ago
  const agoPattern = new RegExp(TIMELINE_PATTERNS.durationAgo.source, 'gi');
  while ((match = agoPattern.exec(text)) !== null) {
    events.push({
      time: `${match[1]} ${match[2]}${parseInt(match[1]) > 1 ? 's' : ''} ago`,
      events: [],
    });
  }

  return events;
}

/**
 * Extract the actual question from stem
 */
function extractQuestion(text: string): string | null {
  const match = text.match(QUESTION_PATTERNS.questionStart);
  if (match) {
    // Get from match to end of text
    const startIndex = match.index!;
    return text.slice(startIndex).trim();
  }
  return null;
}

/**
 * Detect malformed values (for content quality flagging)
 */
function detectMalformedValues(text: string, issues: ParseIssue[]): void {
  // Check for unit without value
  let match;
  while ((match = MALFORMED_PATTERNS.unitWithoutValue.exec(text)) !== null) {
    issues.push({
      type: 'missing-value',
      field: match[1].toLowerCase(),
      message: `Found "${match[1]}" with unit "${match[2]}" but no numeric value`,
      rawText: match[0],
    });
  }

  // Check for placeholders
  const placeholders = text.match(MALFORMED_PATTERNS.placeholder);
  if (placeholders) {
    for (const ph of placeholders) {
      issues.push({
        type: 'malformed',
        field: 'unknown',
        message: `Found placeholder "${ph}" - value not specified`,
        rawText: ph,
      });
    }
  }
}

/**
 * Calculate parsing coverage
 */
function calculateCoverage(
  text: string,
  extracted: {
    demographics: Demographics;
    vitals: Vitals;
    labs: LabValue[];
    symptoms: string[];
    context: string[];
  }
): { unparsedText: string; confidence: number } {
  // This is a simplified version - real implementation would track
  // which parts of the text were matched and what remains

  let extractedCount = 0;
  const possibleCount = 4; // demographics, vitals, labs, symptoms/context

  if (extracted.demographics.age !== null) extractedCount++;
  if (Object.keys(extracted.vitals).length > 0) extractedCount++;
  if (extracted.labs.length > 0) extractedCount++;
  if (extracted.symptoms.length > 0 || extracted.context.length > 0) extractedCount++;

  const confidence = extractedCount / possibleCount;

  // For now, return original text as unparsed
  // Future: actually track matched regions and return remainder
  return {
    unparsedText: text,
    confidence,
  };
}

// Re-export types and utilities
export * from './types';
export { flagValue, flagToSeverity, LAB_RANGES, VITAL_RANGES, LAB_ALIASES } from './reference-ranges';
