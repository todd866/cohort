import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyQuestionImageOverlay,
  loadQuestionImageOverlaysFromDisk,
  type QuestionImageOverlayMap,
} from './image-overlay';
import { DEFAULT_QUESTION_BANK_DIR, loadQuestionBankFromDisk } from './load';

const HAS_QUESTION_BANK = existsSync(DEFAULT_QUESTION_BANK_DIR);

const overlays: QuestionImageOverlayMap = {
  'bank:cah:test:v1': {
    imageUrl: '/figures/cah/learning/test.svg',
    imageCaption: 'A focused teaching diagram.',
  },
};

describe('applyQuestionImageOverlay', () => {
  it('adds md3-owned visual teaching to a matching image-free question', () => {
    expect(applyQuestionImageOverlay({ id: 'bank:cah:test:v1' }, overlays)).toEqual({
      id: 'bank:cah:test:v1',
      imageUrl: '/figures/cah/learning/test.svg',
      imageCaption: 'A focused teaching diagram.',
    });
  });

  it('never overwrites an image authored in the canonical question bank', () => {
    const question = {
      id: 'bank:cah:test:v1',
      imageUrl: '/figures/canonical.svg',
      imageCaption: 'Canonical caption.',
    };

    expect(applyQuestionImageOverlay(question, overlays)).toBe(question);
  });

  it('leaves unrelated questions unchanged', () => {
    const question = { id: 'bank:cah:other:v1' };
    expect(applyQuestionImageOverlay(question, overlays)).toBe(question);
  });

  it.skipIf(!HAS_QUESTION_BANK)('enriches the expanded Duchenne contrast question at the disk-loader boundary', () => {
    const loaded = loadQuestionBankFromDisk();
    const question = loaded.questions.find(
      (candidate) =>
        candidate.id === 'bank:cah:flow-volume-loop-patterns-duchenne:v1',
    );

    expect(loaded.errors).toEqual([]);
    expect(question).toMatchObject({
      imageUrl: '/figures/cah/learning/flow-volume-loop-patterns.svg',
    });
    expect(question?.imageCaption).toMatch(/Duchenne respiratory muscle weakness/);
  }, 15_000);
});

describe('loadQuestionImageOverlaysFromDisk', () => {
  it('returns a deterministic empty fallback when the private overlay is absent', () => {
    expect(loadQuestionImageOverlaysFromDisk('/definitely/missing/md3-question-overlay.json')).toEqual({});
  });

  it('loads a valid overlay from an explicit path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-question-overlay-'));
    const overlayPath = path.join(root, 'overlay.json');
    try {
      fs.writeFileSync(overlayPath, `${JSON.stringify(overlays)}\n`);
      expect(loadQuestionImageOverlaysFromDisk(overlayPath)).toEqual(overlays);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a present overlay is malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-question-overlay-'));
    const overlayPath = path.join(root, 'overlay.json');
    try {
      fs.writeFileSync(overlayPath, '{"question":{"imageUrl":42}}\n');
      expect(() => loadQuestionImageOverlaysFromDisk(overlayPath)).toThrow(/Invalid question image overlay/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
