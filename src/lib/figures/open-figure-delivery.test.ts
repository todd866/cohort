import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OPEN_CONTENT_MEDIA_DIR,
  isManifestManagedFigureAllowed,
  openFigureResponse,
  isReviewedLocalAnatomyBytesAllowed,
  readOpenFigure,
  readOpenFigureFrom,
} from './open-figure-delivery';
import { WITHDRAWN_FIGURE_KEYS } from './withdrawn-figures';

/** The 55 agent-drawn Step 1 boards withdrawn on 2026-09-30; their files stay in the corpus. */
const WITHDRAWN_STEP1_FILENAMES = [...WITHDRAWN_FIGURE_KEYS]
  .filter((key) => key.startsWith('/figures/usmle/step1/'))
  .map((key) => key.slice('/figures/usmle/step1/'.length))
  .sort();

/**
 * Every `/figures/*` request rewrites into this logic, so it is the rights
 * boundary for app-origin figure delivery: only admitted CC BY Step 1 assets
 * and MIT originals are served, everything else gets the uniform private 404.
 */
describe('readOpenFigure', () => {
  it.each(WITHDRAWN_STEP1_FILENAMES)('denies the withdrawn Step 1 board %s on every host', (filename) => {
    for (const hostname of ['md3.info', 'cohort.md', undefined]) {
      expect(readOpenFigure(['usmle', 'step1', filename], { hostname, today: '2026-08-14' })).toBeNull();
    }
  });

  it('resolves from the open-content corpus, which is what a FOSS clone ships', () => {
    // `public/figures` is a forbidden prefix in the distribution policy (it holds
    // 623 rights-managed files), so the exported artifact carries these SVGs only
    // under open-content/usmle/step1/media. Without that fallback every figure
    // 404s in a fresh clone even though the questions reference them.
    expect(readOpenFigureFrom(OPEN_CONTENT_MEDIA_DIR, 'ecg-case-2w7m4q.svg')).toContain('<svg');
    expect(readOpenFigure(
      ['usmle', 'step1', 'ecg-case-2w7m4q.svg'],
      { hostname: 'cohort.md', today: '2026-08-14' },
    )).toContain('<svg');
  });

  it.each([
    ['a rights-managed namespace', ['anking', 'note-media.jpg']],
    ['a clinical photo', ['cah', 'clinical-photo.png']],
    ['a sibling usmle namespace', ['usmle', 'step2', 'x.svg']],
    ['a traversal attempt', ['usmle', 'step1', '..', '..', 'cah', 'x.svg']],
    ['an encoded traversal', ['usmle', 'step1', '%2e%2e', 'cah', 'x.svg']],
    ['a nested path', ['usmle', 'step1', 'nested', 'x.svg']],
    ['a non-svg in the open namespace', ['usmle', 'step1', 'leak.png']],
    ['an absent asset in the open namespace', ['usmle', 'step1', 'not-real-v1.svg']],
    ['no segments', []],
  ])('denies %s', (_label, segments) => {
    expect(readOpenFigure(segments)).toBeNull();
  });

  it('denies undefined segments', () => {
    expect(readOpenFigure(undefined)).toBeNull();
  });

  it('serves a manifest-managed ECG only on cohort.md with exact reviewed bytes', () => {
    const segments = ['usmle', 'step1', 'ecg-case-2w7m4q.svg'];
    expect(readOpenFigure(segments, {
      hostname: 'cohort.md',
      today: '2026-08-14',
    })).toContain('<svg');
    expect(readOpenFigure(segments, {
      hostname: 'md3.info',
      today: '2026-08-14',
    })).toBeNull();
    expect(readOpenFigure(segments, {
      hostname: 'attacker.example',
      today: '2026-08-14',
    })).toBeNull();
  });

  it('rejects unmanifested opaque case names and byte drift', () => {
    expect(readOpenFigure(
      ['usmle', 'step1', 'ecg-case-aaaaaa.svg'],
      { hostname: 'cohort.md', today: '2026-08-14' },
    )).toBeNull();

    const reviewed = readOpenFigureFrom(OPEN_CONTENT_MEDIA_DIR, 'ecg-case-2w7m4q.svg');
    expect(reviewed).not.toBeNull();
    expect(isManifestManagedFigureAllowed(
      'ecg-case-2w7m4q.svg',
      `${reviewed}\n<!-- drift -->`,
      { hostname: 'cohort.md', today: '2026-08-14' },
    )).toBe(false);
  });

  it('does not infer admission for any future unmanifested filename', () => {
    for (const filename of [
      'future-trace-v1.svg',
      'cxr-pneumothorax-v1.svg',
      'paeds-derm-rash-v1.svg',
    ]) {
      expect(readOpenFigure(
        ['usmle', 'step1', filename],
        { hostname: 'cohort.md', today: '2026-08-14' },
      ), filename).toBeNull();
    }
  });

  it('admits every canonical media SVG by manifest review, except exactly the withdrawn boards', () => {
    const rejected = readdirSync(OPEN_CONTENT_MEDIA_DIR)
      .filter((filename) => filename.endsWith('.svg'))
      .filter((filename) => readOpenFigure(
        ['usmle', 'step1', filename],
        { hostname: 'cohort.md', today: '2026-08-14' },
      ) === null)
      .sort();

    expect(rejected).toEqual(WITHDRAWN_STEP1_FILENAMES);
  });
});

describe('reviewed local anatomy figure', () => {
  it('serves the exact reviewed SVG and rejects byte drift', async () => {
    const response = openFigureResponse(['anatomy', 'abducens-local.svg'], true);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('abducens-local-labels');
    const head = openFigureResponse(['anatomy', 'abducens-local.svg'], false);
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('private, no-store');
    expect(await head.text()).toBe('');
    expect(isReviewedLocalAnatomyBytesAllowed('tampered')).toBe(false);
  });

  it('rejects traversal and sibling paths', () => {
    expect(openFigureResponse(['anatomy', '..', 'anking', 'x.svg'], true).status).toBe(404);
    expect(openFigureResponse(['anatomy', 'other.svg'], true).status).toBe(404);
  });
});

describe('openFigureResponse', () => {
  const withdrawnBoard = ['usmle', 'step1', 'adrenal-zones-v1.svg'];

  it.each(['md3.info', 'cohort.md'])('withdraws an exact superseded original on %s', async (hostname) => {
    const response = openFigureResponse(['originals', 'gowers-sign-standing-sequence.png'], true, { hostname });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('');
  });

  it('withdraws originals for HEAD as well', async () => {
    const response = openFigureResponse(['originals', 'phenylalanine-tyrosine-pathway.png'], false);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it.each([
    { segments: ['originals', 'unreviewed.png'] },
    { segments: ['originals', '%6eeonatal-scalp-comparison.png'] },
    { segments: ['originals', '..', 'restricted', 'old.png'] },
    { segments: ['originals', 'nested', 'gowers-sign-standing-sequence.png'] },
    { segments: ['restricted', 'gowers-sign-standing-sequence.png'] },
  ])('retains private 404 for non-admitted original path $segments', ({ segments }) => {
    const response = openFigureResponse(segments, true);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each(['md3.info', 'cohort.md'])('answers a withdrawn Step 1 board with the uniform private 404 on %s', async (hostname) => {
    for (const withBody of [true, false]) {
      const response = openFigureResponse(withdrawnBoard, withBody, { hostname, today: '2026-08-14' });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.text()).toBe('');
    }
  });

  it('omits the body for HEAD on an admitted figure while keeping the headers', async () => {
    const response = openFigureResponse(
      ['usmle', 'step1', 'ecg-case-2w7m4q.svg'],
      false,
      { hostname: 'cohort.md', today: '2026-08-14' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(await response.text()).toBe('');
  });

  it('returns the uniform private 404 for a blocked path, with no public caching', async () => {
    const response = openFigureResponse(['anking', 'note-media.jpg'], true);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(await response.text()).toBe('');
  });

  it('returns a private 404 for a Cohort-only visual on md3.info', async () => {
    const response = openFigureResponse(
      ['usmle', 'step1', 'ecg-case-2w7m4q.svg'],
      true,
      { hostname: 'md3.info', today: '2026-08-14' },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('revalidates manifest-managed clinical bytes on every request', async () => {
    const response = openFigureResponse(
      ['usmle', 'step1', 'ecg-case-2w7m4q.svg'],
      true,
      { hostname: 'cohort.md', today: '2026-08-14' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });
});
