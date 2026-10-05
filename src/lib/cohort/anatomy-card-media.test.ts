import { describe, expect, it } from 'vitest';
import { anatomyCardMediaForStableId, REVIEWED_ANATOMY_MEDIA_STABLE_IDS } from './anatomy-card-media';

describe('reviewed anatomy card media registry', () => {
  it.each([
    ['cohort:anatomy:c-ccf1f2fc532f:v1', 'lateral-rectus'],
    ['cohort:anatomy:c-bf7970a915a8:v1', 'lateral-rectus'],
    ['cohort:anatomy:c-db24b4cc28af:v1', 'abducens'],
    ['cohort:anatomy:c-6b181def3d6b:v1', 'abducens'],
    ['cohort:anatomy:c-b268867d622e:v1', 'optic-nerve'],
    ['cohort:anatomy:c-ff128ba9fed0:v1', 'optic-nerve'],
  ])('points the visual card %s at its reviewed structure', (id, target) => {
    expect(anatomyCardMediaForStableId(id)?.target).toBe(target);
  });

  it('maps only the eight explicitly reviewed ocular anatomy cards', () => {
    expect(REVIEWED_ANATOMY_MEDIA_STABLE_IDS).toEqual([
      'cohort:anatomy:c-dd0bcce3d72d:v1',
      'cohort:anatomy:c-8dab68bbf8d1:v1',
      'cohort:anatomy:c-ccf1f2fc532f:v1',
      'cohort:anatomy:c-bf7970a915a8:v1',
      'cohort:anatomy:c-db24b4cc28af:v1',
      'cohort:anatomy:c-6b181def3d6b:v1',
      'cohort:anatomy:c-b268867d622e:v1',
      'cohort:anatomy:c-ff128ba9fed0:v1',
    ]);
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-dd0bcce3d72d:v1')?.figureId).toBe('abducens-local');
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-000000000000:v1')).toBeUndefined();
    expect(anatomyCardMediaForStableId('cohort:anatomy:c-dd0bcce3d72d:v1')?.preAnswerAlt).not.toMatch(/CN ?VI|sixth nerve/i);
  });
});
