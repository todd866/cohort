/**
 * Normalizes common MDX escape patterns that can accidentally end up inside
 * string literals (e.g. in <MCQ options={[{ text: "Hb {'<'}70" }]} />).
 *
 * Handles three patterns:
 * 1. JSX expression escapes: {'<'} and {'>'} -> < and >
 * 2. Backslash escapes from MDX: \< and \> -> < and >
 *
 * In rendered MDX, `{'<'}` is a valid expression. In a quoted string, it's
 * literal text and should display as "<". Similarly, `\<` is used in MDX
 * source to prevent `<` from being interpreted as a JSX tag opener.
 */
export function normalizeAngleBracketEscapes(text: string): string {
  if (!text) return text;
  return text
    .replace(/\{\s*['"]\s*([<>])\s*['"]\s*\}/g, '$1')
    .replace(/\\([<>])/g, '$1');
}

