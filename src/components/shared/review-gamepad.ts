import type { ReviewShortcutContext } from '@/components/review/ReviewKeyboardHelp';

/** Standard-layout face and shoulder buttons used in review routing. */
export type GamepadFace = 'bottom' | 'right' | 'left' | 'top';

export type GamepadButton =
  | GamepadFace
  | 'l1'
  | 'r1'
  | 'select'
  | 'start'
  | 'dpad-up'
  | 'dpad-down'
  | 'dpad-left'
  | 'dpad-right';

/** Standard Gamepad API indices when `gamepad.mapping === 'standard'`. */
export const STANDARD_GAMEPAD_BUTTON_INDEX: Record<GamepadButton, number> = {
  bottom: 0,
  right: 1,
  left: 2,
  top: 3,
  l1: 4,
  r1: 5,
  select: 8,
  start: 9,
  'dpad-up': 12,
  'dpad-down': 13,
  'dpad-left': 14,
  'dpad-right': 15,
};

export const GAMEPAD_RIGHT_STICK_Y_AXIS = 3;
export const GAMEPAD_STICK_DEAD_ZONE = 0.2;

export type GamepadAction =
  | { type: 'reveal' }
  | { type: 'reveal-all' }
  | { type: 'grade'; quality: 1 | 2 | 3 | 4 }
  | { type: 'continue' }
  | { type: 'mcq-skip' }
  | { type: 'mcq-nav'; direction: 'up' | 'down' }
  | { type: 'mcq-pick' }
  | { type: 'mcq-prime' }
  | { type: 'prev-item' }
  | { type: 'next-item' }
  | { type: 'open-shortcuts' }
  | { type: 'open-flag' };

export function gamepadButtonFromIndex(index: number): GamepadButton | null {
  for (const [button, mapped] of Object.entries(STANDARD_GAMEPAD_BUTTON_INDEX) as [GamepadButton, number][]) {
    if (mapped === index) return button;
  }
  return null;
}

function gradeContext(context: ReviewShortcutContext): boolean {
  return context === 'card-grade-required'
    || context === 'card-grade'
    || context === 'mcq-grade'
    || context === 'mcq-confidence'
    || context === 'video-rate';
}

function normalizedContext(context: ReviewShortcutContext): ReviewShortcutContext {
  if (context === 'card-grade') return 'card-grade-required';
  if (context === 'mcq-confidence') return 'mcq-grade';
  return context;
}

export function gamepadActionFor(
  context: ReviewShortcutContext,
  button: GamepadButton,
  opts?: { mcqHighlighted: boolean },
): GamepadAction | null {
  const ctx = normalizedContext(context);
  switch (button) {
    case 'l1':
      return { type: 'prev-item' };
    case 'r1':
      return { type: 'next-item' };
    case 'start':
      return { type: 'open-shortcuts' };
    case 'select':
      return { type: 'open-flag' };
    default:
      break;
  }

  if (gradeContext(ctx) && (button === 'left' || button === 'top' || button === 'bottom' || button === 'right')) {
    const quality = ({ left: 1, top: 2, bottom: 3, right: 4 } as const)[button];
    return { type: 'grade', quality };
  }

  switch (ctx) {
    case 'card-reveal':
      if (button === 'bottom') return { type: 'reveal' };
      if (button === 'top') return { type: 'reveal-all' };
      return null;
    case 'mcq-select':
      if (button === 'dpad-up') return { type: 'mcq-nav', direction: 'up' };
      if (button === 'dpad-down') return { type: 'mcq-nav', direction: 'down' };
      if (button === 'top') return { type: 'mcq-skip' };
      if (button === 'bottom') {
        return opts?.mcqHighlighted ? { type: 'mcq-pick' } : { type: 'mcq-prime' };
      }
      return null;
    case 'mcq-continue':
    case 'video-continue':
      if (button === 'bottom') return { type: 'continue' };
      return null;
    default:
      return null;
  }
}

export function confidenceToPadFace(confidence: number): GamepadFace | null {
  switch (confidence) {
    case 1: return 'left';
    case 2: return 'top';
    case 3: return 'bottom';
    case 4: return 'right';
    default: return null;
  }
}

export type PadShortcutGlyph = GamepadFace | 'l1' | 'r1' | 'select' | 'start' | GamepadFace[];

/** Pad equivalents for shortcut-help rows (keyboard strings from reviewShortcutsFor). */
export function padGlyphsForShortcutKeys(keys: string): PadShortcutGlyph | null {
  if (keys === 'Space / Enter' || keys === 'Continue') return 'bottom';
  if (keys === 'A') return 'top';
  if (keys === 'F') return 'select';
  if (keys === '?') return 'start';
  if (keys === 'Z / Left') return 'l1';
  if (keys === 'Shift+Z / Right') return 'r1';
  if (keys === '1–4 · J K L ;') return ['left', 'top', 'bottom', 'right'];
  if (keys === "1–5 · J K L ; '") return null;
  if (keys === 'B' || keys === 'Esc') return null;
  return null;
}

export function wrapMcqHighlightIndex(current: number | null, direction: 'up' | 'down', optionCount: number): number {
  if (optionCount <= 0) return 0;
  if (current === null) return 0;
  const next = direction === 'down' ? current + 1 : current - 1;
  return ((next % optionCount) + optionCount) % optionCount;
}