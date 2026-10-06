/** Closed public transport vocabulary; admission and exact bytes are checked server-side. */
export const ANATOMY_SOURCE_FIGURES = [
  'humerus', 'radius-ulna', 'hand', 'carpal-tunnel', 'femur', 'tibia-fibula',
  'foot', 'heart-valves', 'lungs', 'kidney', 'hip-bone',
] as const;
export type AnatomySourceFigureId = typeof ANATOMY_SOURCE_FIGURES[number];
export const ANATOMY_FOCUS_TARGETS = {
  'heart-valves-focus': ['tricuspid', 'mitral', 'aortic', 'pulmonary'],
  'lungs-focus': ['right-middle-lobe', 'left-cardiac-notch', 'trachea'],
  'hip-bone-focus': ['acetabulum', 'obturator-foramen', 'iliac-fossa'],
  'carpal-tunnel-focus': ['median-nerve', 'flexor-retinaculum', 'trapezium', 'trapezoid', 'capitate', 'hamate'],
} as const;
export type AnatomyFocusFigureId = keyof typeof ANATOMY_FOCUS_TARGETS;
export function isAnatomyFocusFigureId(value: unknown): value is AnatomyFocusFigureId {
  return typeof value === 'string' && Object.hasOwn(ANATOMY_FOCUS_TARGETS, value);
}
export type AnatomyFigureId = 'abducens-local' | AnatomySourceFigureId | AnatomyFocusFigureId;
export type AnatomyFigureTarget = 'lateral-rectus' | 'abducens' | 'optic-nerve' | 'overview' | (typeof ANATOMY_FOCUS_TARGETS)[AnatomyFocusFigureId][number];
export function isAnatomySourceFigureId(value: unknown): value is AnatomySourceFigureId {
  return typeof value === 'string' && ANATOMY_SOURCE_FIGURES.some(id => id === value);
}
/** Labelled overview plates are supplementary only: never reveal a prompt's answer. */
export function isAnatomyFigureSelection(figureId: unknown, target: unknown, role: unknown): boolean {
  if (role !== 'prompt' && role !== 'supplementary') return false;
  if (isAnatomyFocusFigureId(figureId)) return (ANATOMY_FOCUS_TARGETS[figureId] as readonly string[]).includes(String(target));
  if (figureId === 'abducens-local') return ['lateral-rectus', 'abducens', 'optic-nerve'].includes(String(target));
  return isAnatomySourceFigureId(figureId) && target === 'overview' && role === 'supplementary';
}
