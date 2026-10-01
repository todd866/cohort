import { expect, it } from 'vitest';
import { imageAlternativeTeachingFingerprint as fingerprint } from './image-alternative-fingerprint';

it('includes the displayed scalar answer when backs is empty', () => {
  const source = { type: 'card' as const, front: 'An inherited mechanism', back: 'recessive', backs: [], context: 'Explanation' };
  expect(fingerprint(source)).toBe(fingerprint({ ...source, backs: null }));
  expect(fingerprint(source)).not.toBe(fingerprint({ ...source, back: 'dominant' }));
});
it('pins every displayed cloze answer, stem and context', () => {
  const source = { type: 'card' as const, front: 'A and B', back: 'A', backs: ['A', 'B'], context: 'Explanation' };
  expect(fingerprint(source)).not.toBe(fingerprint({ ...source, backs: ['A', 'C'] }));
  expect(fingerprint(source)).not.toBe(fingerprint({ ...source, front: 'C and D' }));
  expect(fingerprint(source)).not.toBe(fingerprint({ ...source, context: 'Different mechanism' }));
});
it('pins the correct MCQ answer independently from display order', () => {
  const source = { type: 'question' as const, stem: 'Mechanism?', options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }] };
  expect(fingerprint(source)).toBe(fingerprint({ ...source, options: [...source.options].reverse() }));
  expect(fingerprint(source)).not.toBe(fingerprint({ ...source, options: [{ text: 'A', isCorrect: false }, { text: 'B', isCorrect: true }] }));
  expect(fingerprint({ type: 'question', stem: source.stem })).toBeNull();
});
