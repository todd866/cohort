/** Mask reviewed annotation labels without changing the underlying anatomy pixels. */
export const ANATOMY_PROMPT_TARGETS = ['lateral-rectus', 'abducens', 'optic-nerve'] as const;
export type AnatomyPromptTarget = typeof ANATOMY_PROMPT_TARGETS[number];
const GROUPS: Record<AnatomyPromptTarget, string> = {
  'lateral-rectus': 'lr-label', abducens: 'vi-label', 'optic-nerve': 'optic-label',
};
export function isAnatomyPromptTarget(value: unknown): value is AnatomyPromptTarget {
  return typeof value === 'string' && ANATOMY_PROMPT_TARGETS.some(target => target === value);
}
/** Input must first pass the exact-byte original illustration admission gate. */
export function anatomyPromptSvg(reviewedSvg: string, target: AnatomyPromptTarget): string | null {
  let count = 0;
  const output = reviewedSvg.replace(/<g id="label-([^"]+)"[^>]*>[\s\S]*?<\/g>/g, (group, id: string) => {
    count++;
    if (id !== GROUPS[target]) return '';
    return group.replace(/data-target-region="[^"]+"/, 'data-target-region="A"')
      .replace(/(<text\b[^>]*>)[\s\S]*?(<\/text>)/g, '$1A$2');
  }).replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '<title>Right eye: structure A</title>')
    .replace(/<desc\b[^>]*>[\s\S]*?<\/desc>/g, '<desc>Oblique superior view of the right eye. A marks the structure in the question.</desc>');
  return count === 3 && output.includes('data-target-region="A"') ? output : null;
}
