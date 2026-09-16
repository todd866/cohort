/**
 * Cheap, KaTeX-free detection of whether card text contains math.
 *
 * Kept in its own module (separate from render-math.ts) so components can
 * eagerly check for math on the review critical path WITHOUT statically
 * importing KaTeX (~75KB gz) into the initial bundle. Only the lazy
 * <MathHtml> leaf imports the KaTeX-backed renderer, so KaTeX is code-split
 * out of First Load JS and fetched only when a card actually contains math.
 */
export function containsMath(text: string): boolean {
  if (!text) return false;
  if (/\$[^$]+\$/.test(text)) return true;
  // Check for common medical shortcuts that would be converted
  return /(?:PaCO2|PaO2|FiO2|SpO2|SaO2|EtCO2|HCO3-|CO2(?!\$)|(?<!\w)O2(?!\d))/.test(text);
}
