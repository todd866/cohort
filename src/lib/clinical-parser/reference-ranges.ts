/**
 * Reference Ranges for Labs and Vitals
 *
 * Used to flag abnormal values in the clinical cockpit.
 * Ranges are approximate - for educational display, not clinical decision-making.
 */

import type { ReferenceRanges, Flag } from './types';

export const LAB_RANGES: ReferenceRanges = {
  // Metabolic
  lactate: { low: 0.5, high: 2.0, unit: 'mmol/L', criticalHigh: 4.0 },
  glucose: { low: 3.5, high: 7.8, unit: 'mmol/L', criticalLow: 2.5, criticalHigh: 20 },
  sodium: { low: 135, high: 145, unit: 'mmol/L', criticalLow: 120, criticalHigh: 160 },
  potassium: { low: 3.5, high: 5.0, unit: 'mmol/L', criticalLow: 2.5, criticalHigh: 6.5 },
  chloride: { low: 98, high: 106, unit: 'mmol/L' },
  bicarbonate: { low: 22, high: 28, unit: 'mmol/L', criticalLow: 10 },
  urea: { low: 2.5, high: 7.0, unit: 'mmol/L' },
  creatinine: { low: 60, high: 110, unit: 'μmol/L' }, // Adult
  egfr: { low: 90, high: 120, unit: 'mL/min/1.73m²' },

  // Haematology
  haemoglobin: { low: 130, high: 170, unit: 'g/L', criticalLow: 70 }, // Male
  wbc: { low: 4.0, high: 11.0, unit: '×10⁹/L', criticalLow: 0.5, criticalHigh: 30 },
  neutrophils: { low: 2.0, high: 7.5, unit: '×10⁹/L', criticalLow: 0.5 },
  platelets: { low: 150, high: 400, unit: '×10⁹/L', criticalLow: 20, criticalHigh: 1000 },
  inr: { low: 0.9, high: 1.1, unit: '', criticalHigh: 5.0 },
  aptt: { low: 25, high: 35, unit: 's' },

  // Liver
  bilirubin: { low: 0, high: 20, unit: 'μmol/L', criticalHigh: 100 },
  alt: { low: 0, high: 40, unit: 'U/L' },
  ast: { low: 0, high: 40, unit: 'U/L' },
  alp: { low: 30, high: 120, unit: 'U/L' },
  ggt: { low: 0, high: 60, unit: 'U/L' },
  albumin: { low: 35, high: 50, unit: 'g/L', criticalLow: 20 },

  // Cardiac
  troponin: { low: 0, high: 14, unit: 'ng/L', criticalHigh: 100 }, // hs-TnI
  bnp: { low: 0, high: 100, unit: 'pg/mL' },

  // Inflammatory
  crp: { low: 0, high: 5, unit: 'mg/L' },
  procalcitonin: { low: 0, high: 0.1, unit: 'ng/mL', criticalHigh: 2.0 },

  // Blood gas
  ph: { low: 7.35, high: 7.45, unit: '', criticalLow: 7.1, criticalHigh: 7.6 },
  pao2: { low: 80, high: 100, unit: 'mmHg', criticalLow: 60 },
  paco2: { low: 35, high: 45, unit: 'mmHg' },
  baseExcess: { low: -2, high: 2, unit: 'mmol/L' },
};

export const VITAL_RANGES: ReferenceRanges = {
  hr: { low: 60, high: 100, unit: 'bpm', criticalLow: 40, criticalHigh: 150 },
  sbp: { low: 90, high: 140, unit: 'mmHg', criticalLow: 70, criticalHigh: 180 },
  dbp: { low: 60, high: 90, unit: 'mmHg', criticalLow: 40, criticalHigh: 110 },
  temp: { low: 36.1, high: 37.2, unit: '°C', criticalLow: 35, criticalHigh: 40 },
  rr: { low: 12, high: 20, unit: '/min', criticalLow: 8, criticalHigh: 30 },
  spo2: { low: 94, high: 100, unit: '%', criticalLow: 88 },
  gcs: { low: 15, high: 15, unit: '', criticalLow: 8 },
};

/**
 * Determine the flag for a value given its reference range
 */
export function flagValue(value: number, range: ReferenceRanges[string]): Flag {
  if (range.criticalLow !== undefined && value <= range.criticalLow) return 'critical-low';
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) return 'critical-high';
  if (value < range.low) return 'low';
  if (value > range.high) return 'high';
  return 'normal';
}

/**
 * Get severity from flag (for display purposes)
 */
export function flagToSeverity(flag: Flag): 'normal' | 'abnormal' | 'critical' {
  if (flag === 'normal') return 'normal';
  if (flag === 'critical-low' || flag === 'critical-high') return 'critical';
  return 'abnormal';
}

/**
 * Aliases for common lab names (maps variations to canonical names)
 */
export const LAB_ALIASES: Record<string, string> = {
  // Lactate
  'lactic acid': 'lactate',
  'serum lactate': 'lactate',

  // Glucose
  'blood glucose': 'glucose',
  'bgl': 'glucose',
  'bsl': 'glucose',

  // Renal
  'cr': 'creatinine',
  'cre': 'creatinine',
  'serum creatinine': 'creatinine',

  // WBC
  'white cell count': 'wbc',
  'white blood cell': 'wbc',
  'white cells': 'wbc',
  'leukocytes': 'wbc',

  // Neutrophils
  'anc': 'neutrophils',
  'absolute neutrophil count': 'neutrophils',

  // Haemoglobin
  'hb': 'haemoglobin',
  'hemoglobin': 'haemoglobin',
  'hgb': 'haemoglobin',

  // Platelets
  'plt': 'platelets',
  'platelet count': 'platelets',

  // Troponin
  'trop': 'troponin',
  'hs-tni': 'troponin',
  'hstni': 'troponin',
  'hs-tnt': 'troponin',

  // Electrolytes
  'na': 'sodium',
  'k': 'potassium',
  'cl': 'chloride',
  'hco3': 'bicarbonate',
  'bicarb': 'bicarbonate',

  // Liver
  'bili': 'bilirubin',
  'total bilirubin': 'bilirubin',
};
