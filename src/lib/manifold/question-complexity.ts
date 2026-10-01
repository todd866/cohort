export type CognitiveTask =
  | 'diagnosis'
  | 'next-step'
  | 'management'
  | 'mechanism'
  | 'interpretation'
  | 'identification'
  | 'prognosis'
  | 'risk-assessment'
  | 'unknown';

export interface ComplexitySignals {
  hasPatientAge: boolean;
  hasPatientGender: boolean;
  hasPastMedicalHistory: boolean;
  hasMedications: boolean;
  hasLabValues: boolean;
  hasVitalSigns: boolean;
  hasImagingFindings: boolean;
  hasExamFindings: boolean;
  hasTimeCourse: boolean;
  domains: string[];
  isDomainCrossover: boolean;
  taskType: CognitiveTask;
  requiresInterpretation: boolean;
  requiresSynthesis: boolean;
  requiresComparison: boolean;
  stemWordCount: number;
  optionCount: number;
  avgOptionLength: number;
  hasNegation: boolean;
}

export interface ComplexityProfile {
  vignetteComplexity: number;
  domainIntegration: number;
  cognitiveLoad: number;
  informationDensity: number;
  distractorPlausibility: number;
  overallComplexity: number;
  signals: ComplexitySignals;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function taskForStem(stem: string): CognitiveTask {
  if (/next (?:best )?step|most appropriate (?:next|initial)/i.test(stem)) return 'next-step';
  if (/management|treatment|therapy/i.test(stem)) return 'management';
  if (/mechanism|pathophysiology/i.test(stem)) return 'mechanism';
  if (/diagnosis|most likely condition/i.test(stem)) return 'diagnosis';
  if (/interpret|suggests|indicates/i.test(stem)) return 'interpretation';
  if (/prognosis|outcome/i.test(stem)) return 'prognosis';
  if (/risk factor|risk of/i.test(stem)) return 'risk-assessment';
  if (/which (?:finding|feature|parameter)/i.test(stem)) return 'identification';
  return 'unknown';
}

export function extractSignals(
  stem: string,
  options: Array<{ text: string; label?: string }>,
): ComplexitySignals {
  const optionLengths = options.map((option) => option.text.trim().split(/\s+/).filter(Boolean).length);
  const taskType = taskForStem(stem);
  return {
    hasPatientAge: /\b\d{1,3}[- ]year[- ]old\b/i.test(stem),
    hasPatientGender: /\b(?:male|female|man|woman|boy|girl)\b/i.test(stem),
    hasPastMedicalHistory: /\b(?:history of|known|diagnosed with)\b/i.test(stem),
    hasMedications: /\b(?:taking|prescribed|medication|drug|therapy)\b/i.test(stem),
    hasLabValues: /\b\d+(?:\.\d+)?\s*(?:mg|g|mmol|mEq|IU|U|mL|L)\b/i.test(stem),
    hasVitalSigns: /\b(?:BP|HR|RR|SpO2|temperature|pulse|blood pressure)\b/i.test(stem),
    hasImagingFindings: /\b(?:CT|MRI|X-ray|ultrasound|imaging|CXR|ECG)\b/i.test(stem),
    hasExamFindings: /\b(?:examination|on exam|inspection|palpation|auscultation)\b/i.test(stem),
    hasTimeCourse: /\b\d+\s*(?:hour|day|week|month|year)s?\b/i.test(stem),
    domains: [],
    isDomainCrossover: false,
    taskType,
    requiresInterpretation: /interpret|suggest|indicat|imply/i.test(stem),
    requiresSynthesis: /integrat|combin|together/i.test(stem),
    requiresComparison: /rather than|versus|compare|differentiat/i.test(stem),
    stemWordCount: stem.trim().split(/\s+/).filter(Boolean).length,
    optionCount: options.length,
    avgOptionLength: optionLengths.length
      ? optionLengths.reduce((sum, length) => sum + length, 0) / optionLengths.length
      : 0,
    hasNegation: /\b(?:NOT|EXCEPT|LEAST|INCORRECT|FALSE|UNLIKELY)\b/.test(stem),
  };
}

export function analyzeComplexity(
  stem: string,
  options: Array<{ text: string; label?: string }>,
): ComplexityProfile {
  const signals = extractSignals(stem, options);
  const vignetteFeatures = [
    signals.hasPatientAge,
    signals.hasPatientGender,
    signals.hasPastMedicalHistory,
    signals.hasMedications,
    signals.hasLabValues,
    signals.hasVitalSigns,
    signals.hasImagingFindings,
    signals.hasExamFindings,
    signals.hasTimeCourse,
  ].filter(Boolean).length;
  const vignetteComplexity = clamp(0.1 + vignetteFeatures / 10);
  const domainIntegration = signals.isDomainCrossover ? 0.6 : 0.3;
  const cognitiveLoad = clamp(
    0.35
      + (signals.requiresInterpretation ? 0.15 : 0)
      + (signals.requiresSynthesis ? 0.2 : 0)
      + (signals.requiresComparison ? 0.1 : 0),
  );
  const informationDensity = clamp(0.15 + vignetteFeatures * 0.08);
  const distractorPlausibility = clamp(options.length / 5 * 0.7 + signals.avgOptionLength / 50);
  const overallComplexity = clamp(
    vignetteComplexity * 0.2
      + domainIntegration * 0.2
      + cognitiveLoad * 0.3
      + informationDensity * 0.15
      + distractorPlausibility * 0.15,
  );
  return {
    vignetteComplexity,
    domainIntegration,
    cognitiveLoad,
    informationDensity,
    distractorPlausibility,
    overallComplexity,
    signals,
  };
}

export function complexityToTier(complexity: number): 'easy' | 'medium' | 'hard' {
  if (complexity < 0.35) return 'easy';
  if (complexity < 0.65) return 'medium';
  return 'hard';
}

type CalibrationReference = {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  percentiles: { p25: number; p50: number; p75: number };
  tierDistribution: { easy: number; medium: number; hard: number };
};

export function getExamCalibrationReference(): CalibrationReference {
  return {
    mean: 0.5,
    stdDev: 0.15,
    min: 0,
    max: 1,
    percentiles: { p25: 0.35, p50: 0.5, p75: 0.65 },
    tierDistribution: { easy: 0.25, medium: 0.5, hard: 0.25 },
  };
}

export function getUSMLECalibrationReference(_step: 1 | 2 = 1): {
  mean: number;
  stdDev: number;
  percentiles: { p25: number; p50: number; p75: number };
  tierDistribution: { easy: number; medium: number; hard: number };
  characteristics: { avgStemLength: string; dominantTaskTypes: string[]; optionCount: number };
} {
  void _step;
  const reference = getExamCalibrationReference();
  return {
    mean: reference.mean,
    stdDev: reference.stdDev,
    percentiles: reference.percentiles,
    tierDistribution: reference.tierDistribution,
    characteristics: {
      avgStemLength: 'not calibrated',
      dominantTaskTypes: [],
      optionCount: 5,
    },
  };
}

export function compareToExamLevel(complexity: number): {
  percentile: number;
  isExamLevel: boolean;
  adjustment: string;
  description: string;
} {
  const reference = getExamCalibrationReference();
  const percentile = clamp((complexity - reference.min) / (reference.max - reference.min)) * 100;
  const isExamLevel = complexity >= reference.percentiles.p25
    && complexity <= reference.percentiles.p75;
  if (complexity < reference.percentiles.p25) {
    return {
      percentile,
      isExamLevel,
      adjustment: 'increase-complexity',
      description: 'Below the uncalibrated reference range',
    };
  }
  if (complexity > reference.percentiles.p75) {
    return {
      percentile,
      isExamLevel,
      adjustment: 'decrease-complexity',
      description: 'Above the uncalibrated reference range',
    };
  }
  return { percentile, isExamLevel, adjustment: 'appropriate', description: 'Within the uncalibrated reference range' };
}

export function getDomainComplexityBaseline(_domain: string): number {
  void _domain;
  return 0.5;
}

export function suggestComplexityAdjustments(profile: ComplexityProfile): string[] {
  if (profile.overallComplexity < 0.35) return ['Add relevant context or reasoning steps'];
  if (profile.overallComplexity > 0.65) return ['Remove nonessential details'];
  return [];
}
