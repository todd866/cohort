export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true'], [contenteditable='plaintext-only']"));
}

/**
 * Enter and Space already activate native/ARIA controls. Global review
 * shortcuts must defer to that behavior or keyboard users can focus an option,
 * press Enter, and accidentally trigger the page-level "skip" action instead.
 */
export function isInteractiveActivationTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest([
    'button',
    'a[href]',
    'summary',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="menuitem"]',
  ].join(', ')));
}

/** Home-row twins of the number keys, so review works right-hand only
 *  (owner, 30 Oct 2026). Apostrophe is the fifth MCQ option. */
const HOME_ROW_NUMBERS: Record<string, number> = { j: 1, k: 2, l: 3, ';': 4, "'": 5 };

/** The number a review shortcut key stands for: 1-9 or its home-row twin, else NaN. */
export function shortcutNumber(key: string): number {
  if (/^[1-9]$/.test(key)) return Number(key);
  return HOME_ROW_NUMBERS[key.toLowerCase()] ?? Number.NaN;
}
