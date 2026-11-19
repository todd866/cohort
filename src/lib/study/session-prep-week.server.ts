/** Public build has no private learner preparation requests. */
export async function sessionPrepWeek(_userId: string, _rotation: string, _now: Date): Promise<number | null> { return null; }
export async function presentationPrepReoffer(_userId: string, _rotation: string, _now: Date): Promise<import('./presentation-prep-reoffer').PresentationPrepReoffer | null> { return null; }
