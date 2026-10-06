import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { ANATOMY_FOCUS_TARGETS } from '@/lib/cohort/anatomy-figure-catalogue';
import { anatomyFocusSvg, focusFigureSpecificationHash, type FocusFigure } from './anatomy-focus-figure.server';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');
function figure(over: Partial<FocusFigure> = {}): FocusFigure {
  const base: FocusFigure = {
    id: 'heart-valves-focus', file: 'heart-valves-focus.png', sha256: digest, width: 1000, height: 800,
    orientation: 'anterior view', sourceUrl: 'https://example.org/anatomy', sourceSha256: 'a'.repeat(64),
    attribution: 'Open anatomy contributors', licence: 'CC-BY-3.0',
    targets: Object.fromEntries((ANATOMY_FOCUS_TARGETS['heart-valves-focus'] as readonly string[]).map((id, index) => [id, { label: id.replace('-', ' '), anchor: [0.2 + index * 0.1, 0.3] as [number, number], marker: [0.7, 0.2 + index * 0.1] as [number, number] }])),
    review: { status: 'accepted', reviewer: 'reviewer', claims: ['labels checked'], specificationSha256: '' },
  };
  const merged = { ...base, ...over, review: { ...base.review, ...(over.review ?? {}) } };
  merged.review.specificationSha256 = focusFigureSpecificationHash(merged);
  return merged;
}
const read = (file: string) => file === 'heart-valves-focus.png' ? bytes : new Uint8Array();

describe('anatomyFocusSvg', () => {
  it('serves a reviewed prompt and answer while masking the prompt label', () => {
    const f = figure();
    const prompt = anatomyFocusSvg(f.id, 'tricuspid', 'prompt', { entries: [f], read });
    const answer = anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [f], read });
    expect(prompt).toContain('<title>Structure A</title>'); expect(prompt).not.toContain('tricuspid</title>');
    expect(answer).toContain('<title>tricuspid</title>'); expect(answer).toContain('A: tricuspid</text>'); expect(answer).toContain('data:image/png;base64');
  });
  it('rejects a changed base image even when the specification review is valid', () => {
    const f = figure(); expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [f], read: () => new Uint8Array([9]) })).toBeNull();
    const changed = new Uint8Array([9]); const changedDigest = createHash('sha256').update(changed).digest('hex');
    const rebound = figure(); rebound.sha256 = changedDigest;
    expect(anatomyFocusSvg(rebound.id, 'tricuspid', 'answer', { entries: [rebound], read: () => changed })).toBeNull();
  });
  it.each([
    ['label', (f: FocusFigure) => { f.targets.tricuspid.label = 'changed'; }],
    ['coordinates', (f: FocusFigure) => { f.targets.tricuspid.anchor = [0.99, 0.99]; }],
    ['orientation', (f: FocusFigure) => { f.orientation = 'posterior view'; }],
    ['dimensions', (f: FocusFigure) => { f.width = 1200; }],
    ['source metadata', (f: FocusFigure) => { f.sourceUrl = 'https://example.org/changed'; }],
  ])('rejects a %s change after review', (_name, mutate) => {
    const f = figure(); mutate(f); expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [f], read })).toBeNull();
  });
  it('rejects pending, duplicate, malformed path, and unknown target entries', () => {
    const pending = figure({ review: { status: 'pending', reviewer: 'reviewer', claims: ['x'], specificationSha256: '' } });
    expect(anatomyFocusSvg('heart-valves-focus', 'tricuspid', 'answer', { entries: [pending], read })).toBeNull();
    const f = figure(); expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [f, figure()], read })).toBeNull();
    expect(anatomyFocusSvg('heart-valves-focus', 'unknown', 'answer', { entries: [f], read })).toBeNull();
    expect(anatomyFocusSvg('heart-valves-focus', 'tricuspid', 'answer', { entries: [figure({ file: '../bad.png' })], read })).toBeNull();
  });
  it('rejects missing or duplicated target specifications', () => {
    const f = figure(); const missing = figure(); delete missing.targets.mitral;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [missing], read })).toBeNull();
    const duplicate = figure(); duplicate.targets.extra = duplicate.targets.tricuspid;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [duplicate], read })).toBeNull();
  });
  it('returns null for malformed runtime review and target values', () => {
    const f = figure();
    const malformedReview = figure(); (malformedReview as any).review.reviewer = null;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [malformedReview], read })).toBeNull();
    const nullTargets = figure(); (nullTargets as any).targets = null;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [nullTargets], read })).toBeNull();
    const missingAnchor = figure(); (missingAnchor.targets.tricuspid as any).anchor = null;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [missingAnchor], read })).toBeNull();
    const nullEntry = figure(); (nullEntry.targets as any).mitral = null;
    expect(anatomyFocusSvg(f.id, 'tricuspid', 'answer', { entries: [nullEntry], read })).toBeNull();
  });
  it('rejects malformed manifest containers and members without throwing', () => {
    for (const entries of [{}, [null], [42], ['bad'], [figure(), null]]) {
      expect(anatomyFocusSvg('heart-valves-focus', 'tricuspid', 'answer', {
        entries: entries as unknown as FocusFigure[], read,
      })).toBeNull();
    }
  });
});
