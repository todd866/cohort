/**
 * Who may use the ECG/CXR/ABG interpretation picker (/clinical/interpret).
 * Its images are mostly publisher and Anki material, so it sits behind the
 * copyright image tier until an open-licensed set covers it; decided
 * 2026-09-24. Pure and client-safe: the nav, the Clinical gate, the page and
 * the focused-session API all ask this one question.
 */
export interface InterpretViewer {
  id?: string | null;
  isAdmin?: boolean;
  imageTier?: 'standard' | 'copyright' | string | null;
}

/**
 * Held back from learners until the cases are rebuilt: on 2026-09-24 the set
 * was too thin to put in front of anyone (38 ECG, 10 CXR, 8 ABG, one per
 * diagnosis) and some tracings did not show what their case taught. Flip this
 * when the rebuilt set is reviewed; admins can use it meanwhile.
 */
export const INTERPRET_RELEASED = false;

export function canUseInterpret(
  user: InterpretViewer | null | undefined,
  released: boolean = INTERPRET_RELEASED,
): boolean {
  if (!user?.id) return false;
  if (user.isAdmin === true) return true;
  return released && user.imageTier === 'copyright';
}
