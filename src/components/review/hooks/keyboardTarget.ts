export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
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
