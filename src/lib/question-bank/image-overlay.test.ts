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
    imageRole: 'prompt',
  },
};

describe('applyQuestionImageOverlay', () => {
  it('adds md3-owned visual teaching to a matching image-free question', () => {
    expect(applyQuestionImageOverlay({ id: 'bank:cah:test:v1' }, overlays)).toEqual({
      id: 'bank:cah:test:v1',
      imageUrl: '/figures/cah/learning/test.svg',
      imageCaption: 'A focused teaching diagram.',
      imageRole: 'prompt',
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

  it('never attaches a withdrawn figure, even from a matching overlay entry', () => {
    const question = { id: 'bank:cah:withdrawn:v1' };
    const withdrawn: QuestionImageOverlayMap = {
      'bank:cah:withdrawn:v1': {
        imageUrl: '/figures/cah/learning/flow-volume-loop-patterns.svg',
        imageCaption: 'A withdrawn schematic.',
      },
    };
    expect(applyQuestionImageOverlay(question, withdrawn)).toBe(question);
  });

  it.skipIf(!HAS_QUESTION_BANK)('enriches a bank question from the committed overlay at the disk-loader boundary', () => {
    const loaded = loadQuestionBankFromDisk();
    const byId = (id: string) => loaded.questions.find((candidate) => candidate.id === id);

    expect(loaded.errors).toEqual([]);
    expect(byId('bank:cah:perthes-disease-age-group:v1')?.imageUrl)
      .toBe('/figures/restricted/fcbc37627043dbc4d670a15ca47f93e0bf6f6e0e419460687a0151cd5ff42944.png');
    // The expanded Duchenne contrast stem wore the flow-volume schematic until it
    // was withdrawn on 2026-09-30; the question itself stays and serves text-only.
    const duchenne = byId('bank:cah:flow-volume-loop-patterns-duchenne:v1');
    expect(duchenne).toBeDefined();
    expect(duchenne?.imageUrl ?? null).toBeNull();
    expect(duchenne?.imageCaption ?? null).toBeNull();
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

  it('drops an entry that names a withdrawn figure instead of loading it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-question-overlay-'));
    const overlayPath = path.join(root, 'overlay.json');
    try {
      fs.writeFileSync(overlayPath, JSON.stringify({
        ...overlays,
        'bank:cah:withdrawn:v1': {
          imageUrl: '/figures/cah/msk/salter-harris-ii-schematic.svg',
          imageCaption: 'A withdrawn schematic.',
        },
      }));
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

  it('rejects an unsupported question image role', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-question-overlay-'));
    const overlayPath = path.join(root, 'overlay.json');
    try {
      fs.writeFileSync(overlayPath, JSON.stringify({
        question: {
          imageUrl: '/figures/restricted/x.png',
          imageCaption: 'Finding',
          imageRole: 'decoration',
        },
      }));
      expect(() => loadQuestionImageOverlaysFromDisk(overlayPath)).toThrow(/Invalid question image overlay/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
