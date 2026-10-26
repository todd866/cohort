/**
 * A clinical station: one skill (examine, take a history, assess, do a
 * procedure, interpret a result), authored once as data and rendered as a
 * deck. Every line is what you DO and, where there is one, the exact thing you
 * SAY. Spec: docs/superpowers/specs/2026-09-24-clinical-stations-design.md.
 */
export type StationKind = 'examine' | 'history' | 'assess' | 'procedure' | 'interpret';
export type Population = 'adult' | 'paediatric';
export const STATION_KINDS: readonly StationKind[] = ['examine', 'history', 'assess', 'procedure', 'interpret'];
export const POPULATIONS: readonly Population[] = ['adult', 'paediatric'];
export const STATION_AUDIENCES = ['cah', 'pwh', 'md1'] as const;
export type StationAudience = (typeof STATION_AUDIENCES)[number];

export interface LineMore { body: string; sourceIds: string[] }
export interface Line {
  id: string;
  do: string;
  say?: string;
  to?: 'patient' | 'examiner';
  /** Examiner-marked or commonly missed. */
  marked?: boolean;
  /** Review topics this line depends on; a practice miss brings them forward. */
  topics?: string[];
  more?: LineMore;
}
export interface Phase { name: string; lines: Line[]; takeaway: string }
export interface StationSource { id: string; title: string; url?: string; private?: boolean }
export interface Station {
  id: string;
  kind: StationKind;
  population: Population[];
  title: string;
  task: string;
  minutes: number;
  /** Unscored guidance displayed in Practice, separate from recall content. */
  practiceInstructions?: { markingRule: string; completionReminder: string };
  phases: Phase[];
  /** Examiner-chosen branches, e.g. respiratory / cardiovascular / abdominal. */
  tracks?: Record<string, Phase[]>;
  close: Line[];
  present?: string;
  redFlags?: string[];
  viva?: { q: string; a: string }[];
  review: { rotation: string; topics: string[] };
  sources: StationSource[];
  /**
   * Who may open it beyond the owner/allowlist. A rotation id ('cah', 'pwh')
   * = a USyd learner whose current rotation it is (clinical-audience.ts);
   * 'md1' = a learner enrolled in the MD1 KAT4 + MMCA deck.
   */
  audiences?: StationAudience[];
}
