'use client';

import { ReviewModulePicker } from '@/components/shared/ReviewModulePicker';
import { rotationLabel } from '@/lib/rotation-labels';
import { orderFocusOptions } from '@/lib/study/focus-option-order';

interface RotationFocusSelectorProps {
  /** Studyable rotation slugs the user is enrolled in. */
  options: string[];
  /** Currently focused rotation, or null for "All" (the blended feed). */
  value: string | null;
  /** Called with a slug to focus, or null to return to "All". */
  onChange: (next: string | null) => void;
  /** Show the picker even when the only saved choice is an opt-in focus deck. */
  forceVisible?: boolean;
  /**
   * When provided, the menu gains a "Change rotation…" entry (and the pill
   * renders even for single-rotation profiles) so switching ENROLMENT is one
   * tap from the review screen — before this, changing stream was buried in
   * the desktop Content page (requested 2026-08-19).
   */
  onChangeRotation?: () => void;
  /**
   * The rotation whose exam is actually booked. It renders ABOVE "All",
   * because "All" is not a peer of it: `evaluateObjectiveCoreGate` withholds
   * cross-source content until the day's work in the exam rotation is done, so
   * a blended session resolves to this rotation anyway until that is cleared.
   * Putting it first says what the menu already does.
   */
  examRotation?: string | null;
  /** Actual objective served when the URL has no explicit focus. */
  defaultRotation?: string | null;
}

export function RotationFocusSelector({options, value, onChange, forceVisible = false, onChangeRotation, examRotation = null, defaultRotation = null}: RotationFocusSelectorProps) {
  if (options.length === 0 || (!forceVisible && !onChangeRotation && options.length <= 1)) return null;
  return <ReviewModulePicker options={orderFocusOptions(options).map(id => ({id, label: rotationLabel(id)}))} value={value} onChange={onChange} preferredId={examRotation} defaultLabel={defaultRotation ? `Default (${rotationLabel(defaultRotation)})` : 'All'} triggerDefaultLabel={defaultRotation ? rotationLabel(defaultRotation) : 'All'} ariaPrefix="Focus rotation" onChangeEnrollment={onChangeRotation} enrollmentLabel="Change rotation…" />;
}
