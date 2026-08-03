/**
 * Transport-only contract shared by the MD3 Step 1 server and its clients.
 *
 * This module deliberately contains no database fields, canonical option map,
 * correctness flag before grading, or framework dependency. Cohort may consume
 * this contract later without copying MD3's scheduler or persistence model.
 */
export type Step1SessionMode = 'baseline' | 'daily';

export interface Step1PublicAttribution {
  text: string;
  licence: string;
}

export interface Step1ResolvedCitation {
  kind: 'reference' | 'passage';
  title: string;
  publisher: string;
  canonicalUrl: string;
  attribution: string;
  licence: { id: string; url: string };
  passageLocator: string | null;
  quote?: string;
}

export interface Step1SessionItem {
  deliveryId: string;
  stem: string;
  options: Array<{ label: string; text: string }>;
  domain: string;
  difficulty: string;
  questionType: string;
  attribution: Step1PublicAttribution;
}

export interface Step1SessionResult {
  sessionId: string;
  mode: Step1SessionMode;
  requestedSize: number;
  deliveredSize: number;
  items: Step1SessionItem[];
}

export interface Step1AnswerReveal {
  deliveryId: string;
  questionId: string;
  selectedDisplayLabel: string | null;
  correctDisplayLabel: string;
  isCorrect: boolean;
  attemptNumber: number;
  explanation: string | null;
  optionExplanations: Array<{
    label: string;
    explanation: string | null;
    misconception: string | null;
  }>;
  attribution: Step1PublicAttribution;
  citation: Step1ResolvedCitation | null;
}

export interface Step1AnswerResponse {
  deduped: boolean;
  answer: Step1AnswerReveal;
}

export interface Step1Progress {
  corpus: { eligible: number };
  baseline: {
    total: number;
    attempted: number;
    correct: number;
    remaining: number;
    complete: boolean;
  };
  coverage: { attempted: number; unseen: number };
  activity: {
    totalAttempts: number;
    correctAttempts: number;
    todayAttempts: number;
    recent7dAttempts: number;
  };
  domains: Array<{
    domain: string;
    eligible: number;
    attempted: number;
    correct: number;
    unseen: number;
  }>;
  dailyTarget: number;
  nextAction: 'baseline' | 'daily' | 'done-for-today';
  limitations: string[];
}
