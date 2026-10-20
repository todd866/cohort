/** Shared budget for optional profile/context questions, never assessment items. */
export const CHECK_IN_HOUR_MS = 60 * 60 * 1000;
export const CHECK_IN_DAILY_LIMIT = 3;
export const GOAL_CHOICES = [
  { id: 'explore', label: 'Explore broadly' },
  { id: 'cah', label: 'Child health' },
  { id: 'critical-care', label: 'Critical care' },
  { id: 'paam', label: 'Psychiatry & addiction medicine' },
  { id: 'pwh', label: 'Pregnancy & women’s health' },
  { id: 'physical-exam', label: 'Clinical examination' },
  { id: 'neurosurg', label: 'Neurosurgery' },
  { id: 'imaging', label: 'Imaging' },
  { id: 'neuroimaging', label: 'MRI / brain imaging' },
  { id: 'surgery', label: 'Surgery' },
  { id: 'exam', label: 'Exam questions' },
] as const;
export type GoalChoice = typeof GOAL_CHOICES[number]['id'];
export type CheckInKey = 'learning-goal' | 'study-purpose';
export interface CheckInClaim { id: string; key: CheckInKey; at: number; contextKey?: string }
export interface CheckInAnswer { choice: string; text?: string; at: number }
export interface CheckInState {
  shown: CheckInClaim[];
  answers: Partial<Record<CheckInKey, CheckInAnswer>>;
  discoverySkipped?: boolean;
}
export const PURPOSE_CHOICES = [
  { id: 'clinical', label: 'Clinical work' }, { id: 'exam', label: 'An exam' }, { id: 'curiosity', label: 'Curiosity' },
] as const;
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return value; } catch { return null; }
}
export function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
export function parseCheckIns(profile: unknown): CheckInState {
  const state = record(record(profile).checkIns);
  const keys = new Set(['learning-goal', 'study-purpose']);
  const shown = Array.isArray(state.shown) ? state.shown.filter((raw): raw is CheckInClaim => {
    const c = record(raw);
    return typeof c.id === 'string' && keys.has(String(c.key)) && typeof c.at === 'number' && Number.isFinite(c.at);
  }) : [];
  const answers: CheckInState['answers'] = {};
  for (const key of keys) {
    const a = record(record(state.answers)[key]);
    if (typeof a.choice === 'string' && typeof a.at === 'number' && Number.isFinite(a.at)) {
      answers[key as CheckInKey] = { choice: a.choice, at: a.at, ...(typeof a.text === 'string' ? { text: a.text.slice(0,240) } : {}) };
    }
  }
  return { shown, answers, ...(state.discoverySkipped === true ? { discoverySkipped: true } : {}) };
}
export function canShowCheckIn(state: CheckInState, now: number, timeZone: string): boolean {
  if (!Number.isFinite(now) || !validTimeZone(timeZone)) return false;
  if (state.shown.some(c => now - c.at < CHECK_IN_HOUR_MS)) return false;
  const today = localDay(now, timeZone);
  // The rolling cap also prevents a timezone change from buying extra prompts.
  return state.shown.filter(c => localDay(c.at,timeZone) === today).length < CHECK_IN_DAILY_LIMIT
    && state.shown.filter(c => now - c.at < 24 * CHECK_IN_HOUR_MS).length < CHECK_IN_DAILY_LIMIT;
}
export function nextCheckIn(state: CheckInState): CheckInKey | null {
  // Shown-but-unanswered includes dismissal, closed tabs and lost responses.
  // Never nag again merely because the browser reloaded.
  const known = (key: CheckInKey) => Boolean(state.answers[key]) || state.shown.some(c => c.key === key);
  if (!known('learning-goal')) return 'learning-goal';
  if (!known('study-purpose') && state.answers['learning-goal'] && state.answers['learning-goal']?.choice !== 'exam') return 'study-purpose';
  return null;
}
export function checkInQuestion(key: CheckInKey) {
  return key === 'learning-goal'
    ? { key, label: 'What would you like to work on?', choices: GOAL_CHOICES }
    : { key, label: 'What are you learning this for?', choices: PURPOSE_CHOICES };
}
export function validCheckInAnswer(key: CheckInKey, choice: unknown, text: unknown): boolean {
  const choices: readonly {id:string}[] = checkInQuestion(key).choices;
  return typeof choice === 'string' && choices.some(c => c.id === choice)
    && (text === undefined || (typeof text === 'string' && text.length <= 240));
}
export function withCheckIns(profile: unknown, state: CheckInState): Record<string, unknown> {
  return { ...record(profile), checkIns: state };
}

/** Existing saved context and denormalized activity; never scan review history here. */
export interface CheckInContext {
  feedProfile?: unknown;
  activeModules?: readonly string[];
  track?: number | null;
  studyGoal?: number | null;
  curriculumRequestedAt?: Date | null;
  currentStreak?: number;
  longestStreak?: number;
  totalStudyTime?: number;
  rotations?: readonly { rotation: string; examDate: Date }[];
}
const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
function hasSavedContext(context: CheckInContext): boolean {
  const profile = record(context.feedProfile);
  const explicit = record(profile.explicit);
  const pollAnswers = record(record(profile.implicit).pollAnswers);
  return Boolean(context.activeModules?.some(hasText)
    || (context.track != null && context.track > 0)
    || (context.studyGoal != null && context.studyGoal >= 0)
    || context.curriculumRequestedAt
    || (context.currentStreak ?? 0) >= 2 || (context.longestStreak ?? 0) >= 2
    || (context.totalStudyTime ?? 0) > 0
    || context.rotations?.length
    || ['studying', 'year', 'school', 'aiming', 'rotation'].some(key => hasText(explicit[key]))
    || Object.values(pollAnswers).some(hasText));
}

/** A ceiling is not a quota: return null unless something useful is unresolved. */
export function checkInOpportunity(state: CheckInState, context: CheckInContext, now: number, timeZone: string) {
  if (!Number.isFinite(now) || !validTimeZone(timeZone)) return null;
  const today = localDay(now, timeZone);
  const rotations = (context.rotations ?? []).filter(row => Number.isFinite(row.examDate.getTime()));
  // UserRotation exam dates are saved as civil YYYY-MM-DD dates at UTC midnight.
  // Their identity must not shift when a learner changes timezone.
  const examDay = (row: { examDate: Date }) => row.examDate.toISOString().slice(0, 10);
  const hasUpcoming = rotations.some(row => examDay(row) >= today);
  const recent = rotations.filter(row => examDay(row) < today
    && Date.parse(today) - Date.parse(examDay(row)) <= 7 * 24 * CHECK_IN_HOUR_MS)
    .sort((a,b) => b.examDate.getTime() - a.examDate.getTime())[0];
  if (recent && !hasUpcoming && context.track == null) {
    const date = examDay(recent);
    const focus = GOAL_CHOICES.find(choice => choice.id === recent.rotation);
    const contextKey = `exam:${recent.rotation}:${date}`;
    const differentFocus = context.activeModules?.some(module => module !== recent.rotation && !module.startsWith(recent.rotation + '/'));
    const answeredSince = (state.answers['learning-goal']?.at ?? 0) >= recent.examDate.getTime();
    if (focus && !differentFocus && !answeredSince && !state.shown.some(claim => claim.contextKey === contextKey)) {
      return {
        question: { ...checkInQuestion('learning-goal'), label: `Your saved ${focus.label} exam date (${date}) has passed. What should reviews focus on next?` },
        contextKey,
      };
    }
  }
  if (hasSavedContext(context)) return null;
  const key = nextCheckIn(state);
  if (!key) return null;
  const question = checkInQuestion(key);
  if (key === 'study-purpose') {
    const focus = GOAL_CHOICES.find(choice => choice.id === state.answers['learning-goal']?.choice);
    if (!focus || focus.id === 'explore') return null;
    return { question: { ...question, label: `What are you studying ${focus.label} for?` } };
  }
  return { question };
}
