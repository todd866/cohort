import type { PrepBlendPlan } from './session-prep-blend';
/** Public builds have no personal timetable preparation. */
export async function refreshOwnerSessionPrepBlend(_userId: string, _rotation: string, _now = new Date()): Promise<PrepBlendPlan | null> { return null; }
