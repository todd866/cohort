import { GOAL_CHOICES, parseCheckIns, type GoalChoice } from '@/lib/check-ins/policy';

/** A case is evidence for a question, never a saved personality classification. */
export const HAT_CASES = [
  { id:'scan', label:'An unexpected scan', goal:'imaging', guess:'Hmm. “Just one more slice,” is it? More imaging?', again:'The pictures win again, perhaps? More imaging?' },
  { id:'brain', label:'A puzzling brain scan', goal:'neuroimaging', guess:'Following the plot through the brain? More neuroimaging?', again:'Back to the brain. The hat sees a theme. More neuroimaging?' },
  { id:'operation', label:'A difficult operation', goal:'surgery', guess:'The theatre doors open. Tempted to stay? More surgery?', again:'The theatre doors have caught your eye again. More surgery?' },
  { id:'child', label:"A child's puzzling illness", goal:'cah', guess:'A small patient, a big puzzle. More child health?', again:'Another small patient, another big puzzle. More child health?' },
  { id:'story', label:'A change in mood or perception', goal:'paam', guess:'There’s more to this story than the first impression. More psychiatry?', again:'Back for the story behind the symptoms. More psychiatry?' },
  { id:'critical', label:'A critical moment', goal:'critical-care', guess:'The monitor beeps. The plot thickens. More critical care?', again:'Another beep, another plot twist. More critical care?' },
  { id:'pregnancy', label:'A pregnancy taking an unexpected turn', goal:'pwh', guess:'An unexpected turn has your attention. More pregnancy and women’s health?', again:'Back for another unexpected turn. More pregnancy and women’s health?' },
  { id:'bedside', label:'A subtle bedside sign', goal:'physical-exam', guess:'The clue was there all along. More bedside signs?', again:'Back for the clues hiding in plain sight. More bedside signs?' },
  { id:'neurosurgery', label:'A decision in neurosurgery', goal:'neurosurg', guess:'A tiny space, a big decision. More neurosurgery?', again:'Another tiny space, another big decision. More neurosurgery?' },
  { id:'exam', label:'An exam question that almost fooled me', goal:'exam', guess:'A tempting wrong answer. Fancy a rematch? More exam questions?', again:'Another rematch? The hat remembers. More exam questions?' },
  { id:'explore', label:'Surprise me', goal:'explore', guess:'A little of everything? The hat also struggles to pick just one.', again:'Still keeping every door open? A broad mix it is, perhaps.' },
] as const satisfies readonly {id:string;label:string;goal:GoalChoice;guess:string;again:string}[];

export interface ConfirmedHatInterest { choice: GoalChoice; label: string }
export interface SortingHatState { confirmed: ConfirmedHatInterest | null; claimId: string | null }
export function sortHatChoice(caseId: unknown, previousChoice?: GoalChoice) {
  const scenario = HAT_CASES.find(choice => choice.id === caseId);
  if (!scenario) return null;
  const goal = GOAL_CHOICES.find(choice => choice.id === scenario.goal)!;
  const previous = GOAL_CHOICES.find(choice => choice.id === previousChoice);
  return {
    choice: goal.id, label: goal.label,
    guess: previous?.id === goal.id ? scenario.again : previous ? `A plot twist! ${scenario.guess}` : scenario.guess,
    evidence: `You picked “${scenario.label}”.${previous ? ` Your earlier saved pick was ${previous.label}.` : ''}`,
  };
}

/** Existing preferences, including those confirmed in Review, stay editable. */
export function sortingHatState(profile: unknown): SortingHatState {
  const state = parseCheckIns(profile);
  const goal = GOAL_CHOICES.find(choice => choice.id === state.answers['learning-goal']?.choice);
  if (!goal) return {confirmed:null,claimId:null};
  const claim = [...state.shown].reverse().find(item => item.key === 'learning-goal');
  return {confirmed:{choice:goal.id,label:goal.label},claimId:claim?.id ?? null};
}
