/**
 * Area key helpers with no taxonomy data, so client code (the Exam gaps form)
 * can use them without bundling the blueprints.
 */
export const CUSTOM_AREA_PREFIX = 'custom:';

/** Letters, digits, spaces and , . ' & / - only; must start with a letter or digit; ≤ 60 chars. */
export const CUSTOM_AREA_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ,.'&/-]{0,59}$/;

export function isCustomArea(key: string): boolean {
  return key.startsWith(CUSTOM_AREA_PREFIX);
}

export function customAreaKey(label: string): string {
  return `${CUSTOM_AREA_PREFIX}${label}`;
}

/** A stored custom key is valid only if its label passes the same strict check. */
export function isValidCustomKey(key: string): boolean {
  return isCustomArea(key) && CUSTOM_AREA_LABEL.test(key.slice(CUSTOM_AREA_PREFIX.length));
}
