/**
 * Clinical Parser Types
 *
 * Structures for parsing question stems into visual cockpit format.
 */

export type Sex = 'M' | 'F' | 'unknown';
export type Flag = 'normal' | 'low' | 'high' | 'critical-low' | 'critical-high';
export type Severity = 'normal' | 'abnormal' | 'critical';

export interface Demographics {
  age: number | null;
  sex: Sex;
  ageUnit?: 'years' | 'months' | 'weeks' | 'days';
}

export interface VitalSign {
  name: string;
  value: number | null;
  unit: string;
  flag: Flag;
  qualitative?: string; // "hypotensive", "febrile", "tachycardic"
}

export interface Vitals {
  hr?: VitalSign;
  bp?: { systolic: number | null; diastolic: number | null; flag: Flag; qualitative?: string };
  temp?: VitalSign;
  rr?: VitalSign;
  spo2?: VitalSign;
  gcs?: VitalSign;
}

export interface LabValue {
  name: string;
  value: number | null;
  unit: string;
  flag: Flag;
  baseline?: number; // "from a baseline of 1.2"
  referenceRange?: { low: number; high: number };
}

export interface TimelineEvent {
  time: string; // "day 4", "2 weeks ago", "on admission"
  events: string[];
}

export interface ParseIssue {
  type: 'missing-value' | 'malformed' | 'incomplete' | 'ambiguous';
  field: string;
  message: string;
  rawText?: string;
}

export interface ParsedScenario {
  // Extracted data
  demographics: Demographics;
  vitals: Vitals;
  labs: LabValue[];
  conditions: string[];
  medications: string[];
  symptoms: string[];
  context: string[]; // "inpatient", "day 4 chemo", etc.
  timeline: TimelineEvent[];

  // The question itself (extracted from stem)
  question: string | null; // "Which of the following..."

  // Unparsed remainder (for hybrid display)
  unparsedText: string;

  // Quality tracking
  issues: ParseIssue[];
  confidence: number; // 0-1, how much of the stem was successfully parsed

  // Should we show the cockpit or fall back to text?
  isClinicalScenario: boolean;
}

export interface ReferenceRange {
  low: number;
  high: number;
  unit: string;
  criticalLow?: number;
  criticalHigh?: number;
}

export type ReferenceRanges = Record<string, ReferenceRange>;
