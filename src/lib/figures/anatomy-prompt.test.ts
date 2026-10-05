import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { anatomyPromptSvg, ANATOMY_PROMPT_TARGETS, isAnatomyPromptTarget } from './anatomy-prompt';
import { isReviewedLocalAnatomyBytesAllowed } from './open-figure-delivery';
const source = readFileSync('open-content/anatomy-scaffolds/abducens-local/served.svg', 'utf8');
describe('anatomy prompt annotations', () => {
  it.each(ANATOMY_PROMPT_TARGETS)('conceals labels while retaining reviewed anatomy and the %s endpoint', target => {
    expect(isReviewedLocalAnatomyBytesAllowed(source)).toBe(true);
    const prompt = anatomyPromptSvg(source, target)!;
    expect(prompt).not.toBeNull();
    expect(prompt.match(/<image\b[^>]+>/g)).toEqual(source.match(/<image\b[^>]+>/g));
    expect(prompt.match(/<polyline\b[^>]+>/g)).toHaveLength(1);
    const labels = [...prompt.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1]);
    expect(labels).toContain('A');
    expect(labels.join(' ')).not.toMatch(/lateral rectus|CN VI|optic nerve/i);
    expect(prompt).toContain('MIT');
  });
  it('fails closed for a changed annotation layout', () => {
    expect(anatomyPromptSvg('<svg />', 'abducens')).toBeNull();
  });
  it.each(['../private', 'other', null])('rejects unknown target %s', value => {
    expect(isAnatomyPromptTarget(value)).toBe(false);
  });
});
